import { spawn } from "node:child_process";
import type { RunOptions, RunResult, StopReason } from "./types.js";

const KILL_GRACE_MS = 3000;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

/**
 * Runs a command with stdin closed, in its own process group so that a timeout, an abort or runaway
 * output kills everything it started.
 */
export function run(
  command: string,
  args: readonly string[],
  { cwd, timeoutMs, signal, maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES }: RunOptions,
): Promise<RunResult> {
  if (signal?.aborted) return Promise.resolve({ stdout: "", stderr: "", code: null, stopped: "aborted" });

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"], detached: true });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let stopped: StopReason | undefined;
    let graceTimer: NodeJS.Timeout | undefined;

    const killGroup = (sig: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, sig);
      } catch {
        // Group already exited.
      }
    };
    const stop = (reason: StopReason) => {
      if (stopped) return;
      stopped = reason;
      killGroup("SIGTERM");
      graceTimer = setTimeout(() => killGroup("SIGKILL"), KILL_GRACE_MS);
    };
    const onAbort = () => stop("aborted");
    const cleanup = () => {
      clearTimeout(timer);
      clearTimeout(graceTimer);
      signal?.removeEventListener("abort", onAbort);
    };

    const timer = setTimeout(() => stop("timeout"), timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });

    const collect = (into: Buffer[]) => (chunk: Buffer) => {
      if (stopped) return;
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) return stop("output_limit");
      into.push(chunk);
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));

    child.on("error", (err: NodeJS.ErrnoException) => {
      cleanup();
      reject(err.code === "ENOENT" ? new Error(`${command} CLI not found on PATH`) : err);
    });
    child.on("close", (code) => {
      cleanup();
      // Leftover grandchildren keep the group alive; take them down now instead of after the grace period.
      if (stopped) killGroup("SIGKILL");
      resolve({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        code,
        ...(stopped ? { stopped } : {}),
      });
    });
  });
}
