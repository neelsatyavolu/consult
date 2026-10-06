import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { oneLine } from "./narrate.js";
import { progressSender, withProgress } from "./progress.js";
import type { TaskManager, TaskUpdate, TaskView } from "./tasks.js";
import { EFFORTS, WORKERS } from "./types.js";

export const TASKS_INSTRUCTIONS = `Task dispatch is on. dispatch_task hands a coding task to a Codex or Grok worker that edits files in the working directory in the background; task_status reports its progress and final report, and cancel_task stops it.
Dispatch work that is well defined and separable from yours, such as tests for a module or a mechanical refactor, and keep working meanwhile. Do not edit the files a running worker is changing.
The worker cannot see your conversation or ask you questions: state the goal, the files involved, the constraints and how to verify. Review its changes (git diff) before building on them.`;

const DISPATCH_DESCRIPTION = `Start a Codex or Grok agent on a coding task in the background, using the CLIs signed in on this machine. Returns a task_id at once.
The worker runs headless in the working directory and can edit files and run commands there (codex in its workspace-write sandbox without network; grok without a sandbox). It has no MCP servers and cannot ask you anything, so make the task self-contained: goal, relevant files, constraints, how to verify.
Follow it with task_status: pass wait_sec to block until it finishes, with live progress updates meanwhile.`;

const STATUS_DESCRIPTION = `Show a dispatched task's state, its latest progress updates (commands run, files edited, messages) and, once finished, the worker's final report. Without task_id, lists all tasks.
Pass wait_sec to wait for the task to finish (returns early when it does), and since (the last update seq you saw) to get only newer updates.`;

const CANCEL_DESCRIPTION = "Stop a running task and its worker process. Files it already changed stay changed.";

const MAX_WAIT_SEC = 600;
const DEFAULT_UPDATES = 20;

const taskIdSchema = z.string().min(1).describe("task_id returned by dispatch_task");

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));
const seconds = (ms: number) => `${Math.round(ms / 1000)}s`;
const elapsed = (view: TaskView) => (view.finishedAt ?? Date.now()) - view.startedAt;
const lastSeq = (view: TaskView) => view.updates.at(-1)?.seq ?? 0;

function selectUpdates(view: TaskView, since: number | undefined): readonly TaskUpdate[] {
  return since === undefined ? view.updates.slice(-DEFAULT_UPDATES) : view.updates.filter((u) => u.seq > since);
}

/** Whether updates after `since` were already dropped from the task's history. */
const missedUpdates = (view: TaskView, since: number | undefined) =>
  since !== undefined && (view.updates[0]?.seq ?? 0) > since + 1;

const formatUpdate = (u: TaskUpdate) => `[${seconds(u.atMs)}] ${u.text}`;
const headline = (view: TaskView) => `${view.id} · ${view.agent} · ${view.state} · ${seconds(elapsed(view))}`;

function structured(view: TaskView, updates: readonly TaskUpdate[], since?: number) {
  return {
    task_id: view.id,
    agent: view.agent,
    state: view.state,
    cwd: view.cwd,
    elapsed_ms: elapsed(view),
    updates: updates.map((u) => ({ seq: u.seq, at_ms: u.atMs, text: u.text })),
    last_seq: lastSeq(view),
    ...(missedUpdates(view, since) ? { earlier_updates_dropped: true } : {}),
    ...(view.result
      ? { result: { report: view.result.answer, session_id: view.result.sessionId, ...(view.result.model ? { model: view.result.model } : {}) } }
      : {}),
    ...(view.error ? { error: view.error } : {}),
  };
}

function formatTask(view: TaskView, updates: readonly TaskUpdate[], since?: number): string {
  const lines = [headline(view), `cwd: ${view.cwd}`, `task: ${oneLine(view.task, 120)}`];
  if (updates.length > 0) {
    const note = missedUpdates(view, since) ? " (some earlier ones were dropped)" : "";
    lines.push("", `Updates${note}:`, ...updates.map(formatUpdate));
  }
  if (view.state === "running") {
    lines.push("", `Still running. Call task_status again with since=${lastSeq(view)} for newer updates, or wait_sec to wait.`);
  } else if (view.result) {
    const model = view.result.model ? ` · model: ${view.result.model}` : "";
    lines.push("", "Report:", view.result.answer, "", "---", `session_id: ${view.result.sessionId}${model}`);
    lines.push("Review the changes before relying on them. For a read-only follow-up, pass this agent and session_id to ask_agent.");
  } else if (view.error) {
    lines.push("", `Failed: ${view.error}`);
  }
  return lines.join("\n");
}

