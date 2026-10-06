import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { createServer } from "../src/server.js";
import { createTaskManager } from "../src/tasks.js";
import type { RunOptions, RunResult, Runner, Worker } from "../src/types.js";

const cwd = tmpdir();

const worker: Worker = {
  name: "codex",
  build: (_request, prompt) => ({ command: "worker", args: [prompt] }),
  describe: (event) => (typeof event.say === "string" ? event.say : undefined),
  parse: (stdout) => ({ answer: stdout.trim().split("\n").at(-1) ?? "", sessionId: "thread-1", model: "gpt-6-astra" }),
};

async function setup() {
  const calls: { args: readonly string[]; options: RunOptions; finish: (res: RunResult) => void }[] = [];
  const run: Runner = (_command, args, options) =>
    new Promise((resolve) => {
      calls.push({ args, options, finish: resolve });
      options.signal?.addEventListener("abort", () => resolve({ stdout: "", stderr: "", code: null, stopped: "aborted" }));
    });
  const tasks = createTaskManager({ run, workers: { codex: worker, grok: { ...worker, name: "grok" } }, timeoutMs: 60_000 });
  const server = createServer({ ask: vi.fn(), listAgents: vi.fn(), defaultCwd: cwd, progressIntervalMs: 10_000, tasks });
  const client = new Client({ name: "test", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const emitLine = (line: string) => calls.at(-1)!.options.onStdoutLine?.(line);
  const emit = (say: string) => emitLine(JSON.stringify({ say }));
  const finish = (res: RunResult) => calls.at(-1)!.finish(res);
  return { client, calls, emit, emitLine, finish };
}

const text = (res: unknown) => (res as { content: { type: string; text: string }[] }).content[0]!.text;
const dispatch = (client: Client) =>
  client.callTool({ name: "dispatch_task", arguments: { agent: "codex", task: "Add tests for src/x.ts" } });

describe("task tools", () => {
  it("appear only when task dispatch is on, with write hints on dispatch_task", async () => {
    const { client } = await setup();
    const { tools } = await client.listTools();
    const hints = Object.fromEntries(tools.map((t) => [t.name, t.annotations]));
    expect(hints.dispatch_task).toEqual({ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true });
    expect(hints.task_status).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false });
    expect(hints.cancel_task).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    expect(client.getInstructions()).toMatch(/dispatch_task/);

    const plain = createServer({ ask: vi.fn(), listAgents: vi.fn(), defaultCwd: cwd });
    const other = new Client({ name: "test", version: "0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([plain.connect(a), other.connect(b)]);
    expect((await other.listTools()).tools.map((t) => t.name)).not.toContain("dispatch_task");
    expect(other.getInstructions()).not.toMatch(/dispatch_task/);
  });

  it("dispatch_task returns a task_id at once and runs the worker in the server's cwd", async () => {
    const { client, calls } = await setup();
    const res = await dispatch(client);
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toMatchObject({ task_id: "task-1", agent: "codex", state: "running", cwd });
    expect(text(res)).toContain("task_status");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.options.cwd).toBe(cwd);
  });

  it("only dispatches to codex and grok", async () => {
    const { client, calls } = await setup();
    const res = await client.callTool({ name: "dispatch_task", arguments: { agent: "claude", task: "t" } });
    expect(res.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("task_status relays updates as progress while waiting, then returns the report", async () => {
    const { client, emit, emitLine, finish } = await setup();
    await dispatch(client);
    const progress: { progress: number; message?: string }[] = [];
    const status = client.callTool({ name: "task_status", arguments: { task_id: "task-1", wait_sec: 30 } }, undefined, {
      onprogress: (p) => progress.push(p),
    });
    await new Promise((r) => setTimeout(r, 20));
    emit("$ npm test");
    emit("edited src/x.test.ts");
    await vi.waitFor(() => expect(progress).toHaveLength(2));
    emitLine("Added 4 tests; all pass.");
    finish({ stdout: "", stderr: "", code: 0 });
    const res = await status;
    expect(progress.map((p) => p.message)).toEqual([expect.stringMatching(/\] \$ npm test$/), expect.stringMatching(/edited src\/x.test.ts$/)]);
    expect(progress.map((p) => p.progress)).toEqual([1, 2]);
    expect(res.structuredContent).toMatchObject({
      task_id: "task-1",
      state: "succeeded",
      last_seq: 2,
      result: { report: "Added 4 tests; all pass.", session_id: "thread-1", model: "gpt-6-astra" },
    });
    expect(text(res)).toContain("Added 4 tests; all pass.");
    expect(text(res)).toContain("session_id: thread-1");
  });

  it("task_status without waiting returns the running state, and since filters updates", async () => {
    const { client, emit } = await setup();
    await dispatch(client);
    emit("one");
    emit("two");
    emit("three");
    const all = await client.callTool({ name: "task_status", arguments: { task_id: "task-1" } });
    expect(all.structuredContent).toMatchObject({ state: "running", last_seq: 3 });
    expect(text(all)).toContain("since=3");
    const newer = await client.callTool({ name: "task_status", arguments: { task_id: "task-1", since: 2 } });
    expect((newer.structuredContent as { updates: { text: string }[] }).updates.map((u) => u.text)).toEqual(["three"]);
    expect(newer.structuredContent).not.toHaveProperty("earlier_updates_dropped");
    for (let i = 0; i < 300; i++) emit(`step ${i}`);
    const behind = await client.callTool({ name: "task_status", arguments: { task_id: "task-1", since: 3 } });
    expect(behind.structuredContent).toMatchObject({ earlier_updates_dropped: true });
    expect(text(behind)).toContain("some earlier ones were dropped");
  });

  it("task_status without task_id lists tasks", async () => {
    const { client } = await setup();
    expect(text(await client.callTool({ name: "task_status", arguments: {} }))).toBe("No tasks yet.");
    await dispatch(client);
    const res = await client.callTool({ name: "task_status", arguments: {} });
    expect(text(res)).toMatch(/^task-1 · codex · running · \d+s · Add tests for src\/x.ts$/);
    expect((res.structuredContent as { tasks: unknown[] }).tasks).toHaveLength(1);
  });

  it("reports failures and unknown task ids", async () => {
    const { client, finish } = await setup();
    await dispatch(client);
    finish({ stdout: "", stderr: "not logged in", code: 1 });
    const res = await client.callTool({ name: "task_status", arguments: { task_id: "task-1", wait_sec: 5 } });
    expect(res.structuredContent).toMatchObject({ state: "failed", error: "codex exited with code 1: not logged in" });
    expect(text(res)).toContain("Failed: codex exited with code 1");
    const unknown = await client.callTool({ name: "task_status", arguments: { task_id: "task-7" } });
    expect(unknown.isError).toBe(true);
  });

  it("cancel_task stops the worker", async () => {
    const { client, calls } = await setup();
    await dispatch(client);
    const res = await client.callTool({ name: "cancel_task", arguments: { task_id: "task-1" } });
    expect(res.structuredContent).toMatchObject({ task_id: "task-1", state: "cancelled" });
    expect(calls[0]!.options.signal?.aborted).toBe(true);
  });
});
