export const AGENTS = ["claude", "codex", "grok"] as const;
export type AgentName = (typeof AGENTS)[number];

/** Session ids reach CLI argv after `--resume`; a leading `-` could be parsed as a flag. */
export const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

export const EFFORTS = ["low", "medium", "high"] as const;
export type Effort = (typeof EFFORTS)[number];

export interface AskRequest {
  readonly agent: AgentName;
  readonly question: string;
  readonly cwd: string;
  readonly model?: string;
  readonly effort?: Effort;
  /** Present for a follow-up in an existing advisor session. */
  readonly sessionId?: string;
}

export interface AskResult {
  readonly agent: AgentName;
  readonly answer: string;
  readonly sessionId: string;
  readonly model?: string;
  readonly durationMs: number;
}

export interface Invocation {
  readonly command: string;
  readonly args: readonly string[];
}

export interface Reply {
  readonly answer: string;
  readonly sessionId: string;
  readonly model?: string;
}

export interface RunOptions {
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  /** Combined stdout + stderr bytes after which the process is stopped. */
  readonly maxOutputBytes?: number;
  /** Streams stdout to this callback line by line instead of returning it: RunResult.stdout is then empty. */
  readonly onStdoutLine?: (line: string) => void;
}

/** Why run() killed the process, when it did. */
export type StopReason = "timeout" | "aborted" | "output_limit";

export interface RunResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number | null;
  readonly stopped?: StopReason;
}

export type Runner = (command: string, args: readonly string[], options: RunOptions) => Promise<RunResult>;

/** Turns an advice request into one headless, read-only CLI call and parses its output. */
export interface Adapter {
  readonly name: AgentName;
  readonly command: string;
  /** Computes extra args once per server process (e.g. which MCP servers to switch off). */
  prepare?(run: Runner, cwd: string, signal?: AbortSignal): Promise<readonly string[]>;
  build(request: AskRequest, prompt: string, extraArgs: readonly string[]): Invocation;
  /** Like build, but in a new session forked from `sourceSessionId`. The source session is only read. */
  fork(sourceSessionId: string, request: AskRequest, prompt: string, extraArgs: readonly string[]): Invocation;
  /** Throws when the output holds an error or no answer. */
  parse(stdout: string): Reply;
  /** For CLIs that stream JSONL: a one-line update for an output event worth reporting, if any. */
  describe?(event: Record<string, unknown>): string | undefined;
}

export const WORKERS = ["codex", "grok"] as const;
export type WorkerName = (typeof WORKERS)[number];

export interface TaskRequest {
  readonly agent: WorkerName;
  readonly task: string;
  readonly cwd: string;
  readonly model?: string;
  readonly effort?: Effort;
}

/** Turns a task into one headless CLI call that may edit files in the cwd, and narrates its streamed output. */
export interface Worker {
  readonly name: WorkerName;
  prepare?: Adapter["prepare"];
  build(request: TaskRequest, prompt: string, extraArgs: readonly string[]): Invocation;
  /** A one-line update for a streamed output event worth reporting, if any. */
  describe(event: Record<string, unknown>): string | undefined;
  /** Throws when the output holds an error or no final message. */
  parse(stdout: string): Reply;
}

export class AdvisorError extends Error {
  override readonly name = "AdvisorError";
}
