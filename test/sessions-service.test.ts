import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, withSessionsMode, type Settings } from "../src/settings.js";
import type { SessionEntry } from "../src/sessions/registry.js";
import { assertNotLiveSession, createSessions, type SessionsDeps } from "../src/sessions/service.js";

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

function setup(settings: Settings) {
  const deps: SessionsDeps = {
    self: () => ({ repoKey: "/a/.git", sessionId: "me" }),
    settings: () => settings,
    listLive: () => [entry("me", "/a/.git"), entry("same-repo", "/a/.git", { branch: "feat" }), entry("elsewhere", "/b/.git")],
    describe: (e) => (e.sessionId === "same-repo" ? { title: "Auth refactor", lastActive: "2026-10-01T11:00:00.000Z" } : {}),
    askFork: vi.fn(async (target) => ({ agent: target.agent, answer: "We renamed it.", sessionId: "fork-1", durationMs: 5 })),
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
