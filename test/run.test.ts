import { describe, expect, it } from "vitest";
import { run } from "../src/run.js";

describe("run", () => {
  it("captures stdout, stderr and exit code", async () => {
    const r = await run("sh", ["-c", "echo out; echo err >&2; exit 3"], { cwd: "/", timeoutMs: 5000 });
    expect(r).toEqual({ stdout: "out\n", stderr: "err\n", code: 3 });
  });

  it("does not leave stdin open for the child", async () => {
    const r = await run("cat", [], { cwd: "/", timeoutMs: 5000 });
    expect(r.code).toBe(0);
    expect(r.stopped).toBeUndefined();
  });

  it("kills the process group on timeout", async () => {
    const started = Date.now();
    const r = await run("sh", ["-c", "sleep 10 & sleep 10"], { cwd: "/", timeoutMs: 200 });
    expect(r.stopped).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("kills the process group when the signal aborts", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const started = Date.now();
    const r = await run("sh", ["-c", "sleep 10 & sleep 10"], { cwd: "/", timeoutMs: 10_000, signal: controller.signal });
    expect(r.stopped).toBe("aborted");
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("does not start at all when the signal is already aborted", async () => {
    const r = await run("sh", ["-c", "echo started"], { cwd: "/", timeoutMs: 5000, signal: AbortSignal.abort() });
    expect(r.stopped).toBe("aborted");
    expect(r.stdout).toBe("");
  });

  it("stops a child that produces more output than the limit", async () => {
    const r = await run("sh", ["-c", "yes"], { cwd: "/", timeoutMs: 10_000, maxOutputBytes: 100_000 });
    expect(r.stopped).toBe("output_limit");
    expect(r.stdout.length).toBeLessThan(10_000_000);
  });

  it("rejects with a clear message when the command is missing", async () => {
    await expect(run("definitely-not-a-cli", [], { cwd: "/", timeoutMs: 1000 })).rejects.toThrow(
      /definitely-not-a-cli.*not found/,
    );
  });
});
