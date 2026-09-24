import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { codexConfigPath, editConfig } from "./codex-config.js";
import { AGENTS, type AgentName, type Runner } from "./types.js";

const SYSTEM_PATH = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];

export const SERVER_NAME = "consult";
export const PACKAGE_NAME = "consult-mcp";
/** Codex's default MCP tool timeout is 60s; give it room beyond consult's own advisor timeout. */
export const CODEX_TOOL_TIMEOUT_SEC = 960;
/** Codex's default 10s startup timeout is too short for npx fetching a new release. */
export const CODEX_STARTUP_TIMEOUT_SEC = 60;

export { codexConfigPath, removeTomlTable } from "./codex-config.js";

// Package-runner caches that get cleaned up, so a host must never be pointed at a script inside one.
const NPX_CACHE = /[\\/]_npx[\\/]/;
const OTHER_RUNNER_CACHE = /[\\/](bunx-[^\\/]*|dlx-[^\\/]*|\.pnpm-store|\.yarn[\\/]berry)[\\/]/;

export interface ServerCommand {
  readonly command: string;
  readonly args: readonly string[];
  /** PATH for the server, so it finds the agent CLIs even when a host passes a minimal environment. */
  readonly path: string;
}

/** First executable named `name` on `searchPath`, without resolving symlinks (so version-manager shims keep working). */
export function findOnPath(name: string, searchPath: string): string | undefined {
  for (const dir of searchPath.split(delimiter).filter(Boolean)) {
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not here.
    }
  }
  return undefined;
}

/**
 * How hosts should launch the server. Run through `npx consult-mcp@latest install`, hosts launch it the same
 * way, so every new agent session picks up the newest release. Run from a checkout or a global install, hosts
 * launch that exact script.
 */
export function serverCommand(script: string, searchPath: string): ServerCommand {
  const node = findOnPath("node", searchPath);
  if (!node) throw new Error("node not found on PATH");
  if (OTHER_RUNNER_CACHE.test(script)) {
    throw new Error(`run install through npx (npx -y ${PACKAGE_NAME}@latest install) or a global install, not a temporary package runner`);
  }
  const viaNpx = NPX_CACHE.test(script);
  const npx = viaNpx ? findOnPath("npx", searchPath) : undefined;
  if (viaNpx && !npx) throw new Error("npx not found on PATH");
  const launcher = npx
    ? { command: npx, args: ["-y", `${PACKAGE_NAME}@latest`, "serve"] }
    : { command: node, args: [script, "serve"] };
  const binaries = [launcher.command, node, ...AGENTS.flatMap((agent) => findOnPath(agent, searchPath) ?? [])];
  const path = [...new Set([...binaries.map((b) => dirname(b)), ...SYSTEM_PATH])].join(delimiter);
  return { ...launcher, path };
}

export function codexTomlBlock({ command, args, path }: ServerCommand): string {
  const q = JSON.stringify;
  return [
    `[mcp_servers.${SERVER_NAME}]`,
    `command = ${q(command)}`,
    `args = [${args.map((a) => q(a)).join(", ")}]`,
    `startup_timeout_sec = ${CODEX_STARTUP_TIMEOUT_SEC}`,
    `tool_timeout_sec = ${CODEX_TOOL_TIMEOUT_SEC}`,
    `env = { PATH = ${q(path)} }`,
    "",
  ].join("\n");
}

export function registerCodex(cmd: ServerCommand, configPath: string): string {
  const existed = editConfig(configPath, codexTomlBlock(cmd));
  return `codex: ${existed ? "updated" : "registered"} in ${configPath} (tool_timeout_sec = ${CODEX_TOOL_TIMEOUT_SEC})`;
}

export function unregisterCodex(configPath: string): string {
  return editConfig(configPath, undefined) ? `codex: removed from ${configPath}` : `codex: not registered in ${configPath}`;
}

const CLI_OPTS = { cwd: homedir(), timeoutMs: 60_000 };

// Removing first makes install idempotent and upgrades registrations written by older versions.
async function registerWithCli(run: Runner, agent: "claude" | "grok", cmd: ServerCommand): Promise<string> {
  const removed = await run(agent, ["mcp", "remove", SERVER_NAME, "-s", "user"], CLI_OPTS);
  const scope = agent === "claude" ? ["--scope", "user"] : [];
  const res = await run(
    agent,
    ["mcp", "add", SERVER_NAME, ...scope, "-e", `PATH=${cmd.path}`, "--", cmd.command, ...cmd.args],
    CLI_OPTS,
  );
  if (res.code !== 0) throw new Error(`${agent} mcp add failed: ${res.stderr.trim()}`);
  return `${agent}: ${removed.code === 0 ? "updated" : "registered"} (user scope)`;
}

async function unregisterFromCli(run: Runner, agent: "claude" | "grok"): Promise<string> {
  const res = await run(agent, ["mcp", "remove", SERVER_NAME, "-s", "user"], CLI_OPTS);
  return res.code === 0 ? `${agent}: removed` : `${agent}: not registered (${res.stderr.trim()})`;
}

export interface InstallResult {
  readonly agent: AgentName;
  readonly ok: boolean;
  readonly message: string;
}

/** Runs one step per installed CLI. One CLI failing does not stop the others. */
async function forEachInstalled(
  installed: readonly AgentName[],
  steps: Record<AgentName, () => Promise<string> | string>,
): Promise<readonly InstallResult[]> {
  const results: InstallResult[] = [];
  for (const agent of AGENTS) {
    if (!installed.includes(agent)) {
      results.push({ agent, ok: true, message: `${agent}: not installed, skipped` });
      continue;
    }
    try {
      results.push({ agent, ok: true, message: await steps[agent]() });
    } catch (err) {
      results.push({ agent, ok: false, message: `${agent}: FAILED - ${err instanceof Error ? err.message : String(err)}` });
    }
  }
  return results;
}

/** Registers the consult MCP server with each installed CLI, replacing any earlier registration. */
export function install(run: Runner, cmd: ServerCommand, installed: readonly AgentName[]): Promise<readonly InstallResult[]> {
  return forEachInstalled(installed, {
    claude: () => registerWithCli(run, "claude", cmd),
    codex: () => registerCodex(cmd, codexConfigPath()),
    grok: () => registerWithCli(run, "grok", cmd),
  });
}

/** Removes the consult MCP server from each installed CLI. */
export function uninstall(run: Runner, installed: readonly AgentName[]): Promise<readonly InstallResult[]> {
  return forEachInstalled(installed, {
    claude: () => unregisterFromCli(run, "claude"),
    codex: () => unregisterCodex(codexConfigPath()),
    grok: () => unregisterFromCli(run, "grok"),
  });
}
