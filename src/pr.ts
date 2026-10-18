import { assertDirectory } from "./consult.js";
import { AdvisorError, type Runner } from "./types.js";

const GH_TIMEOUT_MS = 60_000;
/** A full commit id. Checked before it reaches git argv. */
const OID_PATTERN = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/** The commits a GitHub pull request compares, from `gh pr view`. */
export interface PullRequest {
  readonly number: number;
  /** The branch the PR merges into, e.g. "main". */
  readonly baseName: string;
  readonly baseOid: string;
  readonly headOid: string;
}

/** Looks up pull request `number` in the GitHub repository `cwd` belongs to, with the gh CLI. */
export async function viewPullRequest(run: Runner, cwd: string, number: number, signal?: AbortSignal): Promise<PullRequest> {
  if (!Number.isSafeInteger(number) || number <= 0) throw new AdvisorError(`pull request must be a positive number, got ${number}`);
  // A missing directory would otherwise surface as gh not being installed.
  assertDirectory(cwd);
  let res;
  try {
    res = await run("gh", ["pr", "view", String(number), "--json", "number,baseRefName,baseRefOid,headRefOid"], {
      cwd,
      signal,
      timeoutMs: GH_TIMEOUT_MS,
      maxOutputBytes: 1024 * 1024,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new AdvisorError(/not found on PATH/.test(message) ? "--pr needs the GitHub CLI (gh): install it from https://cli.github.com and run gh auth login" : message);
  }
  if (res.stopped) throw new AdvisorError(res.stopped === "aborted" ? "the review was cancelled" : `gh pr view ${number} did not finish (${res.stopped})`);
  if (res.code !== 0) throw new AdvisorError(`gh pr view ${number} failed: ${res.stderr.trim().slice(-500) || `exit code ${res.code}`}`);
  return parsePullRequest(res.stdout, number);
}

function parsePullRequest(stdout: string, number: number): PullRequest {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    throw new AdvisorError(`gh pr view ${number} returned output that isn't JSON`);
  }
  const { baseRefName, baseRefOid, headRefOid } = data ?? {};
  if (typeof baseRefName !== "string" || !baseRefName || typeof baseRefOid !== "string" || !OID_PATTERN.test(baseRefOid) || typeof headRefOid !== "string" || !OID_PATTERN.test(headRefOid)) {
    throw new AdvisorError(`gh pr view ${number} returned an unexpected pull request: ${stdout.trim().slice(0, 300)}`);
  }
  return { number, baseName: baseRefName, baseOid: baseRefOid, headOid: headRefOid };
}
