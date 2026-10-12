import type { SessionToolDeps } from "../session-tools.js";
import { loadSettings, settingsPath, type Settings } from "../settings.js";
import type { Runner } from "../types.js";
import { codexIndexPath, describeSession } from "./describe.js";
import { systemIdentityDeps, type IdentityDeps } from "./identity.js";
import { claim, enqueue, inboxDir } from "./inbox.js";
import { startLiveSession } from "./live.js";
import { listLive, registryDir } from "./registry.js";
import { createSessions, type SessionsDeps } from "./service.js";

const REFRESH_MS = 15_000;
const CODEX_QUEUE_TIMEOUT_MS = 30_000;

export interface WireOptions {
  readonly run: Runner;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly pid: number;
  readonly signal: AbortSignal;
  readonly askFork: SessionsDeps["askFork"];
  readonly warn: (message: string) => void;
  readonly identity?: IdentityDeps;
  readonly refreshMs?: number;
}

/**
 * For `consult serve`: registers this session and returns the session tools when live sessions are on.
 * Without valid settings it returns nothing, so the rest of consult works as before.
 */
export async function sessionTools(opts: WireOptions): Promise<SessionToolDeps | undefined> {
  const path = settingsPath(opts.env);
  let settings: Settings;
  try {
    settings = loadSettings(path);
  } catch (err) {
    opts.warn(`${err instanceof Error ? err.message : String(err)}; live sessions are off for this session`);
    return undefined;
  }
  if (!settings.sessions.enabled) return undefined;

  try {
    const dir = registryDir(opts.env);
    const codexIndex = codexIndexPath(opts.env);
    const live = await startLiveSession({
      run: opts.run,
      dir,
      cwd: opts.cwd,
      pid: opts.pid,
      identity: opts.identity ?? systemIdentityDeps(opts.run, opts.env),
      refreshMs: opts.refreshMs ?? REFRESH_MS,
      signal: opts.signal,
      warn: opts.warn,
    });
    const inbox = inboxDir(opts.env);
    const { list, ask, send, receive } = createSessions({
      self: live.self,
      settings: () => loadSettings(path),
      listLive: () => listLive(dir),
      describe: (entry) => describeSession(entry, codexIndex),
      askFork: opts.askFork,
      enqueue: (recipient, from, text) => enqueue(inbox, recipient, from, text),
      claim: (sessionId) => claim(inbox, sessionId),
      promptCodex: async (target, framed) => {
        const res = await opts
          .run("codex", ["queue", "--thread", target.sessionId, "--message", framed], { cwd: target.cwd, timeoutMs: CODEX_QUEUE_TIMEOUT_MS })
          .catch(() => undefined);
        return res?.code === 0;
      },
    });
    return { list, ask, ...(settings.messages.enabled ? { messages: { send, receive } } : {}) };
  } catch (err) {
    opts.warn(`could not start live sessions: ${err instanceof Error ? err.message : String(err)}; live sessions are off for this session`);
    return undefined;
  }
}
