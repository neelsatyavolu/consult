import { assertDirectory } from "./consult.js";
import { maxCommandLine } from "./platform.js";
import { AdvisorError, type Runner, type RunResult } from "./types.js";

/** Diff bytes collected at most; reviewQuestion cuts further so the whole question fits one command line. */
export const MAX_DIFF_BYTES = maxCommandLine();
/** Room left in the command line for the advisor briefing, CLI flags and agy's tool note. */
const PROMPT_RESERVE = 6_000;
const MAX_UNTRACKED = 50;
const MAX_STAT_CHARS = 4_000;
const GIT_TIMEOUT_MS = 60_000;
/** A branch, tag or commit name. It reaches git argv, so it must not start with "-". */
const BASE_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._/@^~+-]*$/;

export interface Changes {
  /** The repository's top-level directory. Paths in the diff are relative to it, and advisors run in it. */
  readonly root: string;
  readonly stat: string;
  readonly diff: string;
  readonly untracked: readonly string[];
  readonly truncated: boolean;
  /** The branch or commit the changes are compared with; absent for uncommitted changes against HEAD. */
  readonly base?: string;
}

const STOPPED: Record<NonNullable<RunResult["stopped"]>, string> = {
  timeout: `git took longer than ${GIT_TIMEOUT_MS / 1000}s`,
  aborted: "the review was cancelled",
  output_limit: "git produced too much output",
};

/**
 * The changes to review in the repository holding `cwd`: everything not yet committed (staged, unstaged and
 * untracked files), or with `base`, everything since the current branch left it. External diff, textconv and
 * fsmonitor commands are off, so collecting the diff runs nothing but git itself.
 */
export async function collectChanges(run: Runner, cwd: string, base?: string, signal?: AbortSignal): Promise<Changes> {
  if (base !== undefined && !BASE_PATTERN.test(base)) throw new AdvisorError(`base must be a branch, tag or commit name, got ${JSON.stringify(base)}`);
  assertDirectory(cwd);
  const git = async (dir: string, args: readonly string[], maxOutputBytes = 64 * 1024 * 1024) => {
    const res = await run("git", ["--no-pager", "-c", "core.quotepath=off", "-c", "core.fsmonitor=false", ...args], {
      cwd: dir,
      signal,
      timeoutMs: GIT_TIMEOUT_MS,
      maxOutputBytes,
    });
    if (res.stopped && res.stopped !== "output_limit") throw new AdvisorError(STOPPED[res.stopped]);
    return res;
  };
  const failed = (res: RunResult) => new AdvisorError(`git failed: ${res.stderr.trim().slice(-500) || `exit code ${res.code}`}`);

  const top = await git(cwd, ["rev-parse", "--show-toplevel"]);
  if (top.code !== 0) throw new AdvisorError(`${cwd} is not inside a git repository`);
  const root = top.stdout.trim();
  // Every diff runs from the top level, so the diff and the untracked list share one path base.
  const inRoot = (args: readonly string[], max?: number) => git(root, args, max);

  let ranges: readonly (readonly string[])[];
  if (base !== undefined) {
    if ((await inRoot(["rev-parse", "--verify", "--quiet", `${base}^{commit}`])).code !== 0) throw new AdvisorError(`unknown base: ${base}`);
    const mergeBase = await inRoot(["merge-base", base, "HEAD"]);
    if (mergeBase.code !== 0) throw new AdvisorError(`${base} and HEAD have no common ancestor`);
    ranges = [[mergeBase.stdout.trim()]];
  } else if ((await inRoot(["rev-parse", "--verify", "--quiet", "HEAD"])).code === 0) {
    ranges = [["HEAD"]];
  } else {
    // No commits yet: what is staged, then what changed since.
    ranges = [["--cached"], []];
  }
  const flags = ["--no-color", "--no-ext-diff", "--no-textconv"];
  const diffs = await Promise.all(ranges.map((r) => inRoot(["diff", ...flags, ...r], MAX_DIFF_BYTES + 1_000_000)));
  const stats = await Promise.all(ranges.map((r) => inRoot(["diff", "--stat", ...flags, ...r])));
  const untrackedRes = await inRoot(["ls-files", "--others", "--exclude-standard"]);
  for (const res of [...stats, untrackedRes]) if (res.code !== 0) throw failed(res);
  // A diff stopped for its size is kept: it is cut to size below anyway.
  for (const res of diffs) if (res.code !== 0 && res.stopped !== "output_limit") throw failed(res);

  const diff = diffs.map((d) => d.stdout).join("");
  const untracked = untrackedRes.stdout.split("\n").filter(Boolean);
  if (!diff.trim() && untracked.length === 0) {
    throw new AdvisorError(base ? `no changes to review since ${base}` : "no changes to review: the working tree matches HEAD");
  }
  const stat = stats.map((r) => r.stdout.trimEnd()).filter(Boolean).join("\n");
  const cut = cutToBytes(diff, MAX_DIFF_BYTES);
  return {
    root,
    stat: stat.length > MAX_STAT_CHARS ? `${cutAtLine(stat.slice(0, MAX_STAT_CHARS))}\n …` : stat,
    diff: cut.text,
    untracked,
    truncated: cut.truncated || diffs.some((d) => d.stopped === "output_limit"),
    ...(base !== undefined ? { base } : {}),
  };
}

