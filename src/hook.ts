import { frameMessages, type Message } from "./sessions/inbox.js";

const EVENTS = { userpromptsubmit: "UserPromptSubmit", posttooluse: "PostToolUse", stop: "Stop" } as const;
type EventName = (typeof EVENTS)[keyof typeof EVENTS];

const text = (value: unknown): string | undefined => (typeof value === "string" && value ? value : undefined);

function eventOf(payload: Record<string, unknown>): EventName | undefined {
  const raw = text(payload.hook_event_name) ?? text(payload.hookEventName);
  return raw ? EVENTS[raw.toLowerCase().replaceAll("_", "") as keyof typeof EVENTS] : undefined;
}

/**
 * What `consult hook` prints for one host hook event: this session's waiting messages in the host's reply
 * format, or nothing. Claude Code and Codex send snake_case fields; Grok sends camelCase ones as well.
 * Messages are claimed only once the event is known to be able to deliver them.
 */
export function hookReply(payload: unknown, claim: (sessionId: string) => readonly Message[]): string | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const event = payload as Record<string, unknown>;
  const name = eventOf(event);
  const sessionId = text(event.session_id) ?? text(event.sessionId);
  if (!name || !sessionId) return undefined;
  // A subagent shares its parent's session id; the message is for the main agent.
  if (event.agent_id || event.agentId) return undefined;
  const isGrok = "hookEventName" in event;
  // Grok discards what a prompt hook prints, so the message would be claimed and lost.
  if (name === "UserPromptSubmit" && isGrok) return undefined;
  // The agent is already continuing because of a stop hook; wait for the next event rather than extend the turn again.
  if (name === "Stop" && (event.stop_hook_active === true || event.stopHookActive === true)) return undefined;

  const messages = claim(sessionId);
  if (messages.length === 0) return undefined;
  const framed = frameMessages(messages);
  // Blocking the stop is how a finished turn reads the message. Grok has a form for it that is not shown as an error.
  if (name === "Stop" && !isGrok) return JSON.stringify({ decision: "block", reason: framed });
  return JSON.stringify({ hookSpecificOutput: { hookEventName: name, additionalContext: framed } });
}
