import { describe, expect, it, vi } from "vitest";
import { diagnose, formatChecks, type DoctorDeps } from "../src/doctor.js";
import { DEFAULT_SETTINGS, withMessagesEnabled, withSessionsMode } from "../src/settings.js";
import { AdvisorError } from "../src/types.js";

const allInstalled = [
  { agent: "claude", installed: true, version: "2.1.0" },
  { agent: "codex", installed: true, version: "0.162.1" },
  { agent: "grok", installed: true, version: "1.0.56" },
  { agent: "agy", installed: true, version: "1.3.4" },
] as const;

function deps(overrides: Partial<DoctorDeps> = {}): DoctorDeps {
  return {
    nodeVersion: "v22.12.0",
    agents: allInstalled,
    isRegistered: vi.fn(async () => true),
    loadSettings: () => DEFAULT_SETTINGS,
    hasMessageHook: () => true,
    agyContainment: vi.fn(async () => {}),
    ...overrides,
  };
}

const failures = (checks: Awaited<ReturnType<typeof diagnose>>) => checks.filter((c) => c.status === "fail");

describe("diagnose", () => {
  it("passes a healthy setup", async () => {
    const checks = await diagnose(deps());
    expect(failures(checks)).toEqual([]);
    expect(checks.map((c) => c.label)).toEqual(
      expect.arrayContaining(["node v22.12.0", "claude 2.1.0", "codex registered", "agy is read-only"]),
    );
  });

  it("fails on an old node and says what to do", async () => {
    const [node] = await diagnose(deps({ nodeVersion: "v20.11.0" }));
    expect(node).toMatchObject({ status: "fail", fix: expect.stringMatching(/Node 22/) });
  });

  it("warns about a host left unregistered, and fails only when no host is registered", async () => {
    const one = await diagnose(deps({ isRegistered: async (agent) => agent !== "codex" }));
    expect(failures(one)).toEqual([]);
    expect(one.find((c) => c.label === "codex not registered")).toMatchObject({ status: "warn", fix: expect.stringMatching(/consult-mcp@latest install/) });
    const none = await diagnose(deps({ isRegistered: async () => false }));
    expect(failures(none).map((c) => c.label)).toEqual(["claude not registered", "codex not registered", "grok not registered"]);
  });

  it("checks message hooks only for registered hosts", async () => {
    const on = withMessagesEnabled(withSessionsMode(DEFAULT_SETTINGS, "repo"), true);
    const hasMessageHook = vi.fn(() => true);
    await diagnose(deps({ loadSettings: () => on, hasMessageHook, isRegistered: async (agent) => agent !== "grok" }));
    expect(hasMessageHook.mock.calls.map((c) => c[0])).toEqual(["claude", "codex"]);
  });

  it("skips hosts that are not installed and fails only when no advisor is", async () => {
    const isRegistered = vi.fn(async () => true);
    const some = await diagnose(deps({ agents: [{ agent: "codex", installed: true, version: "1" }, { agent: "grok", installed: false }], isRegistered }));
    expect(failures(some)).toEqual([]);
    expect(isRegistered).toHaveBeenCalledWith("codex");
    expect(isRegistered).not.toHaveBeenCalledWith("grok");
    const none = await diagnose(deps({ agents: allInstalled.map((a) => ({ agent: a.agent, installed: false })) }));
    expect(failures(none).map((c) => c.label)).toEqual(["no agent CLI installed"]);
  });

  it("reports agy's containment problem as a warning, since the other advisors still work", async () => {
    const checks = await diagnose(deps({ agyContainment: async () => { throw new AdvisorError("toolPermission is always-proceed"); } }));
    expect(checks.find((c) => c.label === "agy is not read-only")).toMatchObject({ status: "warn", detail: expect.stringMatching(/always-proceed/) });
  });

  it("fails on an invalid settings file", async () => {
    const checks = await diagnose(deps({ loadSettings: () => { throw new Error("settings.json is not valid JSON"); } }));
    expect(failures(checks).map((c) => c.label)).toEqual(["settings file invalid"]);
  });

  it("checks message hooks only when messages are on", async () => {
    const on = withMessagesEnabled(withSessionsMode(DEFAULT_SETTINGS, "repo"), true);
    const hasMessageHook = vi.fn((agent: string) => agent !== "grok");
    const checks = await diagnose(deps({ loadSettings: () => on, hasMessageHook }));
    expect(failures(checks)).toEqual([expect.objectContaining({ label: "grok message hook missing" })]);
    const offHook = vi.fn(() => false);
    expect(failures(await diagnose(deps({ hasMessageHook: offHook })))).toEqual([]);
    expect(offHook).not.toHaveBeenCalled();
  });

  it("on Windows, warns that live sessions are off instead of checking hooks", async () => {
    const on = withMessagesEnabled(withSessionsMode(DEFAULT_SETTINGS, "repo"), true);
    const hasMessageHook = vi.fn(() => false);
    const checks = await diagnose(deps({ loadSettings: () => on, hasMessageHook, sessionsSupported: false }));
    expect(failures(checks)).toEqual([]);
    expect(checks.some((c) => c.status === "warn" && /off on this platform/.test(c.label))).toBe(true);
    expect(hasMessageHook).not.toHaveBeenCalled();
  });

  it("with ping, asks every installed advisor and reports who answered", async () => {
    const ping = vi.fn(async (agent: string) => {
      if (agent === "grok") throw new AdvisorError("grok exited with code 1: not logged in");
      return { agent: agent as "codex", answer: "OK", sessionId: "s", model: "m1", durationMs: 1200 };
    });
    const checks = await diagnose(deps({ ping }));
    expect(ping).toHaveBeenCalledTimes(4);
    expect(checks.find((c) => c.label === "codex answered")).toMatchObject({ status: "ok", detail: "m1, 1.2s" });
    expect(checks.find((c) => c.label === "grok did not answer")).toMatchObject({ status: "fail", detail: expect.stringMatching(/not logged in/) });
  });

  it("does not ping agy when its containment check failed", async () => {
    const ping = vi.fn(async () => ({ agent: "codex" as const, answer: "OK", sessionId: "s", durationMs: 1 }));
    await diagnose(deps({ ping, agyContainment: async () => { throw new AdvisorError("nope"); } }));
    expect(ping).not.toHaveBeenCalledWith("agy");
  });
});

describe("formatChecks", () => {
  it("prints one line per check with its fix, and a summary", () => {
    const out = formatChecks([
      { status: "ok", label: "node v22.1.0" },
      { status: "fail", label: "codex not registered", fix: "run `consult install`" },
    ]);
    expect(out).toContain("✓ node v22.1.0");
    expect(out).toContain("✗ codex not registered");
    expect(out).toContain("→ run `consult install`");
    expect(out).toMatch(/1 problem/);
  });

  it("shortens the home directory to ~, so the output can be pasted into a public bug report", () => {
    const out = formatChecks([{ status: "warn", label: "agy is not read-only", detail: "remove /Users/sam/.gemini/config/hooks.json" }], "/Users/sam");
    expect(out).toContain("remove ~/.gemini/config/hooks.json");
    expect(out).not.toContain("/Users/sam");
  });
});
