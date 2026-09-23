import { accessSync, appendFileSync, constants, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { AGENTS, type AgentName, type Runner } from "./types.js";

const SYSTEM_PATH = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];

export const SERVER_NAME = "consult";
/** Codex's default MCP tool timeout is 60s; give it room beyond consult's own advisor timeout. */
export const CODEX_TOOL_TIMEOUT_SEC = 960;

export interface ServerCommand {
  readonly node: string;
  readonly script: string;
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

/** How hosts should launch the server: the node and agent CLIs from the installer's PATH, plus system dirs. */
export function serverCommand(script: string, searchPath: string): ServerCommand {
  const node = findOnPath("node", searchPath);
  if (!node) throw new Error("node not found on PATH");
  const binaries = [node, ...AGENTS.flatMap((agent) => findOnPath(agent, searchPath) ?? [])];
  const path = [...new Set([...binaries.map((b) => dirname(b)), ...SYSTEM_PATH])].join(delimiter);
  return { node, script, path };
}

export function codexTomlBlock({ node, script, path }: ServerCommand): string {
  const q = JSON.stringify;
  return [
    "",
    `[mcp_servers.${SERVER_NAME}]`,
    `command = ${q(node)}`,
    `args = [${q(script)}, "serve"]`,
    `tool_timeout_sec = ${CODEX_TOOL_TIMEOUT_SEC}`,
    `env = { PATH = ${q(path)} }`,
    "",
  ].join("\n");
}

async function installClaude(run: Runner, cmd: ServerCommand): Promise<string> {
  const opts = { cwd: homedir(), timeoutMs: 60_000 };
  if ((await run("claude", ["mcp", "get", SERVER_NAME], opts)).code === 0) return "claude: already registered";
  const res = await run(
    "claude",
    ["mcp", "add", SERVER_NAME, "--scope", "user", "-e", `PATH=${cmd.path}`, "--", cmd.node, cmd.script, "serve"],
    opts,
  );
  if (res.code !== 0) throw new Error(`claude mcp add failed: ${res.stderr.trim()}`);
  return "claude: registered (user scope)";
}

export function registerCodex(cmd: ServerCommand, configPath: string): string {
  mkdirSync(dirname(configPath), { recursive: true });
  const current = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
  if (current.includes(`[mcp_servers.${SERVER_NAME}]`)) return `codex: already registered in ${configPath}`;
  appendFileSync(configPath, codexTomlBlock(cmd));
  return `codex: registered in ${configPath} (tool_timeout_sec = ${CODEX_TOOL_TIMEOUT_SEC})`;
}

async function installGrok(run: Runner, cmd: ServerCommand): Promise<string> {
  const opts = { cwd: homedir(), timeoutMs: 60_000 };
  const list = await run("grok", ["mcp", "list", "--json"], opts);
  if (list.code === 0 && list.stdout.includes(`"${SERVER_NAME}"`)) return "grok: already registered";
  const res = await run(
    "grok",
    ["mcp", "add", SERVER_NAME, "-e", `PATH=${cmd.path}`, "--", cmd.node, cmd.script, "serve"],
    opts,
  );
  if (res.code !== 0) throw new Error(`grok mcp add failed: ${res.stderr.trim()}`);
  return "grok: registered (user scope)";
}

export interface InstallResult {
  readonly agent: AgentName;
  readonly ok: boolean;
  readonly message: string;
}

/** Registers the consult MCP server with each installed CLI. One CLI failing does not stop the others. */
export async function install(
  run: Runner,
  cmd: ServerCommand,
  installed: readonly AgentName[],
): Promise<readonly InstallResult[]> {
  const steps: Record<AgentName, () => Promise<string> | string> = {
    claude: () => installClaude(run, cmd),
    codex: () => registerCodex(cmd, join(homedir(), ".codex", "config.toml")),
    grok: () => installGrok(run, cmd),
  };
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
