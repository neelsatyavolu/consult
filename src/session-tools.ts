import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { withProgress } from "./progress.js";
import type { SessionAnswer, SessionView } from "./sessions/service.js";
import { EFFORTS, SESSION_ID_PATTERN, type Effort } from "./types.js";

export interface SessionToolDeps {
  readonly list: () => readonly SessionView[];
  readonly ask: (sessionId: string, question: string, effort: Effort | undefined, signal?: AbortSignal) => Promise<SessionAnswer>;
}

export const SESSIONS_INSTRUCTIONS = `Live sessions are on. list_sessions shows other agent sessions running on this machine; ask_session asks a read-only copy of one of them, which knows that session's whole conversation.
Ask one when another agent has context you need: it wrote the code you are changing, or it works on the other side of an interface you share. The original session is not interrupted and never sees your question.`;

const LIST_DESCRIPTION = `List other AI coding agent sessions (Claude Code, Codex, Grok) running live on this machine that you can ask with ask_session: agent, session_id, directory, git branch, title, and when each started and was last active. Only sessions allowed by the user's live-sessions scope are shown.`;

const ASK_DESCRIPTION = `Ask a question of a live session from list_sessions. consult forks that session into a read-only copy, so the answer draws on everything the session has seen and done; the original keeps working and never sees your question.
The copy runs headless and read-only: it cannot edit files or change anything. It replays the session's conversation, so it can take longer than ask_agent. The reply includes the copy's session_id and cwd: pass both, with the same agent, to ask_agent for a follow-up.`;

// Forks only read files; replies differ between calls and come from the session's model provider.
const FORK_HINTS = { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

function footer(result: SessionAnswer): string {
  return [
    `agent: ${result.agent}`,
    ...(result.model ? [`model: ${result.model}`] : []),
    `forked from: ${result.source}`,
    `session_id: ${result.sessionId}`,
    `cwd: ${result.cwd}`,
    `${(result.durationMs / 1000).toFixed(1)}s`,
  ].join(" · ");
}

export function registerSessionTools(server: McpServer, deps: SessionToolDeps, progressIntervalMs: number): void {
  server.registerTool(
    "list_sessions",
    {
      title: "List live sessions",
      description: LIST_DESCRIPTION,
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async () => {
      try {
        const sessions = deps.list();
        const body = sessions.length > 0 ? JSON.stringify(sessions, null, 2) : "No other live sessions in scope.";
        return { content: [{ type: "text", text: body }], structuredContent: { sessions } };
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: errorMessage(err) }] };
      }
    },
  );

  server.registerTool(
    "ask_session",
    {
      title: "Ask a live session",
      description: ASK_DESCRIPTION,
      inputSchema: {
        session_id: z.string().regex(SESSION_ID_PATTERN).describe("session_id from list_sessions"),
        question: z
          .string()
          .min(1)
          .describe("The question. The copy knows its own session's conversation but not yours, so include what it needs to know about your side"),
        effort: z.enum(EFFORTS).optional().describe("Reasoning effort. Omit for the CLI's default"),
      },
      annotations: FORK_HINTS,
    },
    async (args, extra) => {
      try {
        const work = deps.ask(args.session_id, args.question, args.effort, extra.signal);
        const result = await withProgress(extra, progressIntervalMs, (s) => `asking a copy of ${args.session_id} (${s}s)`, work);
        return {
          content: [
            {
              type: "text",
              text: `${result.answer}\n\n---\n${footer(result)}\nFor a follow-up, call ask_agent with this agent, session_id and cwd.`,
            },
          ],
          structuredContent: {
            agent: result.agent,
            answer: result.answer,
            session_id: result.sessionId,
            source_session_id: result.source,
            cwd: result.cwd,
            ...(result.model ? { model: result.model } : {}),
            duration_ms: result.durationMs,
          },
        };
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: errorMessage(err) }] };
      }
    },
  );
}
