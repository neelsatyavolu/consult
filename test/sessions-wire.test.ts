import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, saveSettings, settingsPath, withSessionsMode, type SessionsMode } from "../src/settings.js";
import type { IdentityDeps } from "../src/sessions/identity.js";
import { sessionTools, type WireOptions } from "../src/sessions/wire.js";
import type { Runner } from "../src/types.js";

const noGit: Runner = async () => ({ stdout: "", stderr: "not a git repository", code: 128 });
const claudeIn = (sessionId: string): IdentityDeps => ({
  env: { CLAUDE_CODE_SESSION_ID: sessionId },
  ancestors: async () => [{ pid: 2, name: "claude" }],
  openFiles: async () => [],
  claudeSessionOf: () => undefined,
  // Only sessions with a saved conversation are listed.
  claudeTranscript: (id) => `/home/u/.claude/projects/p/${id}.jsonl`,
});

function setup(mode: SessionsMode | "corrupt" | "missing") {
  const root = mkdtempSync(join(tmpdir(), "consult-wire-"));
  const env = { XDG_CONFIG_HOME: join(root, "config"), XDG_STATE_HOME: join(root, "state"), CODEX_HOME: join(root, "codex") };
  if (mode === "corrupt") {
    mkdirSync(dirname(settingsPath(env)), { recursive: true });
    writeFileSync(settingsPath(env), "{ broken");
  } else if (mode !== "missing") {
    saveSettings(settingsPath(env), withSessionsMode(DEFAULT_SETTINGS, mode));
  }
  return { root, env };
}

const options = (env: NodeJS.ProcessEnv, cwd: string, overrides: Partial<WireOptions> = {}): WireOptions => ({
  run: noGit,
  env,
  cwd,
  pid: process.pid,
  signal: new AbortController().signal,
  refreshMs: 60_000,
  askFork: vi.fn(),
  warn: vi.fn(),
  identity: claudeIn("me"),
  ...overrides,
});

describe("sessionTools (serve wiring)", () => {
  it("adds nothing when live sessions are off or were never configured", async () => {
    for (const mode of ["off", "missing"] as const) {
      const { root, env } = setup(mode);
      expect(await sessionTools(options(env, root))).toBeUndefined();
    }
  });

  it("warns and keeps consult running with sessions off when the settings file is corrupt", async () => {
    const { root, env } = setup("corrupt");
    const warn = vi.fn();
    expect(await sessionTools(options(env, root, { warn }))).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/live sessions are off/));
  });

  it("warns and keeps consult running when live-session startup throws", async () => {
    const { root, env } = setup("repo");
    const warn = vi.fn();
    const identity: IdentityDeps = { ...claudeIn("me"), ancestors: async () => Promise.reject(new Error("ps exploded")) };
    expect(await sessionTools(options(env, root, { warn, identity }))).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/could not start live sessions: ps exploded; live sessions are off for this session/));
  });

  it("lets two sessions in one repo find and ask each other", async () => {
    const { root, env } = setup("repo");
    const stopA = new AbortController();
    const stopB = new AbortController();
    const askFork = vi.fn(async () => ({ agent: "claude" as const, answer: "ok", sessionId: "fork", durationMs: 1 }));
    // Both pids are alive, so the registry keeps both entries.
    const a = await sessionTools(options(env, root, { pid: process.pid, signal: stopA.signal, identity: claudeIn("session-a") }));
    const b = await sessionTools(options(env, root, { pid: process.ppid, signal: stopB.signal, identity: claudeIn("session-b"), askFork }));
    expect(a!.list().map((s) => s.session_id)).toEqual(["session-b"]);
    expect(b!.list().map((s) => s.session_id)).toEqual(["session-a"]);

    await b!.ask("session-a", "What are you working on?", undefined);
    expect(askFork).toHaveBeenCalledWith({ agent: "claude", sessionId: "session-a", cwd: root }, "What are you working on?", undefined, undefined);

    stopA.abort();
    expect(b!.list()).toEqual([]);
    stopB.abort();
  });
});
