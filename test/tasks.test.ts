import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { createTaskManager } from "../src/tasks.js";
import type { RunOptions, RunResult, Runner, TaskRequest, Worker } from "../src/types.js";

const cwd = tmpdir();
const request: TaskRequest = { agent: "codex", task: "Add tests for src/x.ts", cwd };

const worker: Worker = {
  name: "codex",
  build: (_request, prompt, extraArgs) => ({ command: "worker", args: [...extraArgs, prompt] }),
  describe: (event) => {
    if (event.boom) throw new Error("bad event");
    return typeof event.say === "string" ? event.say : undefined;
  },
  parse: (stdout) => {
    const report = stdout.trim().split("\n").at(-1);
    if (!report) throw new Error("worker returned no report");
    return { answer: report, sessionId: "s1" };
  },
};
const workers = { codex: worker, grok: { ...worker, name: "grok" as const } };

/** A runner whose process stays up until the test finishes it, and stops on abort like the real one. */
function controlledRun() {
  const calls: { command: string; args: readonly string[]; options: RunOptions; finish: (res: RunResult) => void }[] = [];
  const run: Runner = (command, args, options) =>
    new Promise((resolve) => {
      calls.push({ command, args, options, finish: resolve });
      options.signal?.addEventListener("abort", () => resolve({ stdout: "", stderr: "", code: null, stopped: "aborted" }));
    });
  const last = () => calls.at(-1)!;
  return {
    run,
    calls,
    emit: (line: string) => last().options.onStdoutLine?.(line),
    finish: (res: RunResult) => last().finish(res),
  };
}

const ok = (stdout: string): RunResult => ({ stdout, stderr: "", code: 0 });

