import { statSync } from "node:fs";
import { framePrompt } from "./prompt.js";
import { AdvisorError, type AgentName, type Adapter, type AskRequest, type AskResult, type Runner, type StopReason } from "./types.js";

export interface ConsultDeps {
  readonly run: Runner;
  readonly adapters: Readonly<Record<AgentName, Adapter>>;
  readonly timeoutMs: number;
}

const STDERR_TAIL = 2000;

function validate(request: AskRequest): void {
  if (!request.question.trim()) throw new AdvisorError("question must not be empty");
  let isDir = false;
  try {
    isDir = statSync(request.cwd).isDirectory();
  } catch {
    // Reported below.
  }
  if (!isDir) throw new AdvisorError(`cwd is not a directory: ${request.cwd}`);
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

export function createConsult({ run, adapters, timeoutMs }: ConsultDeps) {
  async function ask(request: AskRequest, signal?: AbortSignal): Promise<AskResult> {
    validate(request);
    const adapter = adapters[request.agent];
    const started = Date.now();
    // Computed per call, never cached: containment must reflect the config as it is right now.
    const extraArgs = adapter.prepare ? await adapter.prepare(run, request.cwd, signal) : [];
    const invocation = adapter.build(request, framePrompt(request.question, Boolean(request.sessionId)), extraArgs);
    const res = await run(invocation.command, invocation.args, { cwd: request.cwd, timeoutMs, signal });

    if (res.stopped) throw new AdvisorError(stoppedMessage(adapter.name, res.stopped, timeoutMs));
    if (res.code !== 0) {
      const detail = (res.stderr.trim() || res.stdout.trim()).slice(-STDERR_TAIL);
      throw new AdvisorError(`${adapter.name} exited with code ${res.code}: ${detail}`);
    }
    return { agent: adapter.name, ...adapter.parse(res.stdout), durationMs: Date.now() - started };
  }

  return { ask };
}
