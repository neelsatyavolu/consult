import { accessSync, readFileSync } from "node:fs";
import { win32 } from "node:path";

/** Live sessions find sessions with ps and lsof, and deliver messages through POSIX shell hooks. */
export const sessionsSupported = (platform: NodeJS.Platform = process.platform): boolean => platform !== "win32";
export const SESSIONS_UNSUPPORTED = "live sessions and session messages need macOS or Linux; on Windows they stay off";

/**
 * The longest command line consult builds. Linux caps each argument at 128 KiB, which is what matters for the one
 * long argument (the question); macOS caps arguments and environment together at 1 MiB; Windows caps the whole
 * command line at 32,767 characters.
 */
export function maxCommandLine(platform: NodeJS.Platform = process.platform): number {
  if (platform === "win32") return 32_000;
  return platform === "darwin" ? 800_000 : 120_000;
}

/** Characters one argument takes in a Windows command line once libuv has quoted and escaped it. */
export function windowsArgLength(arg: string): number {
  if (!arg) return 2;
  if (!/[ \t"]/.test(arg)) return arg.length;
  let length = 2;
  let backslashes = 0;
  for (const ch of arg) {
    if (ch === "\\") {
      backslashes++;
    } else if (ch === '"') {
      // Backslashes before a quote are doubled, and the quote itself is escaped.
      length += backslashes * 2 + 2;
      backslashes = 0;
    } else {
      length += backslashes + ch.length;
      backslashes = 0;
    }
  }
  // Trailing backslashes are doubled so they don't escape the closing quote.
  return length + backslashes * 2;
}

/** The size of an argument as the platform limits it: escaped characters on Windows, UTF-8 bytes elsewhere. */
export function argSize(arg: string, platform: NodeJS.Platform = process.platform): number {
  return platform === "win32" ? windowsArgLength(arg) : Buffer.byteLength(arg, "utf8");
}

/** The size of a command line as the platform limits it: the whole line on Windows, the longest argument elsewhere. */
export function commandLineSize(command: string, args: readonly string[], platform: NodeJS.Platform = process.platform): number {
  if (platform === "win32") return [command, ...args].reduce((sum, a) => sum + windowsArgLength(a) + 1, 0);
  return Math.max(0, ...args.map((a) => argSize(a, platform)));
}

export interface ShimTarget {
  readonly path: string;
  /** Whether the shim runs the target with node. */
  readonly node: boolean;
  /** Node flags the shim passes before the script, from the script's shebang line. */
  readonly flags: readonly string[];
}

const DP0 = /^%~?dp0%?/i;
const NODE_PROG = /(^|\\)node(\.exe)?$/i;

/**
 * What an npm or pnpm `.cmd` shim runs: the quoted `%dp0%\…` path on its last line that passes `%*` on, and
 * whether node runs it. Running that directly avoids cmd.exe, which would reinterpret `&`, `|`, `%` and newlines
 * in a question. A script run by anything but node (sh, python) is not recognised.
 */
export function shimTarget(content: string, shimDir: string): ShimTarget | undefined {
  const line = content.split(/\r?\n/).findLast((l) => l.includes("%*"));
  if (!line) return undefined;
  const match = [...line.matchAll(/"(%~?dp0%?[^"]*)"/gi)].filter((m) => !/node\.exe$/i.test(m[1]!)).at(-1);
  if (!match) return undefined;
  const path = win32.join(shimDir, match[1]!.replace(DP0, ""));
  if (/\.(exe|com)$/i.test(path)) return { path, node: false, flags: [] };
  const before = line.slice(0, match.index);
  const prog = /"%_prog%"/i.exec(before);
  const runner = prog ?? [...before.matchAll(/"[^"]*node\.exe"|(?<=^|[\s(])node(?=\s)/gi)].at(-1);
  if (!runner) return undefined;
  if (prog) {
    // %_prog% is whatever the shim set it to; only node is run that way here.
    const progs = [...content.matchAll(/SET\s+"_prog=([^"]*)"/gi)].map((m) => m[1]!);
    if (progs.length === 0 || !progs.every((p) => NODE_PROG.test(p))) return undefined;
  }
  const flags = before.slice(runner.index + runner[0].length).trim().split(/\s+/).filter(Boolean);
  return { path, node: true, flags };
}

export interface SpawnTarget {
  readonly command: string;
  readonly args: readonly string[];
}

export interface ResolveOptions {
  readonly platform: NodeJS.Platform;
  readonly env: NodeJS.ProcessEnv;
  /** The node binary to run shimmed scripts with. */
  readonly node: string;
  readonly exists: (path: string) => boolean;
  readonly read: (path: string) => string;
}

const exists = (path: string) => {
  try {
    accessSync(path);
    return true;
  } catch {
    return false;
  }
};

const SYSTEM: ResolveOptions = {
  platform: process.platform,
  env: process.env,
  node: process.execPath,
  exists,
  read: (path) => readFileSync(path, "utf8"),
};

/** The file Windows would run for `command`, searching PATH with each PATHEXT extension the way cmd.exe does. */
export function findWindowsCommand(command: string, env: NodeJS.ProcessEnv, has: (path: string) => boolean): string | undefined {
  const exts = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  const names = win32.extname(command) ? [command, ...exts.map((e) => command + e)] : exts.map((e) => command + e);
  const dirs = /[\\/]/.test(command) ? [""] : (env.PATH ?? env.Path ?? "").split(";").filter(Boolean);
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = dir ? win32.join(dir, name) : name;
      if (has(candidate)) return candidate;
    }
  }
  return undefined;
}

/**
 * How to spawn `command` without a shell. Elsewhere that is the command itself. On Windows, npm installs CLIs as
 * `.cmd` shims, which Node can only start through cmd.exe, so consult runs what the shim points at instead.
 */
export function resolveForSpawn(command: string, args: readonly string[], opts: ResolveOptions = SYSTEM): SpawnTarget {
  if (opts.platform !== "win32") return { command, args };
  const found = findWindowsCommand(command, opts.env, opts.exists);
  // A bare name would make Windows look in the current directory first, which may be an untrusted repository.
  if (!found) throw new Error(`${command} CLI not found on PATH`);
  if (!/\.(cmd|bat)$/i.test(found)) return { command: found, args };
  const target = shimTarget(opts.read(found), win32.dirname(found));
  if (!target) throw new Error(`${found} is a batch file consult can't run without cmd.exe; install a build of ${command} that ships an .exe or an npm shim`);
  return target.node ? { command: opts.node, args: [...target.flags, target.path, ...args] } : { command: target.path, args };
}
