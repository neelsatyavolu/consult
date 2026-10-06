import { AdvisorError, type Adapter, type AskRequest, type Reply, type Worker } from "../types.js";
import { parseJsonLines } from "../jsonl.js";
import { unwrapShell } from "../narrate.js";

const PLUGINS_OFF = ["-c", "features.plugins=false"] as const;

const READ_ONLY = ["-c", 'sandbox_mode="read-only"'] as const;
// Workers may edit files under the cwd (and temp dirs) and run commands there, without network access. Extra
// writable roots from the user's config are dropped.
const WORKSPACE_WRITE = [
  "-c", 'sandbox_mode="workspace-write"',
  "-c", "sandbox_workspace_write.network_access=false",
  "-c", "sandbox_workspace_write.writable_roots=[]",
] as const;

// Codex runs MCP tools outside its shell sandbox, so advisors and workers get none: plugins are switched off
// (they bring their own MCP servers) and every server still enabled is disabled by name.
// That includes consult itself, which is what stops agents from consulting each other in a loop.
async function listEnabledMcpServers(run: Parameters<NonNullable<Adapter["prepare"]>>[0], cwd: string, signal?: AbortSignal) {
  const res = await run("codex", ["mcp", "list", "--json", ...PLUGINS_OFF], { cwd, timeoutMs: 30_000, signal });
  if (res.code !== 0) {
    throw new AdvisorError(`could not list codex MCP servers to disable them: ${res.stderr.trim().slice(-500)}`);
  }
  const servers = JSON.parse(res.stdout) as { name: string; enabled: boolean }[];
  return servers.filter((s) => s.enabled).map((s) => s.name);
}

const prepare: NonNullable<Adapter["prepare"]> = async (run, cwd, signal) => {
  const names = await listEnabledMcpServers(run, cwd, signal);
  return [...PLUGINS_OFF, ...names.flatMap((n) => ["-c", `mcp_servers.${n}.enabled=false`])];
};

function configArgs(
  sandbox: readonly string[],
  request: Pick<AskRequest, "model" | "effort">,
  extraArgs: readonly string[],
): readonly string[] {
  return [
    ...sandbox,
    "-c", 'approval_policy="never"',
    ...(request.model ? ["-c", `model=${JSON.stringify(request.model)}`] : []),
    ...(request.effort ? ["-c", `model_reasoning_effort="${request.effort}"`] : []),
    ...extraArgs,
  ];
}

function parse(stdout: string): Reply {
  const events = parseJsonLines(stdout);
  const failure = events.find((e) => e.type === "turn.failed" || e.type === "error");
  if (failure) {
    const message = (failure.error as { message?: string } | undefined)?.message ?? failure.message;
    throw new AdvisorError(`codex reported an error: ${String(message ?? "unknown error")}`);
  }
  const threadId = events.find((e) => e.type === "thread.started")?.thread_id;
  const answer = events
    .filter((e) => e.type === "item.completed")
    .map((e) => e.item as { type?: string; text?: string })
    .filter((item) => item.type === "agent_message" && item.text)
    .at(-1)?.text;
  if (!answer || typeof threadId !== "string") throw new AdvisorError("codex returned no answer");
  return { answer, sessionId: threadId };
}

interface CodexItem {
  readonly type?: string;
  readonly text?: string;
  readonly command?: string;
  readonly exit_code?: number | null;
  readonly changes?: readonly { readonly path?: string; readonly kind?: string }[];
}

function describe(event: Record<string, unknown>): string | undefined {
  const item = event.item as CodexItem | undefined;
  if (!item) return undefined;
  if (event.type === "item.started" && item.type === "command_execution" && item.command) return `$ ${unwrapShell(item.command)}`;
  if (event.type !== "item.completed") return undefined;
  switch (item.type) {
    case "command_execution":
      return item.exit_code && item.command ? `exit ${item.exit_code}: ${unwrapShell(item.command)}` : undefined;
    case "file_change":
      return item.changes?.map((c) => `${c.kind ?? "edit"} ${c.path ?? "?"}`).join(", ");
    case "agent_message":
      return item.text;
    default:
      return undefined;
  }
}

export const codex: Adapter = {
  name: "codex",
  command: "codex",
  prepare,

  build(request, prompt, extraArgs) {
    const head = request.sessionId ? ["exec", "resume", "--json"] : ["exec", "--json"];
    const tail = request.sessionId ? [request.sessionId, prompt] : [prompt];
    return { command: "codex", args: [...head, "--skip-git-repo-check", ...configArgs(READ_ONLY, request, extraArgs), ...tail] };
  },

  // exec fork starts a new thread from the source's history; the source rollout is only read.
  fork(sourceSessionId, request, prompt, extraArgs) {
    return {
      command: "codex",
      args: ["exec", "fork", "--json", "--skip-git-repo-check", ...configArgs(READ_ONLY, request, extraArgs), sourceSessionId, prompt],
    };
  },

  parse,
  describe,
};

export const codexWorker: Worker = {
  name: "codex",
  prepare,

  build(request, prompt, extraArgs) {
    return { command: "codex", args: ["exec", "--json", "--skip-git-repo-check", ...configArgs(WORKSPACE_WRITE, request, extraArgs), prompt] };
  },

  describe,
  parse,
};
