import { describe, expect, it, vi } from "vitest";
import {
  currentSession,
  detectHost,
  systemIdentityDeps,
  type IdentityDeps,
  type ProcessInfo,
} from "../src/sessions/identity.js";
import type { Runner } from "../src/types.js";

const ID = "11111111-2222-7333-8444-555555555555";
const LATER = "11111111-3333-7333-8444-555555555555";

function deps(overrides: Partial<IdentityDeps> = {}): IdentityDeps {
  return { env: {}, ancestors: async () => [], openFiles: async () => [], claudeTranscript: () => undefined, ...overrides };
}
const chain = (...names: string[]): readonly ProcessInfo[] => names.map((name, i) => ({ pid: 100 + i, name }));

describe("detectHost", () => {
  it("finds the nearest agent CLI among the server's ancestors", async () => {
    expect(await detectHost(deps({ ancestors: async () => chain("npm", "codex", "zsh") }))).toEqual({ agent: "codex", pid: 101 });
  });

  it("prefers the nearest agent over a CLAUDE_CODE_SESSION_ID inherited from an outer Claude Code shell", async () => {
    const d = deps({ env: { CLAUDE_CODE_SESSION_ID: "outer" }, ancestors: async () => chain("npm", "grok", "zsh", "claude") });
    expect(await detectHost(d)).toEqual({ agent: "grok", pid: 101 });
  });

  it("falls back to CLAUDE_CODE_SESSION_ID when claude runs under another process name", async () => {
    const d = deps({ env: { CLAUDE_CODE_SESSION_ID: ID }, ancestors: async () => chain("npm", "node") });
    expect(await detectHost(d)).toEqual({ agent: "claude" });
  });

  it("returns undefined when no agent started the server", async () => {
    expect(await detectHost(deps({ ancestors: async () => chain("zsh", "login") }))).toBeUndefined();
  });
});

describe("currentSession", () => {
  it("reads claude's session id from the environment and finds its transcript", async () => {
    const d = deps({ env: { CLAUDE_CODE_SESSION_ID: ID }, claudeTranscript: (id) => `/home/u/.claude/projects/p/${id}.jsonl` });
    expect(await currentSession({ agent: "claude" }, d)).toEqual({
      sessionId: ID,
      transcriptPath: `/home/u/.claude/projects/p/${ID}.jsonl`,
    });
  });

  it("rejects a claude session id that starts with a hyphen", async () => {
    expect(await currentSession({ agent: "claude" }, deps({ env: { CLAUDE_CODE_SESSION_ID: "-x" } }))).toBeUndefined();
  });

  it("rejects a claude session id that could escape the projects directory", async () => {
    expect(await currentSession({ agent: "claude" }, deps({ env: { CLAUDE_CODE_SESSION_ID: "../../etc" } }))).toBeUndefined();
  });

  it("takes codex's main thread from the rollout files its process holds open", async () => {
    const main = `/home/u/.codex/sessions/2026/10/01/rollout-2026-10-01T11-32-34-${ID}.jsonl`;
    const openFiles = vi.fn(async () => [
      "/dev/null",
      `/home/u/.codex/sessions/2026/10/01/rollout-2026-10-01T11-40-00-${LATER}.jsonl`,
      main,
    ]);
    expect(await currentSession({ agent: "codex", pid: 4242 }, deps({ openFiles }))).toEqual({ sessionId: ID, transcriptPath: main });
    expect(openFiles).toHaveBeenCalledWith(4242);
  });

  it("takes grok's session from the events file its process holds open", async () => {
    const openFiles = vi.fn(async () => ["/dev/null", `/home/u/.grok/sessions/%2Fhome%2Fu%2Fproj/${ID}/events.jsonl`]);
    expect(await currentSession({ agent: "grok", pid: 4242 }, deps({ openFiles }))).toEqual({
      sessionId: ID,
      transcriptPath: `/home/u/.grok/sessions/%2Fhome%2Fu%2Fproj/${ID}/events.jsonl`,
    });
    expect(openFiles).toHaveBeenCalledWith(4242);
  });

  it("takes grok's session when the same events file is open twice", async () => {
    const f = `/home/u/.grok/sessions/%2Fhome%2Fu%2Fproj/${ID}/events.jsonl`;
    expect(await currentSession({ agent: "grok", pid: 1 }, deps({ openFiles: async () => [f, f] }))).toEqual({ sessionId: ID, transcriptPath: f });
  });

  it("refuses grok when several different sessions are open", async () => {
    const openFiles = async () => [
      `/home/u/.grok/sessions/%2Fhome%2Fu%2Fproj/${ID}/events.jsonl`,
      `/home/u/.grok/sessions/%2Fhome%2Fu%2Fproj/${LATER}/events.jsonl`,
    ];
    expect(await currentSession({ agent: "grok", pid: 1 }, deps({ openFiles }))).toBeUndefined();
  });

  it("returns undefined for grok without an open session file or pid", async () => {
    expect(await currentSession({ agent: "grok", pid: 1 }, deps({ openFiles: async () => ["/home/u/.grok/logs/unified.jsonl"] }))).toBeUndefined();
    expect(await currentSession({ agent: "grok" }, deps())).toBeUndefined();
  });

  it("ignores a rollout-named file that is not under a sessions directory", async () => {
    const d = deps({ openFiles: async () => [`/tmp/rollout-2026-10-01T11-32-34-${ID}.jsonl`] });
    expect(await currentSession({ agent: "codex", pid: 7 }, d)).toBeUndefined();
  });

  it("returns undefined for codex before it opens a rollout", async () => {
    expect(await currentSession({ agent: "codex", pid: 1 }, deps({ openFiles: async () => ["/dev/null"] }))).toBeUndefined();
  });
});

describe("systemIdentityDeps", () => {
  it("walks ps output up the process tree", async () => {
    const table: Record<string, string> = {
      "50": "   40 npm exec consult-mcp@latest serve\n",
      "40": "   30 /usr/local/bin/codex\n",
      "30": "    1 -zsh\n",
    };
    const run = vi.fn<Runner>(async (_cmd, args) => {
      const out = table[args.at(-1)!];
      return { stdout: out ?? "", stderr: "", code: out ? 0 : 1 };
    });
    const { ancestors } = systemIdentityDeps(run, {}, "darwin", 50);
    expect(await ancestors()).toEqual([
      { pid: 50, name: "npm" },
      { pid: 40, name: "codex" },
      { pid: 30, name: "-zsh" },
    ]);
  });

  it("parses lsof's file names on macOS", async () => {
    const run = vi.fn<Runner>(async () => ({
      stdout: "p40\nfcwd\nn/home/u/repo\nf12\nn/home/u/.codex/sessions/r.jsonl\n",
      stderr: "",
      code: 0,
    }));
    expect(await systemIdentityDeps(run, {}, "darwin").openFiles(40)).toEqual(["/home/u/repo", "/home/u/.codex/sessions/r.jsonl"]);
    expect(run).toHaveBeenCalledWith("lsof", ["-p", "40", "-Fn"], expect.anything());
  });
});