function formatList(views: readonly TaskView[]): string {
  if (views.length === 0) return "No tasks yet.";
  return views.map((v) => `${headline(v)} · ${oneLine(v.task, 80)}`).join("\n");
}

export function registerTaskTools(server: McpServer, tasks: TaskManager, defaultCwd: string, progressIntervalMs: number): void {
  server.registerTool(
    "dispatch_task",
    {
      title: "Dispatch a task",
      description: DISPATCH_DESCRIPTION,
      inputSchema: {
        agent: z.enum(WORKERS).describe("Which CLI does the work"),
        task: z.string().min(1).describe("The task, self-contained: goal, relevant files, constraints, how to verify"),
        model: z.string().optional().describe("Model for that CLI. Omit for the CLI's default; list_agents shows options"),
        effort: z.enum(EFFORTS).optional().describe("Reasoning effort. Omit for the CLI's default"),
        cwd: z.string().optional().describe("Directory the worker works in. Defaults to the directory this server was started in"),
      },
      // Workers write files and run commands; each dispatch starts new work.
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        const view = tasks.start({ agent: args.agent, task: args.task, cwd: args.cwd ?? defaultCwd, model: args.model, effort: args.effort });
        const text = `Dispatched ${view.id} to ${view.agent} in ${view.cwd}.\nCall task_status with task_id "${view.id}" for progress; pass wait_sec (up to ${MAX_WAIT_SEC}) to wait for the report.`;
        return { content: [{ type: "text", text }], structuredContent: structured(view, []) };
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: errorMessage(err) }] };
      }
    },
  );

  server.registerTool(
    "task_status",
    {
      title: "Task status",
      description: STATUS_DESCRIPTION,
      inputSchema: {
        task_id: taskIdSchema.optional(),
        wait_sec: z.number().int().min(0).max(MAX_WAIT_SEC).optional().describe("Wait up to this many seconds for the task to finish. Default 0"),
        since: z.number().int().min(0).optional().describe("Only return updates after this seq (last_seq from an earlier call)"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args, extra) => {
      try {
        if (args.task_id === undefined) {
          const views = tasks.list();
          return { content: [{ type: "text", text: formatList(views) }], structuredContent: { tasks: views.map((v) => structured(v, [])) } };
        }
        const initial = tasks.get(args.task_id);
        const send = progressSender(extra);
        // Relay each new update as it arrives, alongside withProgress's heartbeat.
        let relayed = args.since ?? lastSeq(initial);
        const unsubscribe = send
          ? tasks.subscribe(initial.id, (view) => {
              for (const u of view.updates.filter((u) => u.seq > relayed)) send(formatUpdate(u));
              relayed = Math.max(relayed, lastSeq(view));
            })
          : () => {};
        const heartbeat = () => `${initial.id} (${initial.agent}) working, ${seconds(elapsed(initial))}`;
        let view: TaskView;
        try {
          const work = tasks.wait(initial.id, (args.wait_sec ?? 0) * 1000, extra.signal);
          view = await withProgress(extra, progressIntervalMs, heartbeat, work, send);
        } finally {
          unsubscribe();
        }
        const updates = selectUpdates(view, args.since);
        return {
          content: [{ type: "text", text: formatTask(view, updates, args.since) }],
          structuredContent: structured(view, updates, args.since),
        };
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: errorMessage(err) }] };
      }
    },
  );

  server.registerTool(
    "cancel_task",
    {
      title: "Cancel a task",
      description: CANCEL_DESCRIPTION,
      inputSchema: { task_id: taskIdSchema },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        const view = await tasks.cancel(args.task_id);
        const updates = selectUpdates(view, undefined);
        return { content: [{ type: "text", text: formatTask(view, updates) }], structuredContent: structured(view, updates) };
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: errorMessage(err) }] };
      }
    },
  );
}
