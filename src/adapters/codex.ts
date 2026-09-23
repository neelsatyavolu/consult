import { AdvisorError, type Adapter } from "../types.js";
import { parseJsonLines } from "../jsonl.js";

const PLUGINS_OFF = ["-c", "features.plugins=false"] as const;

// Codex runs MCP tools outside its shell sandbox, so the advisor gets none: plugins are switched off
// (they bring their own MCP servers) and every server still enabled is disabled by name.
// That includes consult itself, which is what stops advisors from consulting each other in a loop.
async function listEnabledMcpServers(run: Parameters<NonNullable<Adapter["prepare"]>>[0], cwd: string) {
  const res = await run("codex", ["mcp", "list", "--json", ...PLUGINS_OFF], { cwd, timeoutMs: 30_000 });
  if (res.code !== 0) {
    throw new AdvisorError(`could not list codex MCP servers to disable them: ${res.stderr.trim().slice(-500)}`);
  }
  const servers = JSON.parse(res.stdout) as { name: string; enabled: boolean }[];
  return servers.filter((s) => s.enabled).map((s) => s.name);
}

export const codex: Adapter = {
  name: "codex",
  command: "codex",

  async prepare(run, cwd) {
    const names = await listEnabledMcpServers(run, cwd);
    return [...PLUGINS_OFF, ...names.flatMap((n) => ["-c", `mcp_servers.${n}.enabled=false`])];
  },

  build(request, prompt, extraArgs) {
    const config = [
      "-c", 'sandbox_mode="read-only"',
      "-c", 'approval_policy="never"',
      ...(request.model ? ["-c", `model=${JSON.stringify(request.model)}`] : []),
      ...(request.effort ? ["-c", `model_reasoning_effort="${request.effort}"`] : []),
      ...extraArgs,
    ];
    const head = request.sessionId ? ["exec", "resume", "--json"] : ["exec", "--json"];
    const tail = request.sessionId ? [request.sessionId, prompt] : [prompt];
    return { command: "codex", args: [...head, "--skip-git-repo-check", ...config, ...tail] };
  },

  parse(stdout) {
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
  },
};
