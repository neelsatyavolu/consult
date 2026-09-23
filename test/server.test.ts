import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { createServer, type ServerDeps } from "../src/server.js";

async function connect(deps: ServerDeps) {
  const server = createServer(deps);
  const client = new Client({ name: "test", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

const text = (res: unknown) => (res as { content: { type: string; text: string }[] }).content[0]!.text;

describe("MCP server", () => {
  it("exposes ask_agent and list_agents", async () => {
    const client = await connect({ ask: vi.fn(), listAgents: vi.fn(), defaultCwd: "/repo" });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["ask_agent", "list_agents"]);
  });

  it("forwards ask_agent to consult with the server's cwd by default", async () => {
    const ask = vi.fn(async () => ({ agent: "codex" as const, answer: "Use a mutex.", sessionId: "t1", model: undefined, durationMs: 42 }));
    const client = await connect({ ask, listAgents: vi.fn(), defaultCwd: "/repo" });
    const res = await client.callTool({ name: "ask_agent", arguments: { agent: "codex", question: "Race here?", model: "gpt-6-astra" } });
    expect(ask).toHaveBeenCalledWith(
      { agent: "codex", question: "Race here?", cwd: "/repo", model: "gpt-6-astra", effort: undefined, sessionId: undefined },
      expect.any(AbortSignal),
    );
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toEqual({ agent: "codex", answer: "Use a mutex.", session_id: "t1", duration_ms: 42 });
    expect(text(res)).toContain("Use a mutex.");
    expect(text(res)).toContain("session_id: t1");
  });

  it("passes session_id and cwd through for follow-ups", async () => {
    const ask = vi.fn(async () => ({ agent: "grok" as const, answer: "a", sessionId: "s", model: "grok-4.7", durationMs: 1 }));
    const client = await connect({ ask, listAgents: vi.fn(), defaultCwd: "/repo" });
    await client.callTool({ name: "ask_agent", arguments: { agent: "grok", question: "and?", session_id: "s", cwd: "/other" } });
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "s", cwd: "/other" }), expect.any(AbortSignal));
  });

  it("returns advisor failures as tool errors", async () => {
    const ask = vi.fn(async () => { throw new Error("codex exited with code 1: not logged in"); });
    const client = await connect({ ask, listAgents: vi.fn(), defaultCwd: "/repo" });
    const res = await client.callTool({ name: "ask_agent", arguments: { agent: "codex", question: "q" } });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("not logged in");
  });

  it("rejects unknown agents", async () => {
    const client = await connect({ ask: vi.fn(), listAgents: vi.fn(), defaultCwd: "/repo" });
    const res = await client.callTool({ name: "ask_agent", arguments: { agent: "gemini", question: "q" } }).catch((e: Error) => e);
    const failed = res instanceof Error || (res as { isError?: boolean }).isError === true;
    expect(failed).toBe(true);
  });

  it("lists agents", async () => {
    const listAgents = vi.fn(async () => [{ agent: "codex" as const, installed: true, version: "codex-cli 0.156.0", models: ["gpt-6-astra"] }]);
    const client = await connect({ ask: vi.fn(), listAgents, defaultCwd: "/repo" });
    const res = await client.callTool({ name: "list_agents", arguments: {} });
    expect(text(res)).toContain("gpt-6-astra");
  });
});
