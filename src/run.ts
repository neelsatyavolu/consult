import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { RunOptions, RunResult, StopReason } from "./types.js";

const KILL_GRACE_MS = 3000;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

// A signal handler that calls process.exit() skips the SIGKILL grace timers, so groups still running then are
// killed synchronously on the way out.
const liveGroups = new Set<number>();
let exitHookInstalled = false;
function trackGroup(pid: number): void {
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.once("exit", () => {
      for (const group of liveGroups) {
        try {
          process.kill(-group, "SIGKILL");
        } catch {
          // Group already exited.
        }
      }
    });
  }
  liveGroups.add(pid);
}

/** Calls `onLine` for each complete line, without rescanning text already split. */
function lineSplitter(onLine: (line: string) => void) {
  const decoder = new StringDecoder("utf8");
  let partial = "";
  return {
    write(chunk: Buffer) {
      const text = decoder.write(chunk);
      let start = 0;
      for (let nl = text.indexOf("\n"); nl !== -1; nl = text.indexOf("\n", start)) {
        onLine(partial + text.slice(start, nl));
        partial = "";
        start = nl + 1;
      }
      partial += text.slice(start);
    },
    end() {
      const rest = partial + decoder.end();
      partial = "";
      if (rest) onLine(rest);
    },
  };
}

/**
 * Runs a command with stdin closed, in its own process group so that a timeout, an abort or runaway
 * output kills everything it started.
 */
export function run(
  command: string,
  args: readonly string[],
  { cwd, timeoutMs, signal, maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES, onStdoutLine }: RunOptions,
): Promise<RunResult> {
  if (signal?.aborted) return Promise.resolve({ stdout: "", stderr: "", code: null, stopped: "aborted" });

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"], detached: true });
    if (child.pid) trackGroup(child.pid);
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
      if (child.pid) liveGroups.delete(child.pid);
      clearTimeout(timer);
      clearTimeout(graceTimer);
      signal?.removeEventListener("abort", onAbort);
    };

    const timer = setTimeout(() => stop("timeout"), timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });

    const collect = (into: (chunk: Buffer) => void) => (chunk: Buffer) => {
      if (stopped) return;
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) return stop("output_limit");
      into(chunk);
    };
    const lines = onStdoutLine ? lineSplitter(onStdoutLine) : undefined;
    child.stdout.on("data", collect((chunk) => (lines ? lines.write(chunk) : stdout.push(chunk))));
    child.stderr.on("data", collect((chunk) => stderr.push(chunk)));
    child.stdout.on("end", () => {
      if (!stopped) lines?.end();
    });

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
