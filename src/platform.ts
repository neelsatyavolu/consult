import { accessSync, readFileSync } from "node:fs";
import { win32 } from "node:path";

/** Live sessions find sessions with ps and lsof, and deliver messages through POSIX shell hooks. */
export const sessionsSupported = (platform: NodeJS.Platform = process.platform): boolean => platform !== "win32";
export const SESSIONS_UNSUPPORTED = "live sessions and session messages need macOS or Linux; on Windows they stay off";

/**
 * The longest command line consult builds. Linux caps each argument at 128 KiB, which is what matters for the one
 * long argument (the question); Windows caps the whole command line at 32,767 characters.
 */
export function maxCommandLine(platform: NodeJS.Platform = process.platform): number {
  return platform === "win32" ? 30_000 : 120_000;
}

/** The size of a command line as the platform limits it: the whole line on Windows, the longest argument elsewhere. */
export function commandLineSize(command: string, args: readonly string[], platform: NodeJS.Platform = process.platform): number {
  if (platform === "win32") return [command, ...args].reduce((sum, a) => sum + a.length + 3, 0);
  return Math.max(0, ...args.map((a) => Buffer.byteLength(a, "utf8")));
}

export interface ShimTarget {
  readonly path: string;
  /** Whether the shim runs the target with node. */
  readonly node: boolean;
}

const DP0 = /^%~?dp0%?/i;

/**
 * What an npm or pnpm `.cmd` shim runs: the quoted `%dp0%\…` path on its last line that passes `%*` on.
 * Running that directly avoids cmd.exe, which would reinterpret `&`, `|`, `%` and newlines in a question.
 */
export function shimTarget(content: string, shimDir: string): ShimTarget | undefined {
  const line = content.split(/\r?\n/).findLast((l) => l.includes("%*"));
  if (!line) return undefined;
  const quoted = [...line.matchAll(/"([^"]*)"/g)].map((m) => m[1]!);
  const runner = quoted.some((q) => /^%_prog%$/i.test(q) || /node\.exe$/i.test(q)) || /(^|[\s(])node\s/i.test(line);
  const target = quoted.filter((q) => DP0.test(q) && !/node\.exe$/i.test(q)).at(-1);
  if (!target) return undefined;
  const path = win32.join(shimDir, target.replace(DP0, ""));
  return { path, node: runner && !/\.(exe|com)$/i.test(path) };
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
  if (!found) return { command, args };
  if (!/\.(cmd|bat)$/i.test(found)) return { command: found, args };
  const target = shimTarget(opts.read(found), win32.dirname(found));
  if (!target) throw new Error(`${found} is a batch file consult can't run without cmd.exe; install a build of ${command} that ships an .exe or an npm shim`);
  return target.node ? { command: opts.node, args: [target.path, ...args] } : { command: target.path, args };
}
