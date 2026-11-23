import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { AdvisorError, type Adapter, type AskRequest, type Invocation, type Reply } from "../types.js";
import { parseJsonLines } from "../jsonl.js";

// agy (Google Antigravity CLI) has no flags that remove tools, but --settings overrides settings.json for one
// session, and permission deny rules beat everything else: toolPermission, allow rules (global or ours) and
// PreToolUse hooks that answer "allow". Every call passes these rules, so containment does not depend on the
// user's own agy config. Covered: shell commands and run_workflow's Python (command), file writes and edits
// (write_file), MCP tools including plugin servers (mcp), and URL reads, downloads and opens; subagents inherit them.
// MCP servers still start, but none of their tools can be called. agy rejects "unsandboxed" rules from users, and
// the browser needs the /browser slash command, which --disable-slash-commands turns off. toolPermission
// "request-review" and an empty allow list are belt and braces: request-review alone lets headless agy write files.
const DENY = ["command(*)", "write_file(*)", "mcp(*)", "read_url(*)", "download_url(*)", "execute_url(*)"] as const;
export const CONTAINMENT_SETTINGS = JSON.stringify({ toolPermission: "request-review", permissions: { allow: [], deny: DENY } });

/** The oldest agy these deny rules were verified against. Older versions are refused rather than trusted. */
export const MIN_AGY_VERSION = "1.5.14";

// Hooks still run their commands for every tool call, and --settings cannot switch them off. The user's own global
// hooks are theirs to run, but a repository's hooks and plugins would run code from whatever repo the advisor is
// pointed at, so consult refuses to run agy where they exist. agy reads them from these roots in every directory
// from the cwd up to the project root.
const WORKSPACE_ROOTS = [".agents", ".agent", "_agents", "_agent"];
const WORKSPACE_HOOKS = ["hooks.json", "plugins.json", "plugins"];
const VERSION_OPTS = { timeoutMs: 30_000 } as const;

