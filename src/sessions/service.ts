import type { ForkTarget } from "../consult.js";
import type { Settings } from "../settings.js";
import { AdvisorError, type AgentName, type AskResult, type Effort } from "../types.js";
import type { SessionDetails } from "./describe.js";
import type { SessionEntry } from "./registry.js";
import { inScope } from "./scope.js";

/** This server's own session: its repo, and its session id once known. */
export interface Self {
  readonly repoKey: string;
  readonly sessionId?: string;
}

/** What list_sessions shows about a session: metadata only. */
export interface SessionView {
  readonly session_id: string;
  readonly agent: AgentName;
  readonly cwd: string;
  readonly branch?: string;
  readonly title?: string;
  readonly started_at: string;
  readonly last_active?: string;
}

export interface SessionAnswer extends AskResult {
  /** Where the fork ran. A follow-up through ask_agent must use the same directory. */
  readonly cwd: string;
  /** The live session the fork was made from. */
  readonly source: string;
}

export interface SessionsDeps {
  readonly self: () => Self;
  /** Read on every call, so turning sessions off or narrowing the scope applies without a restart. */
  readonly settings: () => Settings;
  readonly listLive: () => readonly SessionEntry[];
  readonly describe: (entry: SessionEntry) => SessionDetails;
  readonly askFork: (target: ForkTarget, question: string, effort: Effort | undefined, signal?: AbortSignal) => Promise<AskResult>;
}

/** A live session is the user's own: resuming it in place would write its transcript. */
export function assertNotLiveSession(sessionId: string, live: readonly SessionEntry[]): void {
  if (live.some((e) => e.sessionId === sessionId)) {
    throw new AdvisorError(`session ${sessionId} is a live session; use ask_session to ask a read-only copy of it`);
  }
}

const MAX_BRANCH = 120;

function toView(entry: SessionEntry, details: SessionDetails): SessionView {
  return {
    session_id: entry.sessionId,
    agent: entry.agent,
    cwd: entry.cwd,
    ...(entry.branch ? { branch: entry.branch.slice(0, MAX_BRANCH) } : {}),
    ...(details.title ? { title: details.title } : {}),
    started_at: entry.startedAt,
    ...(details.lastActive ? { last_active: details.lastActive } : {}),
  };
}

export function createSessions(deps: SessionsDeps) {
  function visible(self: Self): readonly SessionEntry[] {
    const { sessions } = deps.settings();
    if (!sessions.enabled) throw new AdvisorError("live sessions are turned off; run `consult settings` to turn them on");
    return deps.listLive().filter((e) => e.sessionId !== self.sessionId && inScope(self, e, sessions.scope));
  }

  function list(): readonly SessionView[] {
    return visible(deps.self()).map((entry) => toView(entry, deps.describe(entry)));
  }

  async function ask(sessionId: string, question: string, effort: Effort | undefined, signal?: AbortSignal): Promise<SessionAnswer> {
    const self = deps.self();
    const target = visible(self).find((e) => e.sessionId === sessionId);
    if (!target) {
      throw new AdvisorError(
        sessionId === self.sessionId
          ? "that is your own session; ask a different one"
          : `no live session ${sessionId} in scope; call list_sessions to see the current ones`,
      );
    }
    const result = await deps.askFork({ agent: target.agent, sessionId: target.sessionId, cwd: target.cwd }, question, effort, signal);
    return { ...result, cwd: target.cwd, source: target.sessionId };
  }

  return { list, ask };
}
