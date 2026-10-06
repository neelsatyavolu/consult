import { statSync } from "node:fs";
import { frameForkPrompt, framePrompt } from "./prompt.js";
import {
  AdvisorError,
  type Adapter,
  type AgentName,
  type AskRequest,
  type AskResult,
  type Effort,
  type Invocation,
  type Runner,
  type RunResult,
  type StopReason,
} from "./types.js";

export interface ConsultDeps {
  readonly run: Runner;
  readonly adapters: Readonly<Record<AgentName, Adapter>>;
  readonly timeoutMs: number;
}

const STDERR_TAIL = 2000;

export function assertDirectory(cwd: string): void {
  let isDir = false;
  try {
    isDir = statSync(cwd).isDirectory();
  } catch {
    // Reported below.
  }
  if (!isDir) throw new AdvisorError(`cwd is not a directory: ${cwd}`);
}

function validate(request: AskRequest): void {
  if (!request.question.trim()) throw new AdvisorError("question must not be empty");
  assertDirectory(request.cwd);
}

function stoppedMessage(agent: AgentName, reason: StopReason, timeoutMs: number): string {
  switch (reason) {
    case "timeout":
      return `${agent} timed out after ${Math.round(timeoutMs / 1000)}s`;
    case "aborted":
      return `${agent} call was cancelled`;
    case "output_limit":
      return `${agent} produced too much output and was stopped`;
  }
}

/** Throws when the CLI was stopped or exited non-zero. */
export function assertExitedCleanly(agent: AgentName, res: RunResult, timeoutMs: number): void {
  if (res.stopped) throw new AdvisorError(stoppedMessage(agent, res.stopped, timeoutMs));
  if (res.code !== 0) {
    const detail = (res.stderr.trim() || res.stdout.trim()).slice(-STDERR_TAIL);
    throw new AdvisorError(`${agent} exited with code ${res.code}: ${detail}`);
  }
}

/** A live session to fork: the CLI that owns it, its id, and the directory it runs in. */
export interface ForkTarget {
  readonly agent: AgentName;
  readonly sessionId: string;
  readonly cwd: string;
}

export function createConsult({ run, adapters, timeoutMs }: ConsultDeps) {
  async function execute(
    adapter: Adapter,
    request: AskRequest,
    invoke: (extraArgs: readonly string[]) => Invocation,
    signal?: AbortSignal,
  ): Promise<AskResult> {
    validate(request);
    const started = Date.now();
    // Computed per call, never cached: containment must reflect the config as it is right now.
    const extraArgs = adapter.prepare ? await adapter.prepare(run, request.cwd, signal) : [];
    const invocation = invoke(extraArgs);
    const res = await run(invocation.command, invocation.args, { cwd: request.cwd, timeoutMs, signal });
    assertExitedCleanly(adapter.name, res, timeoutMs);
    return { agent: adapter.name, ...adapter.parse(res.stdout), durationMs: Date.now() - started };
  }

  async function ask(request: AskRequest, signal?: AbortSignal): Promise<AskResult> {
    const adapter = adapters[request.agent];
    const prompt = framePrompt(request.question, Boolean(request.sessionId));
    return execute(adapter, request, (extra) => adapter.build(request, prompt, extra), signal);
  }

  /** Asks a read-only fork of a live session. It runs in that session's directory, where its CLI can find it. */
  async function askSession(target: ForkTarget, question: string, effort?: Effort, signal?: AbortSignal): Promise<AskResult> {
    const adapter = adapters[target.agent];
    const request: AskRequest = { agent: target.agent, question, cwd: target.cwd, ...(effort ? { effort } : {}) };
    return execute(adapter, request, (extra) => adapter.fork(target.sessionId, request, frameForkPrompt(question), extra), signal);
  }

  return { ask, askSession };
}
