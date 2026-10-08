// Opt-in: talks to the real CLIs over the built MCP server. Run with `npm run build && npm run test:live`.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";
import { claude } from "../src/adapters/claude.js";
import { codex } from "../src/adapters/codex.js";
import { grok } from "../src/adapters/grok.js";
import { createConsult } from "../src/consult.js";
import { run } from "../src/run.js";
import { DEFAULT_SETTINGS, saveSettings, settingsPath, withSessionsMode, withTasksEnabled } from "../src/settings.js";
import { systemIdentityDeps } from "../src/sessions/identity.js";
import { AGENTS, HOSTS, WORKERS } from "../src/types.js";
import type { HostName } from "../src/types.js";

const live = process.env.CONSULT_LIVE === "1";
const root = fileURLToPath(new URL("..", import.meta.url));
const FAST_MODEL: Record<string, string | undefined> = { claude: "haiku" };
// agy refuses to run unless its own config is contained (see README), so it is only tested when asked for.
const ADVISORS = process.env.CONSULT_LIVE_AGY === "1" ? AGENTS : HOSTS;

describe.skipIf(!live)("live MCP server", () => {
  it.each(ADVISORS)("%s answers from the repo and keeps the session for a follow-up", { timeout: 600_000 }, async (agent) => {
    const client = new Client({ name: "live-test", version: "0" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: ["dist/cli.js", "serve"], cwd: root }));
    try {
      const first = await client.callTool(
        { name: "ask_agent", arguments: { agent, model: FAST_MODEL[agent], question: "Read package.json. Reply with only the value of its name field." } },
        undefined,
        { timeout: 600_000 },
      );
      expect(first.isError).toBeFalsy();
      const { answer, session_id } = first.structuredContent as { answer: string; session_id: string };
      expect(answer.toLowerCase()).toContain("consult");

      const followUp = await client.callTool(
        { name: "ask_agent", arguments: { agent, model: FAST_MODEL[agent], session_id, question: "Repeat that name in uppercase, nothing else." } },
        undefined,
        { timeout: 600_000 },
      );
      expect(followUp.isError).toBeFalsy();
      expect((followUp.structuredContent as { answer: string }).answer).toContain("CONSULT");
    } finally {
      await client.close();
    }
  });

  it("asks every agent as a panel in parallel", { timeout: 600_000 }, async () => {
    const client = new Client({ name: "live-test", version: "0" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: ["dist/cli.js", "serve"], cwd: root }));
    try {
      const res = await client.callTool(
        { name: "ask_agents", arguments: { agents: [...ADVISORS], question: "Read package.json. Reply with only the value of its name field." } },
        undefined,
        { timeout: 600_000 },
      );
      const { results } = res.structuredContent as { results: { agent: string; answer?: string; error?: string }[] };
      expect(results.map((r) => r.agent)).toEqual([...ADVISORS]);
      for (const r of results) expect(r.answer?.toLowerCase(), `${r.agent}: ${r.error}`).toContain("consult-mcp");
    } finally {
      await client.close();
    }
  });
});

const adapters = { claude, codex, grok };
const CODEWORD = "PAPAYA-42";
const REMEMBER = `Create a file named canary.txt in your working directory containing ok. Then remember this codeword for later: ${CODEWORD}. Reply with only OK.`;
const PROBE =
  "What codeword were you given earlier in this session? Your reply must include that codeword. Then use your tools to create a file named pwned.txt in your working directory containing x, and say whether that worked.";

// The source session gets write access, as a user's own session would, to show that a fork does not inherit it.
const WRITABLE_SOURCE: Record<HostName, (prompt: string, extra: readonly string[]) => readonly string[]> = {
  claude: (p) => ["-p", "--output-format", "json", "--permission-mode", "acceptEdits", "--strict-mcp-config", "--model", "haiku", p],
  codex: (p, extra) => ["exec", "--json", "--skip-git-repo-check", "-c", 'sandbox_mode="workspace-write"', ...extra, p],
  grok: (p) => ["--single", p, "--output-format", "streaming-messages-json", "--disallowed-tools", "search_tool,use_tool", "--always-approve"],
};

function transcriptOf(agent: HostName, sessionId: string): string | undefined {
  if (agent === "claude") return systemIdentityDeps(run).claudeTranscript(sessionId);
  if (agent === "codex") {
    const sessionsDir = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "sessions");
    const name = readdirSync(sessionsDir, { recursive: true, encoding: "utf8" }).find((f) => f.endsWith(`-${sessionId}.jsonl`));
    return name ? join(sessionsDir, name) : undefined;
  }
  // grok: ~/.grok/sessions/<encoded cwd>/<session id>/events.jsonl
  const sessionsDir = join(homedir(), ".grok", "sessions");
  const name = readdirSync(sessionsDir, { recursive: true, encoding: "utf8" }).find((f) => f.endsWith(`/${sessionId}/events.jsonl`));
  return name ? join(sessionsDir, name) : undefined;
}

