import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AgentInfo } from "./agents.js";
import { AGENTS, EFFORTS, type AskRequest, type AskResult } from "./types.js";

export interface ServerDeps {
  readonly ask: (request: AskRequest, signal?: AbortSignal) => Promise<AskResult>;
  readonly listAgents: () => Promise<readonly AgentInfo[]>;
  readonly defaultCwd: string;
}

const ASK_DESCRIPTION = `Ask another AI coding agent (Claude Code, Codex or Grok, using the CLIs signed in on this machine) for advice: a second opinion on a design, a review of your plan, help with a bug you are stuck on.
The advisor runs headless with read-only access to the working directory, so point it at files instead of pasting them. It cannot edit files or ask you questions.
Calls take from several seconds to a few minutes. The reply includes a session_id: pass it back to ask a follow-up in the same conversation.`;

function formatReply(result: AskResult): string {
  const meta = [
    `agent: ${result.agent}`,
    ...(result.model ? [`model: ${result.model}`] : []),
    `session_id: ${result.sessionId}`,
    `${(result.durationMs / 1000).toFixed(1)}s`,
  ].join(" · ");
  return `${result.answer}\n\n---\n${meta}\nPass session_id to ask a follow-up in the same conversation.`;
}

export function createServer({ ask, listAgents, defaultCwd }: ServerDeps): McpServer {
  const server = new McpServer({ name: "consult", version: "0.1.0" });

  server.registerTool(
    "ask_agent",
    {
      title: "Ask another agent",
      description: ASK_DESCRIPTION,
      inputSchema: {
        agent: z.enum(AGENTS).describe("Which CLI to consult"),
        question: z.string().min(1).describe("The question, with enough context to answer it (file paths, what you tried, constraints)"),
        model: z.string().optional().describe("Model for that CLI, e.g. gpt-6-astra, opus, grok-4.7. Omit for the CLI's default; list_agents shows options"),
        effort: z.enum(EFFORTS).optional().describe("Reasoning effort. Omit for the CLI's default"),
        session_id: z.string().optional().describe("session_id from an earlier reply, to ask a follow-up"),
        cwd: z.string().optional().describe("Directory the advisor can read. Defaults to the directory this server was started in"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args, extra) => {
      try {
        const result = await ask({
          agent: args.agent,
          question: args.question,
          cwd: args.cwd ?? defaultCwd,
          model: args.model,
          effort: args.effort,
          sessionId: args.session_id,
        }, extra.signal);
        return {
          content: [{ type: "text", text: formatReply(result) }],
          structuredContent: {
            agent: result.agent,
            answer: result.answer,
            session_id: result.sessionId,
            ...(result.model ? { model: result.model } : {}),
            duration_ms: result.durationMs,
          },
        };
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }] };
      }
    },
  );

  server.registerTool(
    "list_agents",
    {
      title: "List agents",
      description: "Show which agent CLIs are installed on this machine, their versions and the models you can pass to ask_agent.",
      annotations: { readOnlyHint: true },
    },
    async () => {
      const agents = await listAgents();
      return { content: [{ type: "text", text: JSON.stringify(agents, null, 2) }], structuredContent: { agents } };
    },
  );

  return server;
}
