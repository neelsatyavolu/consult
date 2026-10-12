import type { ForkTarget } from "../consult.js";
import { messagesOn, type Settings } from "../settings.js";
import { AdvisorError, type AskResult, type Effort, type HostName } from "../types.js";
import type { SessionDetails } from "./describe.js";
import { frameMessages, type Message, type Sender } from "./inbox.js";
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
  readonly agent: HostName;
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
  readonly enqueue: (recipient: string, from: Sender, text: string) => Message;
  readonly claim: (sessionId: string) => readonly Message[];
  readonly now?: () => number;
}

export interface Sent {
  readonly messageId: string;
  readonly agent: HostName;
  readonly sessionId: string;
}

/** Bounds two agents that keep answering each other. */
export const MAX_SENDS_PER_HOUR = 10;
const HOUR_MS = 60 * 60 * 1000;

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

  function findTarget(self: Self, sessionId: string): SessionEntry {
    const target = visible(self).find((e) => e.sessionId === sessionId);
    if (!target) {
      throw new AdvisorError(
        sessionId === self.sessionId
          ? "that is your own session; ask a different one"
          : `no live session ${sessionId} in scope; call list_sessions to see the current ones`,
      );
    }
    return target;
  }

  async function ask(sessionId: string, question: string, effort: Effort | undefined, signal?: AbortSignal): Promise<SessionAnswer> {
    const target = findTarget(deps.self(), sessionId);
    const result = await deps.askFork({ agent: target.agent, sessionId: target.sessionId, cwd: target.cwd }, question, effort, signal);
    return { ...result, cwd: target.cwd, source: target.sessionId };
  }

  function assertMessagesOn(): void {
    if (!messagesOn(deps.settings())) {
      throw new AdvisorError("session messages are turned off; run `consult settings` to turn them on");
    }
  }

  let sends: ReadonlyMap<string, readonly number[]> = new Map();

  function send(sessionId: string, text: string): Sent {
    assertMessagesOn();
    const self = deps.self();
    const target = findTarget(self, sessionId);
    const me = deps.listLive().find((e) => e.sessionId === self.sessionId);
    if (!me) throw new AdvisorError("this session is not registered as a live session yet, so it cannot be named as the sender; try again in a moment");
    const now = (deps.now ?? Date.now)();
    const recent = (sends.get(sessionId) ?? []).filter((at) => now - at < HOUR_MS);
    if (recent.length >= MAX_SENDS_PER_HOUR) {
      throw new AdvisorError(`you have sent session ${sessionId} ${MAX_SENDS_PER_HOUR} messages in the last hour; wait before sending more`);
    }
    const from = { agent: me.agent, sessionId: me.sessionId, cwd: me.cwd, ...(me.branch ? { branch: me.branch.slice(0, MAX_BRANCH) } : {}) };
    const message = deps.enqueue(target.sessionId, from, text);
    sends = new Map([...sends, [sessionId, [...recent, now]]]);
    return { messageId: message.id, agent: target.agent, sessionId: target.sessionId };
  }

  /** Messages waiting for this session, framed for the agent. They are delivered once. */
  function receive(): string | undefined {
    const { sessionId } = deps.self();
    if (!sessionId || !messagesOn(deps.settings())) return undefined;
    const messages = deps.claim(sessionId);
    return messages.length > 0 ? frameMessages(messages) : undefined;
  }

  return { list, ask, send, receive };
}
