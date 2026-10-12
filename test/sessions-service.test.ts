import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, withMessagesEnabled, withSessionsMode, type Settings } from "../src/settings.js";
import type { SessionEntry } from "../src/sessions/registry.js";
import { assertNotLiveSession, createSessions, MAX_SENDS_PER_HOUR, type SessionsDeps } from "../src/sessions/service.js";

const entry = (sessionId: string, repoKey: string, overrides: Partial<SessionEntry> = {}): SessionEntry => ({
  version: 1,
  pid: 1,
  agent: "codex",
  sessionId,
  cwd: `/work/${sessionId}`,
  repoKey,
  startedAt: "2026-10-01T10:00:00.000Z",
  ...overrides,
});

function setup(settings: Settings, overrides: Partial<SessionsDeps> = {}) {
  const deps: SessionsDeps = {
    self: () => ({ repoKey: "/a/.git", sessionId: "me" }),
    settings: () => settings,
    listLive: () => [entry("me", "/a/.git"), entry("same-repo", "/a/.git", { branch: "feat" }), entry("elsewhere", "/b/.git")],
    describe: (e) => (e.sessionId === "same-repo" ? { title: "Auth refactor", lastActive: "2026-10-01T11:00:00.000Z" } : {}),
    askFork: vi.fn(async (target) => ({ agent: target.agent, answer: "We renamed it.", sessionId: "fork-1", durationMs: 5 })),
    enqueue: vi.fn((_recipient, from, text) => ({ version: 1 as const, id: "m-1", from, sentAt: "2026-10-12T10:00:00.000Z", text })),
    claim: vi.fn(() => []),
    ...overrides,
  };
  return { deps, sessions: createSessions(deps) };
}

describe("live sessions service", () => {
  it("lists other sessions in the same repo, with their details, in repo scope", () => {
    const { sessions } = setup(withSessionsMode(DEFAULT_SETTINGS, "repo"));
    expect(sessions.list()).toEqual([
      {
        session_id: "same-repo",
        agent: "codex",
        cwd: "/work/same-repo",
        branch: "feat",
        title: "Auth refactor",
        started_at: "2026-10-01T10:00:00.000Z",
        last_active: "2026-10-01T11:00:00.000Z",
      },
    ]);
  });

  it("lists every other session in machine scope", () => {
    const { sessions } = setup(withSessionsMode(DEFAULT_SETTINGS, "machine"));
    expect(sessions.list().map((s) => s.session_id)).toEqual(["same-repo", "elsewhere"]);
  });

  it("refuses to list or ask once live sessions are turned off, without a restart", async () => {
    const { sessions } = setup(DEFAULT_SETTINGS);
    expect(() => sessions.list()).toThrow(/turned off.*consult settings/);
    await expect(sessions.ask("same-repo", "q", undefined)).rejects.toThrow(/turned off/);
  });

  it("asks a fork of the target in the target's directory and says where to follow up", async () => {
    const { sessions, deps } = setup(withSessionsMode(DEFAULT_SETTINGS, "repo"));
    const answer = await sessions.ask("same-repo", "What did you rename?", "low");
    expect(deps.askFork).toHaveBeenCalledWith(
      { agent: "codex", sessionId: "same-repo", cwd: "/work/same-repo" },
      "What did you rename?",
      "low",
      undefined,
    );
    expect(answer).toMatchObject({ answer: "We renamed it.", sessionId: "fork-1", cwd: "/work/same-repo", source: "same-repo" });
  });

  it("refuses its own session, unknown sessions and sessions outside the scope", async () => {
    const { sessions } = setup(withSessionsMode(DEFAULT_SETTINGS, "repo"));
    await expect(sessions.ask("me", "q", undefined)).rejects.toThrow(/your own session/);
    await expect(sessions.ask("ghost", "q", undefined)).rejects.toThrow(/no live session ghost/);
    await expect(sessions.ask("elsewhere", "q", undefined)).rejects.toThrow(/no live session elsewhere/);
  });
});

describe("list view limits", () => {
  it("caps a branch name at 120 characters", () => {
    const long = "b".repeat(500);
    const { deps } = setup(withSessionsMode(DEFAULT_SETTINGS, "repo"));
    const sessions = createSessions({ ...deps, listLive: () => [entry("same-repo", "/a/.git", { branch: long })] });
    expect(sessions.list()[0]!.branch).toBe("b".repeat(120));
  });
});

describe("assertNotLiveSession", () => {
  const live = [entry("live-1", "/a/.git"), entry("live-2", "/a/.git")];

  it("refuses to resume a live session in place, pointing at ask_session", () => {
    expect(() => assertNotLiveSession("live-2", live)).toThrow(/live session.*ask_session/);
  });

  it("lets other session ids through", () => {
    expect(() => assertNotLiveSession("advisor-9", live)).not.toThrow();
  });
});

describe("session messages", () => {
  const on = withMessagesEnabled(withSessionsMode(DEFAULT_SETTINGS, "repo"), true);

  it("queues a message for a session in scope, naming this session as the sender", () => {
    const { sessions, deps } = setup(on);
    expect(sessions.send("same-repo", "main moved")).toEqual({ messageId: "m-1", agent: "codex", sessionId: "same-repo" });
    expect(deps.enqueue).toHaveBeenCalledWith("same-repo", { agent: "codex", sessionId: "me", cwd: "/work/me" }, "main moved");
  });

  it("refuses when messages or live sessions are off, and for sessions it cannot see", () => {
    expect(() => setup(withSessionsMode(DEFAULT_SETTINGS, "repo")).sessions.send("same-repo", "hi")).toThrow(/messages are turned off/);
    expect(() => setup(withMessagesEnabled(DEFAULT_SETTINGS, true)).sessions.send("same-repo", "hi")).toThrow(/turned off/);
    const { sessions, deps } = setup(on);
    expect(() => sessions.send("elsewhere", "hi")).toThrow(/no live session elsewhere in scope/);
    expect(() => sessions.send("me", "hi")).toThrow(/own session/);
    expect(deps.enqueue).not.toHaveBeenCalled();
  });

  it("refuses to send before this session is registered", () => {
    const { sessions } = setup(on, { self: () => ({ repoKey: "/a/.git" }) });
    expect(() => sessions.send("same-repo", "hi")).toThrow(/not registered/);
  });

  it("limits how many messages one session gets from this one per hour", () => {
    let now = 0;
    const { sessions } = setup(on, { now: () => now });
    for (let i = 0; i < MAX_SENDS_PER_HOUR; i++) sessions.send("same-repo", "again");
    expect(() => sessions.send("same-repo", "again")).toThrow(/in the last hour/);
    now = 60 * 60 * 1000 + 1;
    expect(sessions.send("same-repo", "later").messageId).toBe("m-1");
  });

  it("hands this session its waiting messages, framed, and nothing when messages are off", () => {
    const waiting = [{ version: 1 as const, id: "m-2", from: { agent: "grok" as const, sessionId: "same-repo", cwd: "/work/same-repo" }, sentAt: "2026-10-12T10:00:00.000Z", text: "thanks" }];
    const { sessions, deps } = setup(on, { claim: vi.fn(() => waiting) });
    expect(sessions.receive()).toMatch(/From the grok session same-repo[\s\S]*thanks/);
    expect(deps.claim).toHaveBeenCalledWith("me");
    const off = setup(withSessionsMode(DEFAULT_SETTINGS, "repo"), { claim: vi.fn(() => waiting) });
    expect(off.sessions.receive()).toBeUndefined();
    expect(off.deps.claim).not.toHaveBeenCalled();
  });
});