/** A non-empty file, or a directory with entries. Unreadable paths count as present, so the check fails closed. */
function present(path: string): boolean {
  try {
    const stat = statSync(path);
    return stat.isDirectory() ? readdirSync(path).length > 0 : stat.size > 0;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

/** The real cwd and its parents up to the nearest directory holding .git, or just the cwd outside a repository. */
function projectDirs(cwd: string): readonly string[] {
  // agy runs in the real directory, so walk its parents rather than those of a symlink pointing into a repository.
  const start = realpathSync(resolve(cwd));
  const dirs: string[] = [];
  for (let dir = start; ; dir = dirname(dir)) {
    dirs.push(dir);
    if (existsSync(join(dir, ".git"))) return dirs;
    if (dirname(dir) === dir) return [start];
  }
}

/** Repository hook and plugin paths agy would load for a call in `cwd`. */
export function findWorkspaceHooks(cwd: string): readonly string[] {
  return projectDirs(cwd)
    .flatMap((dir) => WORKSPACE_ROOTS.flatMap((root) => WORKSPACE_HOOKS.map((name) => join(dir, root, name))))
    .filter(present);
}

/** True when `version` (e.g. "1.5.14" or "agy 1.5.14", a release, not a prerelease) is at least `min`. */
export function versionAtLeast(version: string, min: string): boolean {
  const parse = (v: string) => v.trim().match(/^(?:agy\s+)?(\d+)\.(\d+)\.(\d+)$/)?.slice(1).map(Number);
  const have = parse(version);
  const want = parse(min)!;
  if (!have) return false;
  const diff = have.map((n, i) => n - want[i]!).find((d) => d !== 0) ?? 0;
  return diff >= 0;
}

/** Throws unless agy is new enough for the deny rules and no repository hooks or plugins would load. Adds no args. */
const prepare: NonNullable<Adapter["prepare"]> = async (run, cwd, signal) => {
  const res = await run("agy", ["--version"], { cwd, signal, ...VERSION_OPTS });
  const version = res.stdout.trim();
  if (res.code !== 0 || !versionAtLeast(version, MIN_AGY_VERSION)) {
    throw new AdvisorError(
      `consult needs agy ${MIN_AGY_VERSION} or later to keep it read-only (found ${version || "no version"}); run \`agy update\``,
    );
  }
  const hooks = findWorkspaceHooks(cwd);
  if (hooks.length > 0) {
    throw new AdvisorError(
      `consult will not run agy here: this repository has agy hooks or plugins, which would run its commands (${hooks.join(", ")})`,
    );
  }
  return [];
};

// The model cannot see the deny rules, and `schedule` or background waits hold a headless turn open until timeout.
const TOOLS_NOTE =
  "You are advising read-only. Use read_file to read files and directories. Shell commands, file writes and edits, URL reads and MCP tools are denied here. Do not use schedule, wait or background tasks.";

function invocation(request: AskRequest, prompt: string): Invocation {
  return {
    command: "agy",
    args: [
      "-p", `${TOOLS_NOTE}\n\n${prompt}`,
      "--output-format", "stream-json",
      "--disable-slash-commands",
      "--settings", CONTAINMENT_SETTINGS,
      ...(request.sessionId ? ["--conversation", request.sessionId] : []),
      ...(request.model ? ["--model", request.model] : []),
      ...(request.effort ? ["--effort", request.effort] : []),
    ],
  };
}

interface AgyResult {
  readonly conversation_id?: unknown;
  readonly status?: unknown;
  readonly response?: unknown;
  readonly error?: unknown;
  readonly denied_actions?: readonly { readonly action?: unknown }[];
}

interface StepUpdate {
  readonly step_type?: string;
  readonly state?: string;
  readonly tool_name?: string;
  readonly tool_info?: { readonly parameters?: Record<string, unknown>; readonly error?: { readonly message?: string } };
}

const HOOK_DENIAL = "denied by pre-tool hook";
const READ_TOOLS = new Set(["read_file", "view_file", "list_dir", "grep_search", "find_by_name"]);

/**
 * Read tools a PreToolUse hook denied, when no read got through. A hook that prints `{}` denies every tool call,
 * reads included; an answer written after that was written blind. A hook that blocks only some files is left alone.
 */
function blindedByHook(events: readonly Record<string, unknown>[]): readonly string[] {
  const reads = events.flatMap((e) => {
    const step = e.step_update as StepUpdate | undefined;
    return step?.step_type === "tool" && step.tool_name && READ_TOOLS.has(step.tool_name) ? [step] : [];
  });
  if (reads.some((step) => step.state === "DONE")) return [];
  const denied = reads.filter((step) => step.tool_info?.error?.message?.includes(HOOK_DENIAL)).map((step) => step.tool_name!);
  return [...new Set(denied)];
}

function parse(stdout: string): Reply {
  const events = parseJsonLines(stdout);
  const result = events.findLast((e) => e.event === "result")?.result as AgyResult | undefined;
  if (!result) throw new AdvisorError(`agy returned no result: ${stdout.slice(0, 500)}`);
  if (result.status !== "SUCCESS") throw new AdvisorError(`agy reported an error: ${String(result.error || result.status || "unknown error")}`);
  const hooked = blindedByHook(events);
  if (hooked.length > 0) {
    // The answer would be written without the files it tried to read, so it is not worth returning.
    throw new AdvisorError(
      `an agy hook denied ${hooked.join(", ")}, so agy could not read the repository. ` +
        "Check the PreToolUse hooks in ~/.gemini/config/hooks.json and agy plugins: a hook that prints {} denies every tool; it should print nothing to leave the decision to agy.",
    );
  }
  if (typeof result.response !== "string" || !result.response.trim() || typeof result.conversation_id !== "string" || !result.conversation_id) {
    const denied = (result.denied_actions ?? []).map((d) => String(d.action));
    throw new AdvisorError(denied.length ? `agy stopped without an answer after being denied: ${denied.join(", ")}` : "agy returned no answer");
  }
  return { answer: result.response.trimEnd(), sessionId: result.conversation_id };
}

function describeTool(name: string, params: Record<string, unknown> = {}): string {
  if (name === "run_command" && typeof params.CommandLine === "string") return `$ ${params.CommandLine}`;
  const target = Object.values(params).find((v): v is string => typeof v === "string");
  return target ? `${name} ${target}` : name;
}

function describe(event: Record<string, unknown>): string | undefined {
  const step = event.step_update as StepUpdate | undefined;
  if (event.event !== "step_update" || step?.step_type !== "tool" || !step.tool_name) return undefined;
  if (step.state === "ACTIVE") return describeTool(step.tool_name, step.tool_info?.parameters);
  if (step.state === "ERROR") return `${step.tool_name} failed: ${step.tool_info?.error?.message ?? "unknown error"}`;
  return undefined;
}

export const agy: Adapter = {
  name: "agy",
  command: "agy",
  prepare,

  build(request, prompt) {
    return invocation(request, prompt);
  },

  fork() {
    throw new AdvisorError("agy cannot fork live sessions");
  },

  parse,
  describe,
};
