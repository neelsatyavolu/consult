import { describe, expect, it, vi } from "vitest";
import { createConsult } from "../src/consult.js";
import type { Adapter, AgentName, RunResult, Runner } from "../src/types.js";

const ok = (stdout = "OUT"): RunResult => ({ stdout, stderr: "", code: 0 });

function fakeAdapter(name: AgentName, overrides: Partial<Adapter> = {}): Adapter {
  return {
    name,
    command: name,
    build: (_req, prompt, extra) => ({ command: name, args: [...extra, prompt] }),
    parse: (stdout) => ({ answer: `answer:${stdout}`, sessionId: "sid-1", model: "m-1" }),
    ...overrides,
  };
}

function setup(run: Runner, adapter: Adapter = fakeAdapter("codex")) {
  const adapters = { claude: fakeAdapter("claude"), codex: fakeAdapter("codex"), grok: fakeAdapter("grok"), [adapter.name]: adapter };
  return createConsult({ run, adapters, timeoutMs: 1000 });
}

describe("consult.ask", () => {
  it("runs the adapter's command in the caller's cwd and returns the parsed reply", async () => {
    const run = vi.fn<Runner>(async () => ok("raw"));
    const result = await setup(run).ask({ agent: "codex", question: "Is this safe?", cwd: "/tmp" });
    expect(result).toMatchObject({ agent: "codex", answer: "answer:raw", sessionId: "sid-1", model: "m-1" });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    const [cmd, args, opts] = run.mock.calls[0]!;
    expect(cmd).toBe("codex");
    expect(opts).toMatchObject({ cwd: "/tmp", timeoutMs: 1000 });
    const prompt = args.at(-1)!;
    expect(prompt).toContain("Is this safe?");
    expect(prompt).toMatch(/read-only/i);
  });

  it("frames follow-ups without repeating the advisor briefing", async () => {
    const run = vi.fn<Runner>(async () => ok());
    await setup(run).ask({ agent: "codex", question: "-and what about X?", cwd: "/tmp", sessionId: "sid-1" });
    const prompt = run.mock.calls[0]![1].at(-1)!;
    expect(prompt).toMatch(/^Follow-up/);
    expect(prompt).toContain("-and what about X?");
    expect(prompt).not.toMatch(/read-only/i);
  });

  it("reports a non-zero exit with the tail of stderr", async () => {
    const run = vi.fn<Runner>(async () => ({ stdout: "", stderr: "x".repeat(5000) + "Please log in", code: 2 }));
    const err = await setup(run).ask({ agent: "codex", question: "q", cwd: "/tmp" }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/codex exited with code 2/);
    expect((err as Error).message).toContain("Please log in");
    expect((err as Error).message.length).toBeLessThan(2500);
  });

  it("reports a timeout", async () => {
    const run = vi.fn<Runner>(async () => ({ stdout: "", stderr: "", code: null, stopped: "timeout" }));
    await expect(setup(run).ask({ agent: "grok", question: "q", cwd: "/tmp" })).rejects.toThrow(/grok timed out after 1s/);
  });

  it("rejects an empty question and a missing cwd before running anything", async () => {
    const run = vi.fn<Runner>(async () => ok());
    const consult = setup(run);
    await expect(consult.ask({ agent: "claude", question: "   ", cwd: "/tmp" })).rejects.toThrow(/question/);
    await expect(consult.ask({ agent: "claude", question: "q", cwd: "/no/such/dir" })).rejects.toThrow(/cwd/);
    expect(run).not.toHaveBeenCalled();
  });

  it("runs the adapter's prepare step on every call, in that call's cwd", async () => {
    // Containment depends on the current config (e.g. newly added MCP servers), so nothing is cached.
    const prepare = vi.fn<NonNullable<Adapter["prepare"]>>(async () => ["--extra"]);
    const run = vi.fn<Runner>(async () => ok());
    const consult = setup(run, fakeAdapter("codex", { prepare }));
    await consult.ask({ agent: "codex", question: "a", cwd: "/tmp" });
    await consult.ask({ agent: "codex", question: "b", cwd: "/" });
    expect(prepare.mock.calls.map((c) => c[1])).toEqual(["/tmp", "/"]);
    expect(run.mock.calls[1]![1][0]).toBe("--extra");
  });

  it("does not run the advisor when prepare fails", async () => {
    const prepare = vi.fn(async () => { throw new Error("list failed"); });
    const run = vi.fn<Runner>(async () => ok());
    await expect(setup(run, fakeAdapter("codex", { prepare })).ask({ agent: "codex", question: "a", cwd: "/tmp" })).rejects.toThrow(/list failed/);
    expect(run).not.toHaveBeenCalled();
  });

  it("passes the cancellation signal to the advisor process and reports cancellation", async () => {
    const run = vi.fn<Runner>(async () => ({ stdout: "", stderr: "", code: null, stopped: "aborted" }));
    const signal = new AbortController().signal;
    await expect(setup(run).ask({ agent: "claude", question: "q", cwd: "/tmp" }, signal)).rejects.toThrow(/claude call was cancelled/);
    expect(run.mock.calls[0]![2].signal).toBe(signal);
  });

  it("reports an advisor that produced too much output", async () => {
    const run = vi.fn<Runner>(async () => ({ stdout: "", stderr: "", code: null, stopped: "output_limit" }));
    await expect(setup(run).ask({ agent: "codex", question: "q", cwd: "/tmp" })).rejects.toThrow(/codex produced too much output/);
  });
});