function cutAtLine(text: string): string {
  const end = text.lastIndexOf("\n");
  return end > 0 ? text.slice(0, end) : text;
}

/** `text` cut to at most `max` UTF-8 bytes at a line end, so no character or diff line is split. */
function cutToBytes(text: string, max: number): { readonly text: string; readonly truncated: boolean } {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= max) return { text: text.trimEnd(), truncated: false };
  return { text: cutAtLine(bytes.subarray(0, Math.max(0, max)).toString("utf8")), truncated: true };
}

/** A code fence longer than any run of backticks in `text`, so a fence inside the diff can't close it. */
function fenceFor(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  return "`".repeat(Math.max(3, longest + 1));
}

const INSTRUCTIONS = `Find real problems: bugs, regressions, security issues, unhandled edge cases, and breaks in contracts with code elsewhere in the repository. Read the surrounding code to check how changed functions are called before you report something. Skip style and formatting nits.
For each finding give its severity (high, medium or low), the file:line, what goes wrong and in which concrete scenario, and a suggested fix. Put the most severe first.
If nothing is worth fixing, say so plainly instead of inventing findings.`;

/** The question each advisor gets for a review of `changes`. It fits one command line on this platform. */
export function reviewQuestion(changes: Changes, focus?: string): string {
  const scope = changes.base ? `the changes on this branch since it branched from ${changes.base}, including uncommitted work` : "the uncommitted changes in this repository";
  const shown = changes.untracked.slice(0, MAX_UNTRACKED);
  const more = changes.untracked.length - shown.length;
  const untracked = shown.length
    ? `\n\nNew untracked files, not in the diff (read them directly):\n${shown.map((f) => `- ${f}`).join("\n")}${more > 0 ? `\n- … and ${more} more` : ""}`
    : "";
  const head = [`Review ${scope}.`, INSTRUCTIONS, ...(focus?.trim() ? [`Focus especially on: ${focus.trim()}`] : [])].join("\n\n");
  const files = `Changed files (paths are relative to the repository root):\n${changes.stat || "(none tracked)"}${untracked}`;
  const note = (kb: number) => `\n\nThe diff below is cut at about ${kb} KB; read the changed files for the rest.`;
  const fixed = Buffer.byteLength(`${head}\n\n${files}${note(999)}\n\n`) + 2 * fenceFor(changes.diff).length + 16;
  const cut = cutToBytes(changes.diff, maxCommandLine() - PROMPT_RESERVE - fixed);
  const truncated = changes.truncated || cut.truncated;
  const fence = fenceFor(cut.text);
  return `${head}\n\n${files}${truncated ? note(Math.round(Buffer.byteLength(cut.text) / 1000)) : ""}\n\n${fence}diff\n${cut.text}\n${fence}`;
}
