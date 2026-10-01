import type { Runner } from "../types.js";
import { currentSession, detectHost, type IdentityDeps } from "./identity.js";
import { removeEntry, writeEntry, type SessionEntry } from "./registry.js";
import { gitBranch, repoKey } from "./scope.js";
import type { Self } from "./service.js";

export interface LiveOptions {
  readonly run: Runner;
  readonly dir: string;
  readonly cwd: string;
  /** This server's pid, which names its registry file. */
  readonly pid: number;
  readonly identity: IdentityDeps;
  readonly refreshMs: number;
  readonly signal: AbortSignal;
  readonly warn: (message: string) => void;
  readonly now?: () => Date;
}

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Registers the host session this server runs in, so other sessions can find it, and keeps the entry current:
 * codex opens its rollout only after the first turn, `/new` starts a new thread, and the branch can change.
 * The entry is removed when `signal` aborts. Readers prune the entries of servers that crash.
 */
export async function startLiveSession(opts: LiveOptions): Promise<{ readonly self: () => Self }> {
  const key = await repoKey(opts.run, opts.cwd);
  const startedAt = (opts.now ?? (() => new Date()))().toISOString();
  const host = await detectHost(opts.identity);
  let written: SessionEntry | undefined;

  async function refresh(): Promise<void> {
    if (!host || opts.signal.aborted) return;
    const [identity, branch] = await Promise.all([
      currentSession(host, opts.identity).catch(() => undefined),
      gitBranch(opts.run, opts.cwd),
    ]);
    if (!identity || opts.signal.aborted) return;
    const entry: SessionEntry = {
      version: 1,
      pid: opts.pid,
      agent: host.agent,
      sessionId: identity.sessionId,
      cwd: opts.cwd,
      repoKey: key,
      startedAt,
      ...(branch ? { branch } : {}),
      ...(identity.transcriptPath ? { transcriptPath: identity.transcriptPath } : {}),
    };
    if (written && JSON.stringify(written) === JSON.stringify(entry)) return;
    writeEntry(opts.dir, entry);
    written = entry;
  }

  const safeRefresh = () => refresh().catch((err) => opts.warn(`could not register this session: ${errorMessage(err)}`));
  await safeRefresh();
  const timer = setInterval(() => void safeRefresh(), opts.refreshMs);
  timer.unref();
  opts.signal.addEventListener(
    "abort",
    () => {
      clearInterval(timer);
      try {
        removeEntry(opts.dir, opts.pid);
      } catch (err) {
        opts.warn(`could not remove this session's registry entry: ${errorMessage(err)}`);
      }
    },
    { once: true },
  );
  return { self: () => ({ repoKey: key, ...(written ? { sessionId: written.sessionId } : {}) }) };
}
