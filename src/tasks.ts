import { assertDirectory, assertExitedCleanly } from "./consult.js";
import { describeLine } from "./narrate.js";
import { frameTaskPrompt } from "./prompt.js";
import { AdvisorError, type Reply, type Runner, type TaskRequest, type Worker, type WorkerName } from "./types.js";

export type TaskState = "running" | "succeeded" | "failed" | "cancelled";

export interface TaskUpdate {
  /** Counts up from 1 within a task, so a caller can ask for only the updates after the last one it saw. */
  readonly seq: number;
  /** Milliseconds after the task started. */
  readonly atMs: number;
  readonly text: string;
}

export interface TaskView {
  readonly id: string;
  readonly agent: WorkerName;
  readonly task: string;
  readonly cwd: string;
  readonly state: TaskState;
  readonly startedAt: number;
  readonly finishedAt?: number;
  /** The most recent updates, oldest first. */
  readonly updates: readonly TaskUpdate[];
  readonly result?: Reply;
  readonly error?: string;
}

export interface TaskManagerDeps {
  readonly run: Runner;
  readonly workers: Readonly<Record<WorkerName, Worker>>;
  readonly timeoutMs: number;
  /** Aborting it stops every running task, e.g. when the server shuts down. */
  readonly signal?: AbortSignal;
  readonly now?: () => number;
}

export type TaskManager = ReturnType<typeof createTaskManager>;

const MAX_UPDATES = 200;
const MAX_FINISHED = 50;
// Workers can stream far more than an advisor answers with (codex events carry each command's full output), so
// they get a larger cap, and only lines short enough to hold a final message are kept for parse.
const MAX_TASK_OUTPUT_BYTES = 1024 * 1024 * 1024;
const MAX_KEPT_LINE_CHARS = 256 * 1024;

type Listener = (view: TaskView) => void;

interface Entry {
  readonly view: TaskView;
  readonly controller: AbortController;
  readonly listeners: Set<Listener>;
}

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Runs worker tasks in the background. Tasks live in memory only, so they end with the server process,
 * which stops their process groups on the way out.
 */
export function createTaskManager({ run, workers, timeoutMs, signal, now = Date.now }: TaskManagerDeps) {
  const entries = new Map<string, Entry>();
  let count = 0;

  function entry(id: string): Entry {
    const found = entries.get(id);
    if (!found) {
      throw new AdvisorError(`unknown task_id ${id}: tasks last as long as this consult server, which keeps the last ${MAX_FINISHED} finished ones`);
    }
    return found;
  }

  function change(id: string, update: (view: TaskView) => TaskView): void {
    const current = entries.get(id);
    if (!current) return;
    const view = update(current.view);
    entries.set(id, { ...current, view });
    for (const listener of current.listeners) {
      try {
        listener(view);
      } catch {
        // A failing listener must not change the task's outcome.
      }
    }
  }

  function narrate(id: string, worker: Worker, line: string): void {
    const text = describeLine((event) => worker.describe(event), line);
    if (!text) return;
    change(id, (view) => {
      const seq = (view.updates.at(-1)?.seq ?? 0) + 1;
      return { ...view, updates: [...view.updates, { seq, atMs: now() - view.startedAt, text }].slice(-MAX_UPDATES) };
    });
  }

  function finish(id: string, outcome: Pick<TaskView, "state" | "result" | "error">): void {
    change(id, (view) => ({ ...view, ...outcome, finishedAt: now() }));
  }

  async function execute(id: string, request: TaskRequest, abort: AbortSignal): Promise<void> {
    const worker = workers[request.agent];
    try {
      // Computed per task, never cached: containment must reflect the config as it is right now.
      const extraArgs = worker.prepare ? await worker.prepare(run, request.cwd, abort) : [];
      const { command, args } = worker.build(request, frameTaskPrompt(request.task), extraArgs);
      const kept: string[] = [];
      const res = await run(command, args, {
        cwd: request.cwd,
        timeoutMs,
        signal: abort,
        maxOutputBytes: MAX_TASK_OUTPUT_BYTES,
        onStdoutLine: (line) => {
          if (line.length <= MAX_KEPT_LINE_CHARS) kept.push(line);
          narrate(id, worker, line);
        },
      });
      const stdout = kept.join("\n");
      assertExitedCleanly(worker.name, { ...res, stdout }, timeoutMs);
      finish(id, { state: "succeeded", result: worker.parse(stdout) });
    } catch (err) {
      finish(id, abort.aborted ? { state: "cancelled" } : { state: "failed", error: errorMessage(err) });
    }
  }

  function prune(): void {
    const finished = [...entries.values()].filter((e) => e.view.state !== "running");
    for (const e of finished.slice(0, -MAX_FINISHED)) entries.delete(e.view.id);
  }

  /** Starts a task and returns at once; the worker keeps running in the background. */
  function start(request: TaskRequest): TaskView {
    if (!request.task.trim()) throw new AdvisorError("task must not be empty");
    assertDirectory(request.cwd);
    if (signal?.aborted) throw new AdvisorError("consult is shutting down");
    const id = `task-${++count}`;
    const controller = new AbortController();
    const view: TaskView = { id, agent: request.agent, task: request.task, cwd: request.cwd, state: "running", startedAt: now(), updates: [] };
    entries.set(id, { view, controller, listeners: new Set() });
    prune();
    void execute(id, request, signal ? AbortSignal.any([controller.signal, signal]) : controller.signal);
    return view;
  }

  const get = (id: string): TaskView => entry(id).view;

  /** Newest first. */
  const list = (): readonly TaskView[] => [...entries.values()].map((e) => e.view).reverse();

  /** Calls `listener` with the new view on every update and when the task finishes. */
  function subscribe(id: string, listener: Listener): () => void {
    const { listeners } = entry(id);
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  /** Resolves when the task finishes, `ms` passes (if given) or `abort` fires, whichever is first. */
  function wait(id: string, ms?: number, abort?: AbortSignal): Promise<TaskView> {
    const current = get(id);
    if (current.state !== "running" || ms === 0 || abort?.aborted) return Promise.resolve(current);
    return new Promise((resolve) => {
      let latest = current;
      const done = () => {
        clearTimeout(timer);
        unsubscribe();
        abort?.removeEventListener("abort", done);
        resolve(latest);
      };
      const timer = ms === undefined ? undefined : setTimeout(done, ms);
      const unsubscribe = subscribe(id, (view) => {
        latest = view;
        if (view.state !== "running") done();
      });
      abort?.addEventListener("abort", done, { once: true });
    });
  }

  /** Stops a running task and resolves once its process has exited. */
  function cancel(id: string): Promise<TaskView> {
    const { view, controller } = entry(id);
    if (view.state !== "running") return Promise.resolve(view);
    controller.abort();
    return wait(id);
  }

  return { start, get, list, subscribe, wait, cancel };
}