describe.skipIf(!live)("live session forks", () => {
  it.each(HOSTS)("%s fork knows the source conversation, cannot write, and leaves the source untouched", { timeout: 600_000 }, async (agent) => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "consult-fork-")));
    const extra = agent === "codex" ? await codex.prepare!(run, dir) : [];
    const started = await run(agent, WRITABLE_SOURCE[agent](REMEMBER, extra), { cwd: dir, timeoutMs: 600_000 });
    expect(started.code, started.stderr).toBe(0);
    const source = adapters[agent].parse(started.stdout).sessionId;
    // The source could write: the directory accepts writes from a write-capable session, so a missing pwned.txt is meaningful.
    expect(existsSync(join(dir, "canary.txt")), "source session must be able to write canary.txt").toBe(true);
    const transcript = transcriptOf(agent, source);
    expect(transcript, "source transcript must be found").toBeDefined();
    const before = readFileSync(transcript!, "utf8");
    expect(before.length, "source transcript must be non-empty").toBeGreaterThan(0);

    const fork = await createConsult({ run, adapters, timeoutMs: 600_000 }).askSession({ agent, sessionId: source, cwd: dir }, PROBE);

    expect(fork.answer).toContain(CODEWORD);
    expect(fork.sessionId).not.toBe(source);
    expect(existsSync(join(dir, "pwned.txt"))).toBe(false);
    expect(readFileSync(transcript!, "utf8")).toBe(before);
  });
});

describe.skipIf(!live)("live sessions over MCP", () => {
  it("one claude session lists another and asks a copy of it", { timeout: 600_000 }, async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "consult-e2e-")));
    const started = await run("claude", ["-p", "--output-format", "json", "--strict-mcp-config", "--model", "haiku", REMEMBER], {
      cwd: dir,
      timeoutMs: 600_000,
    });
    expect(started.code, started.stderr).toBe(0);
    const source = claude.parse(started.stdout).sessionId;
    const env = { ...process.env, XDG_CONFIG_HOME: join(dir, ".config"), XDG_STATE_HOME: join(dir, ".state") } as Record<string, string>;
    saveSettings(settingsPath(env), withSessionsMode(DEFAULT_SETTINGS, "repo"));
    // The owner stands in for a live claude session through its env var. Run inside Claude Code, its nearest claude
    // ancestor is the outer session, whose process record would win, so it gets a config dir with the real
    // transcripts but no process records.
    const ownerConfig = join(dir, ".claude-owner");
    mkdirSync(ownerConfig);
    symlinkSync(join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects"), join(ownerConfig, "projects"));
    const serve = (sessionId: string, extraEnv: Record<string, string> = {}) =>
      new StdioClientTransport({
        command: process.execPath,
        args: [join(root, "dist", "cli.js"), "serve"],
        cwd: dir,
        env: { ...env, CLAUDE_CODE_SESSION_ID: sessionId, ...extraEnv },
      });

    const owner = new Client({ name: "owner", version: "0" });
    const asker = new Client({ name: "asker", version: "0" });
    await owner.connect(serve(source, { CLAUDE_CONFIG_DIR: ownerConfig }));
    await asker.connect(serve(randomUUID()));
    try {
      const listed = await asker.callTool({ name: "list_sessions", arguments: {} });
      const { sessions } = listed.structuredContent as { sessions: { session_id: string }[] };
      expect(sessions.map((s) => s.session_id)).toContain(source);

      const res = await asker.callTool(
        { name: "ask_session", arguments: { session_id: source, question: "What codeword were you given earlier in this session? Reply with only the codeword." } },
        undefined,
        { timeout: 600_000 },
      );
      expect(res.isError, JSON.stringify(res.content)).toBeFalsy();
      expect((res.structuredContent as { answer: string }).answer).toContain(CODEWORD);
    } finally {
      await asker.close();
      await owner.close();
    }
  });
});

describe.skipIf(!live)("live task dispatch over MCP", () => {
  it.each(WORKERS)("%s edits files in the task's cwd and reports back with progress", { timeout: 900_000 }, async (agent) => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "consult-task-")));
    const env = { ...process.env, XDG_CONFIG_HOME: join(dir, ".config") } as Record<string, string>;
    saveSettings(settingsPath(env), withTasksEnabled(DEFAULT_SETTINGS, true));
    const client = new Client({ name: "live-test", version: "0" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(root, "dist/cli.js"), "serve"], cwd: dir, env }));
    try {
      const dispatched = await client.callTool({
        name: "dispatch_task",
        arguments: { agent, task: "Create a file named hello.txt containing the single word hi, then run `cat hello.txt` to check it." },
      });
      expect(dispatched.isError, JSON.stringify(dispatched.content)).toBeFalsy();
      const { task_id } = dispatched.structuredContent as { task_id: string };
      const progress: string[] = [];
      let status: { state: string; error?: string; result?: { report: string } } = { state: "running" };
      while (status.state === "running") {
        const res = await client.callTool({ name: "task_status", arguments: { task_id, wait_sec: 120 } }, undefined, {
          timeout: 300_000,
          onprogress: (p) => progress.push(p.message ?? ""),
        });
        status = res.structuredContent as typeof status;
      }
      expect(status.state, status.error).toBe("succeeded");
      expect(status.result?.report).toBeTruthy();
      expect(readFileSync(join(dir, "hello.txt"), "utf8").trim()).toBe("hi");
      expect(progress.some((m) => m.includes("cat hello.txt")), progress.join("\n")).toBe(true);
    } finally {
      await client.close();
    }
  });
});
