import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { claude } from "../src/adapters/claude.js";
import { codex } from "../src/adapters/codex.js";
import { grok } from "../src/adapters/grok.js";
import type { AskRequest, RunResult } from "../src/types.js";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const base: AskRequest = { agent: "claude", question: "q", cwd: "/repo" };

const valueAfter = (args: readonly string[], flag: string) => args[args.indexOf(flag) + 1];

describe("claude adapter", () => {
  it("starts a read-only session with a fresh session id and no MCP servers", () => {
    const inv = claude.build(base, "PROMPT", []);
    expect(inv.command).toBe("claude");
    expect(inv.args).toContain("--restricted");
    expect(inv.args).toContain("--strict-mcp-config");
    expect(valueAfter(inv.args, "--tools")).toBe("Read,Grep,Glob");
    expect(valueAfter(inv.args, "--output-format")).toBe("json");
    expect(valueAfter(inv.args, "--session-id")).toMatch(UUID);
    expect(inv.args).not.toContain("--resume");
    expect(inv.args.at(-1)).toBe("PROMPT");
  });

  it("resumes an existing session and passes model and effort", () => {
    const inv = claude.build({ ...base, sessionId: "abc", model: "opus", effort: "high" }, "P", []);
    expect(valueAfter(inv.args, "--resume")).toBe("abc");
    expect(inv.args).not.toContain("--session-id");
    expect(valueAfter(inv.args, "--model")).toBe("opus");
    expect(valueAfter(inv.args, "--effort")).toBe("high");
  });

  it("parses the json result", () => {
    expect(claude.parse(fixture("claude.json"))).toEqual({
      answer: "pineapple",
      sessionId: "11111111-2222-4333-8444-555555555555",
      model: "claude-haiku-4-5-20251001",
    });
  });

  it("throws when claude reports an error", () => {
    const out = JSON.stringify({ type: "result", is_error: true, result: "Not logged in", session_id: "x" });
    expect(() => claude.parse(out)).toThrow(/Not logged in/);
  });
});

describe("codex adapter", () => {
  const extra = ["-c", "features.plugins=false"];

  it("starts a read-only, never-ask exec with the prepared extra args", () => {
    const inv = codex.build({ ...base, agent: "codex" }, "PROMPT", extra);
    expect(inv.command).toBe("codex");
    expect(inv.args.slice(0, 2)).toEqual(["exec", "--json"]);
    expect(inv.args).toContain("--skip-git-repo-check");
    expect(inv.args).toContain('sandbox_mode="read-only"');
    expect(inv.args).toContain('approval_policy="never"');
    expect(inv.args).toContain("features.plugins=false");
    expect(inv.args.at(-1)).toBe("PROMPT");
  });

  it("resumes by thread id and passes model and effort as config", () => {
    const inv = codex.build({ ...base, agent: "codex", sessionId: "tid", model: "gpt-6-astra", effort: "low" }, "P", extra);
    expect(inv.args.slice(0, 3)).toEqual(["exec", "resume", "--json"]);
    expect(inv.args.slice(-2)).toEqual(["tid", "P"]);
    expect(inv.args).toContain('model="gpt-6-astra"');
    expect(inv.args).toContain('model_reasoning_effort="low"');
  });

  it("parses the last agent message and thread id", () => {
    expect(codex.parse(fixture("codex.jsonl"))).toEqual({
      answer: "pineapple",
      sessionId: "01a0ccd8-7e85-72e2-9287-a11b48b9ef62",
    });
  });

  it("throws on a failed turn", () => {
    const out = [
      JSON.stringify({ type: "thread.started", thread_id: "t" }),
      JSON.stringify({ type: "turn.failed", error: { message: "usage limit reached" } }),
    ].join("\n");
    expect(() => codex.parse(out)).toThrow(/usage limit reached/);
  });

  it("throws when there is no agent message", () => {
    expect(() => codex.parse(JSON.stringify({ type: "thread.started", thread_id: "t" }))).toThrow(/no answer/i);
  });

  it("prepares overrides that disable plugins and every enabled MCP server", async () => {
    const calls: string[][] = [];
    const fakeRun = async (_cmd: string, args: readonly string[]): Promise<RunResult> => {
      calls.push([...args]);
      const list = [
        { name: "context7", enabled: true },
        { name: "consult", enabled: true },
        { name: "old", enabled: false },
      ];
      return { stdout: JSON.stringify(list), stderr: "", code: 0 };
    };
    const args = await codex.prepare!(fakeRun, "/repo");
    expect(calls[0]).toEqual(["mcp", "list", "--json", "-c", "features.plugins=false"]);
    expect(args).toEqual([
      "-c", "features.plugins=false",
      "-c", "mcp_servers.context7.enabled=false",
      "-c", "mcp_servers.consult.enabled=false",
    ]);
  });

  it("refuses to run when the MCP server list cannot be read", async () => {
    const fakeRun = async (): Promise<RunResult> => ({ stdout: "", stderr: "boom", code: 1 });
    await expect(codex.prepare!(fakeRun, "/repo")).rejects.toThrow(/boom/);
  });
});

describe("grok adapter", () => {
  it("starts a session limited to read-only built-in tools with no MCP access", () => {
    const inv = grok.build({ ...base, agent: "grok" }, "PROMPT", []);
    expect(inv.command).toBe("grok");
    expect(valueAfter(inv.args, "--single")).toBe("PROMPT");
    expect(valueAfter(inv.args, "--session-id")).toMatch(UUID);
    expect(valueAfter(inv.args, "--output-format")).toBe("streaming-messages-json");
    expect(valueAfter(inv.args, "--tools")).toBe("read_file,grep,list_dir");
    expect(valueAfter(inv.args, "--disallowed-tools")).toBe("Agent,search_tool,use_tool");
  });

  it("resumes and passes model and effort", () => {
    const inv = grok.build({ ...base, agent: "grok", sessionId: "sid", model: "grok-4.7", effort: "medium" }, "P", []);
    expect(valueAfter(inv.args, "--resume")).toBe("sid");
    expect(inv.args).not.toContain("--session-id");
    expect(valueAfter(inv.args, "--model")).toBe("grok-4.7");
    expect(valueAfter(inv.args, "--reasoning-effort")).toBe("medium");
  });

  it("parses the result line and model", () => {
    const reply = grok.parse(fixture("grok.jsonl"));
    expect(reply.answer).toBe("pineapple");
    expect(reply.sessionId).toMatch(UUID);
    expect(reply.model).toBe("grok-4.7");
  });

  it("throws when the result is an error", () => {
    const out = JSON.stringify({ type: "result", is_error: true, result: "auth expired", session_id: "s" });
    expect(() => grok.parse(out)).toThrow(/auth expired/);
  });
});
