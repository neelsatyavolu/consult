import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { AdvisorError, type Adapter, type AskRequest, type Invocation, type Reply } from "../types.js";
import { parseJsonLines } from "../jsonl.js";

// agy (Google Antigravity CLI) has no per-call flags to restrict its tools or switch off MCP servers: --mode plan
// and --sandbox leave write, shell, browser and MCP tools enabled. Its only containment is its own config, so consult
// checks that before every call and refuses to run agy unless:
// - toolPermission is "request-review" (the default) or "strict": write, shell and URL-fetch tools then need approval,
//   which headless mode cannot ask for, so agy denies them. "strict" denies file reads as well, so it is of little use;
// - permissions.allow is empty: allow rules let commands run without that approval;
// - no MCP servers are enabled and no plugins are imported (plugins bring their own MCP servers);
// - no hooks, plugins or workspace customizations can load: hooks run commands and can approve any tool call.
const GEMINI_DIR = join(homedir(), ".gemini");
export const AGY_SETTINGS = join(GEMINI_DIR, "antigravity-cli", "settings.json");

/** Global places agy loads hooks and plugins from. */
const GLOBAL_CUSTOMIZATIONS = [
  join(GEMINI_DIR, "config", "hooks.json"),
  join(GEMINI_DIR, "config", "plugins.json"),
  join(GEMINI_DIR, "config", "plugins"),
  join(GEMINI_DIR, "antigravity-cli", "plugins"),
];
/** Customization roots agy honours in every directory from the cwd up to the project root. */
const WORKSPACE_ROOTS = [".agents", ".agent", "_agents", "_agent"];

// "always-proceed" and "proceed-in-sandbox" run tools without approval.
const REVIEWED = ["request-review", "strict"];
const LIST_OPTS = { timeoutMs: 30_000 } as const;
const NO_PLUGINS = /^No imported plugins\.?$/;

export interface AgyConfig {
  /** settings.json text; undefined when the file does not exist. */
  readonly settings: string | undefined;
  readonly mcpList: string;
  readonly pluginList: string;
  /** Hook, plugin and customization paths that exist and are not empty. */
  readonly customizations: readonly string[];
}

function settingsProblems(text: string | undefined): readonly string[] {
  let settings: unknown = {};
  if (text !== undefined) {
    try {
      settings = JSON.parse(text);
    } catch {
      return [`could not parse ${AGY_SETTINGS}`];
    }
  }
  if (typeof settings !== "object" || settings === null || Array.isArray(settings)) return [`${AGY_SETTINGS} is not a JSON object`];
  const { toolPermission, permissions } = settings as { toolPermission?: unknown; permissions?: { allow?: unknown } };
  const allow = permissions?.allow;
  return [
    ...(toolPermission === undefined || REVIEWED.includes(toolPermission as string)
      ? []
      : [`toolPermission is ${JSON.stringify(toolPermission)}, not "request-review"`]),
    ...(allow === undefined || (Array.isArray(allow) && allow.length === 0) ? [] : ["permissions.allow is not empty"]),
  ];
}

/** Names of MCP servers in an `agy mcp list` table whose status is not "disabled"; undefined if there is no table. */
function enabledMcpServers(out: string): readonly string[] | undefined {
  const [header, ...rows] = out.split("\n").filter((l) => l.trim());
  const typeCol = header?.indexOf("TYPE") ?? -1;
  const statusCol = header?.indexOf("STATUS") ?? -1;
  if (!header?.startsWith("NAME") || typeCol < 0 || statusCol < 0) return undefined;
  return rows.filter((row) => row.slice(statusCol).trim().split(/\s+/)[0] !== "disabled").map((row) => row.slice(0, typeCol).trim());
}

/** Why agy would not run read-only and MCP-free with this config. Empty when it would. */
export function containmentProblems(config: AgyConfig): readonly string[] {
  const servers = enabledMcpServers(config.mcpList);
  return [
    ...settingsProblems(config.settings),
    ...(servers === undefined ? ["could not read the output of `agy mcp list`"] : []),
    ...(servers?.length ? [`MCP servers enabled: ${servers.join(", ")}`] : []),
    ...(NO_PLUGINS.test(config.pluginList.trim()) ? [] : ["plugins are imported (see `agy plugin list`)"]),
    ...(config.customizations.length ? [`hooks or plugins could load from ${config.customizations.join(", ")}`] : []),
  ];
}

