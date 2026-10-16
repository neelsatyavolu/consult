import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { run } from "../src/run.js";

describe("run", () => {
  it("captures stdout, stderr and exit code", async () => {
    const r = await run("sh", ["-c", "echo out; echo err >&2; exit 3"], { cwd: "/", timeoutMs: 5000 });
    expect(r).toEqual({ stdout: "out\n", stderr: "err\n", code: 3 });
  });

  it("streams complete stdout lines as they arrive, even when a line spans chunks", async () => {
    const lines: string[] = [];
    const r = await run("sh", ["-c", "printf 'a\\nb'; sleep 0.1; printf 'c\\nd\\n'"], {
      cwd: "/",
      timeoutMs: 5000,
      onStdoutLine: (line) => lines.push(line),
    });
    expect(lines).toEqual(["a", "bc", "d"]);
    expect(r.stdout).toBe("");
  });

  it("streams a last line that has no newline, and multibyte characters split across chunks", async () => {
    const lines: string[] = [];
    await run("sh", ["-c", "printf 'x\\n\\303'; sleep 0.1; printf '\\251 end'"], { cwd: "/", timeoutMs: 5000, onStdoutLine: (l) => lines.push(l) });
    expect(lines).toEqual(["x", "é end"]);
  });

  it("does not leave stdin open for the child", async () => {
    const r = await run("cat", [], { cwd: "/", timeoutMs: 5000 });
    expect(r.code).toBe(0);
    expect(r.stopped).toBeUndefined();
  });

  // A child that starts a grandchild sharing its stdout: run() only resolves once both are gone.
  const WITH_GRANDCHILD = `require("node:child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], { stdio: "inherit" }); setTimeout(() => {}, 10000);`;

  it("kills the process group on timeout", async () => {
    const started = Date.now();
    const r = await run(process.execPath, ["-e", WITH_GRANDCHILD], { cwd: tmpdir(), timeoutMs: 200 });
    expect(r.stopped).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("kills the process group when the signal aborts", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const started = Date.now();
    const r = await run(process.execPath, ["-e", WITH_GRANDCHILD], { cwd: tmpdir(), timeoutMs: 10_000, signal: controller.signal });
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

// npm writes a real shim for a globally installed bin: a .cmd batch file on Windows, a symlink elsewhere. Running
// through cmd.exe would mangle these arguments or run `calc`; run() must pass them through untouched.
describe("run with an npm-installed CLI", () => {
  it("passes every argument through exactly, with no shell in between", { timeout: 120_000 }, async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { execFileSync } = await import("node:child_process");
    const pkg = mkdtempSync(join(tmpdir(), "consult-echo-pkg-"));
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "consult-echo-args", version: "1.0.0", bin: { "consult-echo-args": "index.js" } }));
    writeFileSync(join(pkg, "index.js"), "#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));\n");
    const prefix = mkdtempSync(join(tmpdir(), "consult-echo-prefix-"));
    execFileSync("npm", ["install", "-g", "--prefix", prefix, "--no-audit", "--no-fund", pkg], { stdio: "pipe", shell: process.platform === "win32" });
    const bin = process.platform === "win32" ? join(prefix, "consult-echo-args") : join(prefix, "bin", "consult-echo-args");
    const args = ["plain", "a & calc", "x | y", "%PATH%", 'say "hi"', "line one\nline two", "^caret", "trailing\\", ""];
    const r = await run(bin, args, { cwd: tmpdir(), timeoutMs: 60_000 });
    expect(r.code, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual(args);
  });
});
