import { maxCommandLine } from "./platform.js";
import { AdvisorError, type Runner } from "./types.js";

/**
 * Diff bytes embedded in a review question; the advisor reads anything beyond that from the files. The question
 * reaches the CLI as one argument, so this leaves room in the platform's command-line limit for the rest of it.
 */
export const MAX_DIFF_BYTES = maxCommandLine() - 12_000;
const MAX_UNTRACKED = 50;
const MAX_STAT_CHARS = 4_000;
const GIT_OPTS = { timeoutMs: 30_000, maxOutputBytes: 64 * 1024 * 1024 };
/** git's well-known empty tree, to diff against in a repository without commits. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
/** A branch, tag or commit name. It reaches git argv, so it must not start with "-". */
const BASE_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._/@^~+-]*$/;

export interface Changes {
  readonly stat: string;
  readonly diff: string;
  readonly untracked: readonly string[];
  readonly truncated: boolean;
  /** The branch or commit the changes are compared with; absent for uncommitted changes against HEAD. */
  readonly base?: string;
}

/**
 * The changes to review in `cwd`: everything not yet committed (staged, unstaged and untracked files), or with
 * `base`, everything since the current branch left it. External diff and textconv drivers are off, so collecting
 * the diff runs nothing but git.
 */
export async function collectChanges(run: Runner, cwd: string, base?: string, signal?: AbortSignal): Promise<Changes> {
  const git = (...args: string[]) => run("git", ["--no-pager", "-c", "core.quotepath=off", ...args], { cwd, signal, ...GIT_OPTS });
  if (base !== undefined && !BASE_PATTERN.test(base)) throw new AdvisorError(`base must be a branch, tag or commit name, got ${JSON.stringify(base)}`);
  if ((await git("rev-parse", "--is-inside-work-tree")).code !== 0) throw new AdvisorError(`${cwd} is not inside a git repository`);
  let range: string[];
  if (base !== undefined) {
    if ((await git("rev-parse", "--verify", "--quiet", `${base}^{commit}`)).code !== 0) throw new AdvisorError(`unknown base: ${base}`);
    range = ["--merge-base", base];
  } else {
    range = [(await git("rev-parse", "--verify", "--quiet", "HEAD")).code === 0 ? "HEAD" : EMPTY_TREE];
  }
  const flags = ["--no-color", "--no-ext-diff", "--no-textconv"];
  const [diffRes, statRes, untrackedRes] = await Promise.all([
    git("diff", ...flags, ...range),
    git("diff", "--stat", ...flags, ...range),
    git("ls-files", "--others", "--exclude-standard"),
  ]);
  for (const res of [diffRes, statRes, untrackedRes]) {
    if (res.code !== 0) throw new AdvisorError(`git failed: ${res.stderr.trim().slice(-500)}`);
  }
  const untracked = untrackedRes.stdout.split("\n").filter(Boolean);
  if (!diffRes.stdout.trim() && untracked.length === 0) {
    throw new AdvisorError(base ? `no changes to review since ${base}` : "no changes to review: the working tree matches HEAD");
  }
  const bytes = Buffer.from(diffRes.stdout, "utf8");
  const truncated = bytes.length > MAX_DIFF_BYTES;
  return {
    stat: statRes.stdout.length > MAX_STAT_CHARS ? `${cutAtLine(statRes.stdout.slice(0, MAX_STAT_CHARS))}\n …` : statRes.stdout.trimEnd(),
    // Cut at a line end, so no multi-byte character or diff line is split.
    diff: truncated ? cutAtLine(bytes.subarray(0, MAX_DIFF_BYTES).toString("utf8")) : diffRes.stdout.trimEnd(),
    untracked,
    truncated,
    ...(base !== undefined ? { base } : {}),
  };
}

function cutAtLine(text: string): string {
  const end = text.lastIndexOf("\n");
  return end > 0 ? text.slice(0, end) : text;
}

const INSTRUCTIONS = `Find real problems: bugs, regressions, security issues, unhandled edge cases, and breaks in contracts with code elsewhere in the repository. Read the surrounding code to check how changed functions are called before you report something. Skip style and formatting nits.
For each finding give its severity (high, medium or low), the file:line, what goes wrong and in which concrete scenario, and a suggested fix. Put the most severe first.
If nothing is worth fixing, say so plainly instead of inventing findings.`;

/** The question each advisor gets for a review of `changes`. */
export function reviewQuestion(changes: Changes, focus?: string): string {
  const scope = changes.base ? `the changes on this branch since it branched from ${changes.base}, including uncommitted work` : "the uncommitted changes in this repository";
  const untracked = changes.untracked.length
    ? `\n\nNew untracked files, not in the diff (read them directly):\n${changes.untracked.slice(0, MAX_UNTRACKED).map((f) => `- ${f}`).join("\n")}${changes.untracked.length > MAX_UNTRACKED ? `\n- … and ${changes.untracked.length - MAX_UNTRACKED} more` : ""}`
    : "";
  const truncation = changes.truncated ? `\n\nThe diff below is truncated at about ${Math.round(MAX_DIFF_BYTES / 1000)} KB; read the changed files for the rest.` : "";
  return [
    `Review ${scope}.`,
    INSTRUCTIONS,
    ...(focus?.trim() ? [`Focus especially on: ${focus.trim()}`] : []),
    `Changed files:\n${changes.stat || "(none tracked)"}${untracked}${truncation}`,
    `\`\`\`diff\n${changes.diff}\n\`\`\``,
  ].join("\n\n");
}
