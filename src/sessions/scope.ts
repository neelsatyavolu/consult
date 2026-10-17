import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Scope } from "../settings.js";
import type { Runner } from "../types.js";

const GIT_TIMEOUT_MS = 5_000;

const real = (path: string) => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

async function git(run: Runner, cwd: string, args: readonly string[]): Promise<string> {
  const res = await run("git", args, { cwd, timeoutMs: GIT_TIMEOUT_MS }).catch(() => undefined);
  return res?.code === 0 ? res.stdout.trim() : "";
}

/** Identifies a repository by its git common dir, which all its worktrees share. Outside git: the directory. */
export async function repoKey(run: Runner, cwd: string): Promise<string> {
  const commonDir = await git(run, cwd, ["rev-parse", "--git-common-dir"]);
  return real(commonDir ? resolve(cwd, commonDir) : resolve(cwd));
}

export async function gitBranch(run: Runner, cwd: string): Promise<string | undefined> {
  const branch = await git(run, cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return branch && branch !== "HEAD" ? branch : undefined;
}

/** True when `child` is `parent` or a folder below it. */
function within(parent: string, child: string): boolean {
  const rel = relative(real(parent), real(child));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

interface Located {
  readonly repoKey: string;
  readonly cwd: string;
}

export function inScope(self: Located, other: Located, scope: Scope): boolean {
  if (scope === "machine" || self.repoKey === other.repoKey) return true;
  return scope === "tree" && (within(self.cwd, other.cwd) || within(other.cwd, self.cwd));
}
