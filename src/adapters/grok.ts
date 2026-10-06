import { randomUUID } from "node:crypto";
import { AdvisorError, type Adapter, type AskRequest, type Invocation, type Reply, type Worker } from "../types.js";
import { parseJsonLines } from "../jsonl.js";
import { unwrapShell } from "../narrate.js";

// --tools keeps only read-only built-ins, but grok still adds its MCP meta-tools (search_tool/use_tool),
// which can reach write-capable MCP servers, so those are removed too. Grok's kernel sandbox is not used:
// it refuses to start on machines where /var/run/docker.sock is a symlink.
const ADVISOR_TOOLS = ["--tools", "read_file,grep,list_dir"] as const;
const NO_MCP = ["--disallowed-tools", "Agent,search_tool,use_tool"] as const;
// Workers also edit files and run shell commands, approved up front because nobody is there to approve.
// Without the kernel sandbox (see above), those commands are not confined to the cwd.
const WORKER_TOOLS = ["--tools", "read_file,grep,list_dir,search_replace,write_file,run_terminal_cmd", "--always-approve"] as const;

function invocation(
  tools: readonly string[],
  request: Pick<AskRequest, "model" | "effort">,
  prompt: string,
  session: readonly string[],
): Invocation {
  return {
    command: "grok",
    args: [
      "--single", prompt,
      "--output-format", "streaming-messages-json",
      ...tools,
      ...NO_MCP,
      ...session,
      ...(request.model ? ["--model", request.model] : []),
      ...(request.effort ? ["--reasoning-effort", request.effort] : []),
    ],
  };
}

function parse(stdout: string): Reply {
  const events = parseJsonLines(stdout);
  const result = events.findLast((e) => e.type === "result");
  if (!result) throw new AdvisorError(`grok returned no result: ${stdout.slice(0, 500)}`);
  if (result.is_error) throw new AdvisorError(`grok reported an error: ${String(result.result ?? "unknown error")}`);
  const model = events.find((e) => e.type === "system")?.model;
  if (typeof result.result !== "string" || !result.result || typeof result.session_id !== "string") {
    throw new AdvisorError("grok returned no answer");
  }
  return { answer: result.result, sessionId: result.session_id, ...(typeof model === "string" ? { model } : {}) };
}

interface ContentBlock {
  readonly type?: string;
  readonly text?: string;
  readonly name?: string;
  readonly input?: Record<string, unknown>;
}

function describeTool(name: string, input: Record<string, unknown> = {}): string {
  if (name === "run_terminal_cmd" && typeof input.command === "string") return `$ ${unwrapShell(input.command)}`;
  const target = Object.values(input).find((v): v is string => typeof v === "string");
  return target ? `${name} ${target}` : name;
}

function describe(event: Record<string, unknown>): string | undefined {
  if (event.type !== "assistant") return undefined;
  const content = (event.message as { content?: readonly ContentBlock[] } | undefined)?.content ?? [];
  const parts = content.flatMap((block) => {
    if (block.type === "text" && block.text?.trim()) return [block.text];
    if (block.type === "tool_use" && block.name) return [describeTool(block.name, block.input)];
    return [];
  });
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

export const grok: Adapter = {
  name: "grok",
  command: "grok",

  build(request, prompt) {
    return invocation(ADVISOR_TOOLS, request, prompt, request.sessionId ? ["--resume", request.sessionId] : ["--session-id", randomUUID()]);
  },

  fork(sourceSessionId, request, prompt) {
    return invocation(ADVISOR_TOOLS, request, prompt, ["--resume", sourceSessionId, "--fork-session"]);
  },

  parse,
  describe,
};

export const grokWorker: Worker = {
  name: "grok",

  build(request, prompt) {
    return invocation(WORKER_TOOLS, request, prompt, ["--session-id", randomUUID()]);
  },

  describe,
  parse,
};
