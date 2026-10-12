import { describe, expect, it, vi } from "vitest";
import { hookReply } from "../src/hook.js";
import type { Message } from "../src/sessions/inbox.js";

const message: Message = {
  version: 1,
  id: "m-1",
  from: { agent: "claude", sessionId: "sender-1", cwd: "/work/app" },
  sentAt: "2026-10-12T10:00:00.000Z",
  text: "main moved",
};
const claimOne = () => vi.fn((_sessionId: string) => [message]);
const parse = (reply: string | undefined) => JSON.parse(reply ?? "null") as Record<string, any>;

describe("hookReply", () => {
  it("adds waiting messages as context after a tool call", () => {
    const claim = claimOne();
    const reply = parse(hookReply({ hook_event_name: "PostToolUse", session_id: "s-1" }, claim));
    expect(claim).toHaveBeenCalledWith("s-1");
    expect(reply.hookSpecificOutput.hookEventName).toBe("PostToolUse");
    expect(reply.hookSpecificOutput.additionalContext).toMatch(/main moved/);
  });

  it("adds them to a prompt in Claude Code and Codex", () => {
    const reply = parse(hookReply({ hook_event_name: "UserPromptSubmit", session_id: "s-1" }, claimOne()));
    expect(reply.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
  });

  it("blocks a stop so the finished turn reads them", () => {
    const reply = parse(hookReply({ hook_event_name: "Stop", session_id: "s-1", stop_hook_active: false }, claimOne()));
    expect(reply.decision).toBe("block");
    expect(reply.reason).toMatch(/main moved/);
  });

  it("uses Grok's camelCase fields and its feedback form for a stop", () => {
    const claim = claimOne();
    const reply = parse(hookReply({ hookEventName: "stop", hook_event_name: "Stop", sessionId: "g-1", stopHookActive: false }, claim));
    expect(claim).toHaveBeenCalledWith("g-1");
    expect(reply.hookSpecificOutput).toMatchObject({ hookEventName: "Stop" });
    expect(reply.decision).toBeUndefined();
  });

  it("leaves messages queued when the event could not deliver them", () => {
    const claim = claimOne();
    // Grok discards a prompt hook's output.
    expect(hookReply({ hookEventName: "user_prompt_submit", hook_event_name: "UserPromptSubmit", sessionId: "g-1" }, claim)).toBeUndefined();
    expect(hookReply({ hook_event_name: "Stop", session_id: "s-1", stop_hook_active: true }, claim)).toBeUndefined();
    expect(hookReply({ hook_event_name: "PostToolUse", session_id: "s-1", agent_id: "sub-1" }, claim)).toBeUndefined();
    expect(hookReply({ hook_event_name: "PreToolUse", session_id: "s-1" }, claim)).toBeUndefined();
    expect(hookReply({ hook_event_name: "PostToolUse" }, claim)).toBeUndefined();
    expect(hookReply("nonsense", claim)).toBeUndefined();
    expect(claim).not.toHaveBeenCalled();
  });

  it("prints nothing when no message is waiting", () => {
    expect(hookReply({ hook_event_name: "PostToolUse", session_id: "s-1" }, () => [])).toBeUndefined();
  });
});