function readIfExists(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new AdvisorError(`could not read ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** A file with content, or a directory with entries. Unreadable paths count as present, so the check fails closed. */
function present(path: string): boolean {
  try {
    return statSync(path).isDirectory() ? readdirSync(path).length > 0 : readFileSync(path, "utf8").trim().length > 0;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

/** The cwd and its parents up to the nearest directory holding .git, or just the cwd outside a repository. */
function projectDirs(cwd: string): readonly string[] {
  const dirs: string[] = [];
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    dirs.push(dir);
    if (existsSync(join(dir, ".git"))) return dirs;
    if (dirname(dir) === dir) return [resolve(cwd)];
  }
}

/** Hook, plugin and customization paths agy would load for a call in `cwd`. */
export function findCustomizations(cwd: string, globals: readonly string[] = GLOBAL_CUSTOMIZATIONS): readonly string[] {
  const workspace = projectDirs(cwd).flatMap((dir) => WORKSPACE_ROOTS.map((name) => join(dir, name)));
  return [...globals, ...workspace].filter(present);
}

/** A prepare step that throws unless agy's current config keeps it read-only. It adds no args. */
export function agyPrepare(settingsFile: string, globals: readonly string[] = GLOBAL_CUSTOMIZATIONS): NonNullable<Adapter["prepare"]> {
  return async (run, cwd, signal) => {
    const list = async (what: string) => {
      const res = await run("agy", [what, "list"], { cwd, signal, ...LIST_OPTS });
      if (res.code !== 0) throw new AdvisorError(`could not run \`agy ${what} list\` to check containment: ${res.stderr.trim().slice(-500)}`);
      return res.stdout;
    };
    const problems = containmentProblems({
      settings: readIfExists(settingsFile),
      mcpList: await list("mcp"),
      pluginList: await list("plugin"),
      customizations: findCustomizations(cwd, globals),
    });
    if (problems.length > 0) {
      throw new AdvisorError(
        `agy's config is not read-only, so consult will not run it: ${problems.join("; ")}. ` +
          `Set "toolPermission": "request-review" and remove permissions.allow in ${settingsFile}, ` +
          "disable MCP servers with `agy mcp disable <name>`, and remove hooks and plugins.",
      );
    }
    return [];
  };
}

// agy ends the turn without an answer when a tool is denied, and it often reaches for a shell grep or cat first.
const TOOLS_NOTE = "Use only your file tools (view_file, grep_search, find_by_name, list_dir). Shell commands and URL fetches are denied here and would end your turn without an answer.";

function invocation(request: AskRequest, prompt: string): Invocation {
  return {
    command: "agy",
    args: [
      "-p", `${TOOLS_NOTE}\n\n${prompt}`,
      "--output-format", "stream-json",
      "--disable-slash-commands",
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

function parse(stdout: string): Reply {
  const result = parseJsonLines(stdout).findLast((e) => e.event === "result")?.result as AgyResult | undefined;
  if (!result) throw new AdvisorError(`agy returned no result: ${stdout.slice(0, 500)}`);
  if (result.status !== "SUCCESS") throw new AdvisorError(`agy reported an error: ${String(result.error || result.status || "unknown error")}`);
  if (typeof result.response !== "string" || !result.response.trim() || typeof result.conversation_id !== "string" || !result.conversation_id) {
    // agy ends the turn without an answer when it is denied a tool, so say which.
    const denied = (result.denied_actions ?? []).map((d) => String(d.action));
    throw new AdvisorError(denied.length ? `agy stopped without an answer after being denied: ${denied.join(", ")}` : "agy returned no answer");
  }
  return { answer: result.response.trimEnd(), sessionId: result.conversation_id };
}

interface StepUpdate {
  readonly step_type?: string;
  readonly state?: string;
  readonly tool_name?: string;
  readonly tool_info?: { readonly parameters?: Record<string, unknown>; readonly error?: { readonly message?: string } };
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
  prepare: agyPrepare(AGY_SETTINGS),

  build(request, prompt) {
    return invocation(request, prompt);
  },

  fork() {
    throw new AdvisorError("agy cannot fork live sessions");
  },

  parse,
  describe,
};
