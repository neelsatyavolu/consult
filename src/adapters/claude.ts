import { randomUUID } from "node:crypto";
import { AdvisorError, type Adapter } from "../types.js";

interface ClaudeResult {
  readonly is_error?: boolean;
  readonly result?: string;
  readonly session_id?: string;
  readonly modelUsage?: Record<string, unknown>;
}

// --restricted drops every tool that runs commands or code and confines file tools to the cwd;
// --strict-mcp-config with no --mcp-config loads no MCP servers, so the advisor cannot call consult back.
export const claude: Adapter = {
  name: "claude",
  command: "claude",

  build(request, prompt) {
    const session = request.sessionId ? ["--resume", request.sessionId] : ["--session-id", randomUUID()];
    return {
      command: "claude",
      args: [
        "-p",
        "--output-format", "json",
        "--restricted",
        "--tools", "Read,Grep,Glob",
        "--strict-mcp-config",
        ...session,
        ...(request.model ? ["--model", request.model] : []),
        ...(request.effort ? ["--effort", request.effort] : []),
        prompt,
      ],
    };
  },

  parse(stdout) {
    let out: ClaudeResult;
    try {
      out = JSON.parse(stdout) as ClaudeResult;
    } catch {
      throw new AdvisorError(`claude returned unreadable output: ${stdout.slice(0, 500)}`);
    }
    if (out.is_error) throw new AdvisorError(`claude reported an error: ${out.result ?? "unknown error"}`);
    if (!out.result || !out.session_id) throw new AdvisorError("claude returned no answer");
    const model = Object.keys(out.modelUsage ?? {})[0];
    return { answer: out.result, sessionId: out.session_id, ...(model ? { model } : {}) };
  },
};