describe("task manager", () => {
  it("starts the worker in the background with the task briefing, cwd and timeout", () => {
    const fake = controlledRun();
    const tasks = createTaskManager({ run: fake.run, workers, timeoutMs: 1234 });
    const view = tasks.start(request);
    expect(view).toMatchObject({ id: "task-1", agent: "codex", state: "running", cwd, updates: [] });
    expect(fake.calls).toHaveLength(1);
    const { command, args, options } = fake.calls[0]!;
    expect(command).toBe("worker");
    expect(args.at(-1)).toMatch(/^Another AI coding agent .*dispatched you/s);
    expect(args.at(-1)).toContain("Add tests for src/x.ts");
    expect(options).toMatchObject({ cwd, timeoutMs: 1234 });
  });

  it("records narrated updates in order, on one line each, and ignores events it can't narrate", () => {
    const fake = controlledRun();
    let clock = 1000;
    const tasks = createTaskManager({ run: fake.run, workers, timeoutMs: 1000, now: () => clock });
    tasks.start(request);
    clock = 3500;
    fake.emit(JSON.stringify({ say: "$ npm   test\nrunning" }));
    fake.emit(JSON.stringify({ other: true }));
    fake.emit("not json");
    fake.emit(JSON.stringify({ boom: true }));
    fake.emit(JSON.stringify({ say: "edited src/x.test.ts" }));
    expect(tasks.get("task-1").updates).toEqual([
      { seq: 1, atMs: 2500, text: "$ npm test running" },
      { seq: 2, atMs: 2500, text: "edited src/x.test.ts" },
    ]);
  });

  it("keeps only the most recent updates", () => {
    const fake = controlledRun();
    const tasks = createTaskManager({ run: fake.run, workers, timeoutMs: 1000 });
    tasks.start(request);
    for (let i = 0; i < 250; i++) fake.emit(JSON.stringify({ say: `step ${i + 1}` }));
    const { updates } = tasks.get("task-1");
    expect(updates).toHaveLength(200);
    expect(updates[0]).toMatchObject({ seq: 51, text: "step 51" });
    expect(updates.at(-1)).toMatchObject({ seq: 250 });
  });

  it("succeeds with the worker's report", async () => {
    const fake = controlledRun();
    const tasks = createTaskManager({ run: fake.run, workers, timeoutMs: 1000 });
    tasks.start(request);
    const done = tasks.wait("task-1");
    fake.emit("Added 4 tests; all pass.");
    fake.emit("x".repeat(300_000));
    fake.finish(ok(""));
    const view = await done;
    expect(view.state).toBe("succeeded");
    expect(view.result).toEqual({ answer: "Added 4 tests; all pass.", sessionId: "s1" });
    expect(view.finishedAt).toBeDefined();
  });

  it("fails with the exit code and output when the worker exits non-zero", async () => {
    const fake = controlledRun();
    const tasks = createTaskManager({ run: fake.run, workers, timeoutMs: 1000 });
    tasks.start(request);
    fake.finish({ stdout: "", stderr: "not logged in", code: 1 });
    const view = await tasks.wait("task-1");
    expect(view).toMatchObject({ state: "failed", error: "codex exited with code 1: not logged in" });
  });

  it("fails when the worker's output has no report, and when it times out", async () => {
    const fake = controlledRun();
    const tasks = createTaskManager({ run: fake.run, workers, timeoutMs: 60_000 });
    tasks.start(request);
    fake.finish(ok(""));
    expect(await tasks.wait("task-1")).toMatchObject({ state: "failed", error: "worker returned no report" });
    tasks.start(request);
    fake.finish({ stdout: "", stderr: "", code: null, stopped: "timeout" });
    expect(await tasks.wait("task-2")).toMatchObject({ state: "failed", error: "codex timed out after 60s" });
  });

  it("passes prepare's extra args and fails if prepare does", async () => {
    const fake = controlledRun();
    const prepare = vi.fn(async () => ["-c", "mcp_servers.consult.enabled=false"]);
    const tasks = createTaskManager({ run: fake.run, workers: { ...workers, codex: { ...worker, prepare } }, timeoutMs: 1000 });
    tasks.start(request);
    await vi.waitFor(() => expect(fake.calls).toHaveLength(1));
    expect(prepare).toHaveBeenCalledWith(fake.run, cwd, expect.any(AbortSignal));
    expect(fake.calls[0]!.args).toContain("mcp_servers.consult.enabled=false");

    prepare.mockRejectedValueOnce(new Error("could not list codex MCP servers"));
    tasks.start(request);
    expect(await tasks.wait("task-2")).toMatchObject({ state: "failed", error: "could not list codex MCP servers" });
    expect(fake.calls).toHaveLength(1);
  });

  it("cancels a running task and resolves once the process has stopped", async () => {
    const fake = controlledRun();
    const tasks = createTaskManager({ run: fake.run, workers, timeoutMs: 1000 });
    tasks.start(request);
    const view = await tasks.cancel("task-1");
    expect(view.state).toBe("cancelled");
    expect(fake.calls[0]!.options.signal?.aborted).toBe(true);
    expect((await tasks.cancel("task-1")).state).toBe("cancelled");
  });

  it("cancels every running task when the server shuts down, and refuses new ones", async () => {
    const fake = controlledRun();
    const shutdown = new AbortController();
    const tasks = createTaskManager({ run: fake.run, workers, timeoutMs: 1000, signal: shutdown.signal });
    tasks.start(request);
    tasks.start({ ...request, agent: "grok" });
    shutdown.abort();
    expect((await tasks.wait("task-1")).state).toBe("cancelled");
    expect((await tasks.wait("task-2")).state).toBe("cancelled");
    expect(() => tasks.start(request)).toThrow(/shutting down/);
  });

  it("returns a running view when the wait times out or is aborted", async () => {
    const fake = controlledRun();
    const tasks = createTaskManager({ run: fake.run, workers, timeoutMs: 1000 });
    tasks.start(request);
    expect((await tasks.wait("task-1", 20)).state).toBe("running");
    const abort = new AbortController();
    const waiting = tasks.wait("task-1", 60_000, abort.signal);
    abort.abort();
    expect((await waiting).state).toBe("running");
    expect((await tasks.wait("task-1", 0)).state).toBe("running");
  });

  it("keeps a task's outcome when a subscriber throws", async () => {
    const fake = controlledRun();
    const tasks = createTaskManager({ run: fake.run, workers, timeoutMs: 1000 });
    tasks.start(request);
    tasks.subscribe("task-1", () => {
      throw new Error("listener bug");
    });
    fake.emit("report");
    fake.finish(ok(""));
    expect(await tasks.wait("task-1")).toMatchObject({ state: "succeeded", result: { answer: "report" } });
  });

  it("notifies subscribers of each change until they unsubscribe", () => {
    const fake = controlledRun();
    const tasks = createTaskManager({ run: fake.run, workers, timeoutMs: 1000 });
    tasks.start(request);
    const seen: number[] = [];
    const unsubscribe = tasks.subscribe("task-1", (view) => seen.push(view.updates.length));
    fake.emit(JSON.stringify({ say: "one" }));
    unsubscribe();
    fake.emit(JSON.stringify({ say: "two" }));
    expect(seen).toEqual([1]);
  });

  it("validates the request before starting anything", () => {
    const fake = controlledRun();
    const tasks = createTaskManager({ run: fake.run, workers, timeoutMs: 1000 });
    expect(() => tasks.start({ ...request, task: "  " })).toThrow(/task must not be empty/);
    expect(() => tasks.start({ ...request, cwd: "/definitely/not/here" })).toThrow(/cwd is not a directory/);
    expect(fake.calls).toHaveLength(0);
    expect(() => tasks.get("task-9")).toThrow(/unknown task_id task-9/);
  });

  it("lists tasks newest first and forgets the oldest finished ones past the limit", async () => {
    const run: Runner = async (_command, _args, options) => {
      options.onStdoutLine?.("done");
      return ok("");
    };
    const tasks = createTaskManager({ run, workers, timeoutMs: 1000 });
    for (let i = 0; i < 51; i++) {
      const { id } = tasks.start(request);
      await tasks.wait(id);
    }
    tasks.start(request);
    expect(() => tasks.get("task-1")).toThrow(/unknown task_id/);
    expect(tasks.get("task-2").state).toBe("succeeded");
    expect(tasks.list().map((v) => v.id).slice(0, 2)).toEqual(["task-52", "task-51"]);
  });
});
