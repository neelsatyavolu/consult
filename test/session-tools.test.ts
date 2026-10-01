import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { createServer } from "../src/server.js";
import type { SessionToolDeps } from "../src/session-tools.js";

async function connect(sessions?: SessionToolDeps) {
  const server = createServer({
    ask: vi.fn(),
    listAgents: vi.fn(),
    defaultCwd: "/repo",
    progressIntervalMs: 10,
    ...(sessions ? { sessions } : {}),
  });
  const client = new Client({ name: "test", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

const text = (res: unknown) => (res as { content: { type: string; text: string }[] }).content[0]!.text;
const view = { session_id: "s-2", agent: "codex" as const, cwd: "/work/api", branch: "feat", started_at: "2026-10-01T10:00:00.000Z" };

describe("session tools", () => {
  it("are absent, and not mentioned, when live sessions are off", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).not.toContain("list_sessions");
    expect(client.getInstructions()).not.toMatch(/list_sessions/);
  });

  it("are listed with all four hints and explained in the instructions when on", async () => {
    const client = await connect({ list: vi.fn(() => []), ask: vi.fn() });
    const { tools } = await client.listTools();
    const hints = Object.fromEntries(tools.map((t) => [t.name, t.annotations]));
    expect(hints.list_sessions).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false });
    expect(hints.ask_session).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true });
    expect(client.getInstructions()).toMatch(/ask_session/);
  });

  it("list_sessions returns the sessions, or says there are none", async () => {
    const list = vi.fn().mockReturnValueOnce([view]).mockReturnValueOnce([]);
    const client = await connect({ list, ask: vi.fn() });
    const first = await client.callTool({ name: "list_sessions", arguments: {} });
    expect(first.structuredContent).toEqual({ sessions: [view] });
    const second = await client.callTool({ name: "list_sessions", arguments: {} });
    expect(text(second)).toMatch(/no other live sessions/i);
  });

  it("list_sessions reports errors such as sessions being turned off", async () => {
    const list = vi.fn(() => {
      throw new Error("live sessions are turned off");
    });
    const client = await connect({ list, ask: vi.fn() });
    const res = await client.callTool({ name: "list_sessions", arguments: {} });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/turned off/);
  });

  it("ask_session forwards the question and returns the fork's session_id and cwd for follow-ups", async () => {
    const ask = vi.fn(async () => ({
      agent: "codex" as const,
      answer: "Renamed to fetchUser.",
      sessionId: "fork-1",
      durationMs: 1200,
      cwd: "/work/api",
      source: "s-2",
    }));
    const client = await connect({ list: vi.fn(() => []), ask });
    const res = await client.callTool({ name: "ask_session", arguments: { session_id: "s-2", question: "What did you rename?", effort: "low" } });
    expect(ask).toHaveBeenCalledWith("s-2", "What did you rename?", "low", expect.any(AbortSignal));
    expect(res.structuredContent).toEqual({
      agent: "codex",
      answer: "Renamed to fetchUser.",
      session_id: "fork-1",
      source_session_id: "s-2",
      cwd: "/work/api",
      duration_ms: 1200,
    });
    expect(text(res)).toContain("Renamed to fetchUser.");
    expect(text(res)).toMatch(/ask_agent.*session_id.*cwd/);
  });

  it("ask_session rejects a session_id that could be parsed as a flag, without asking", async () => {
    const ask = vi.fn();
    const client = await connect({ list: vi.fn(() => []), ask });
    const res = await client.callTool({ name: "ask_session", arguments: { session_id: "--last", question: "q" } });
    expect(res.isError).toBe(true);
    expect(ask).not.toHaveBeenCalled();
  });

  it("ask_session reports failures as tool errors", async () => {
    const ask = vi.fn(async () => {
      throw new Error("no live session s-9 in scope");
    });
    const client = await connect({ list: vi.fn(() => []), ask });
    const res = await client.callTool({ name: "ask_session", arguments: { session_id: "s-9", question: "q" } });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/no live session s-9/);
  });
});
