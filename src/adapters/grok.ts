import { randomUUID } from "node:crypto";
import { AdvisorError, type Adapter } from "../types.js";
import { parseJsonLines } from "../jsonl.js";

// --tools keeps only read-only built-ins, but grok still adds its MCP meta-tools (search_tool/use_tool),
// which can reach write-capable MCP servers, so those are removed too. Grok's kernel sandbox is not used:
// it refuses to start on machines where /var/run/docker.sock is a symlink.
export const grok: Adapter = {
  name: "grok",
  command: "grok",

  build(request, prompt) {
    const session = request.sessionId ? ["--resume", request.sessionId] : ["--session-id", randomUUID()];
    return {
      command: "grok",
      args: [
        "--single", prompt,
        "--output-format", "streaming-messages-json",
        "--tools", "read_file,grep,list_dir",
        "--disallowed-tools", "Agent,search_tool,use_tool",
        ...session,
        ...(request.model ? ["--model", request.model] : []),
        ...(request.effort ? ["--reasoning-effort", request.effort] : []),
      ],
    };
  },

  parse(stdout) {
    const events = parseJsonLines(stdout);
    const result = events.findLast((e) => e.type === "result");
    if (!result) throw new AdvisorError(`grok returned no result: ${stdout.slice(0, 500)}`);
    if (result.is_error) throw new AdvisorError(`grok reported an error: ${String(result.result ?? "unknown error")}`);
    const model = events.find((e) => e.type === "system")?.model;
    if (typeof result.result !== "string" || !result.result || typeof result.session_id !== "string") {
      throw new AdvisorError("grok returned no answer");
    }
    return { answer: result.result, sessionId: result.session_id, ...(typeof model === "string" ? { model } : {}) };
  },
};
