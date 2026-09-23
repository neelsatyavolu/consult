import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AGENTS, type AgentName, type Runner } from "./types.js";

export interface AgentInfo {
  readonly agent: AgentName;
  readonly installed: boolean;
  readonly version?: string;
  readonly models?: readonly string[];
}

const CLAUDE_ALIASES = ["opus", "sonnet", "haiku", "fable"];

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

// Model lists come from each CLI's own cache, so they reflect what the signed-in account can use.
function knownModels(agent: AgentName): readonly string[] | undefined {
  if (agent === "claude") return CLAUDE_ALIASES;
  if (agent === "codex") {
    const cache = readJson(join(homedir(), ".codex", "models_cache.json")) as { models?: { slug?: string }[] } | undefined;
    return cache?.models?.flatMap((m) => (m.slug ? [m.slug] : []));
  }
  const cache = readJson(join(homedir(), ".grok", "models_cache.json")) as { models?: Record<string, unknown> } | undefined;
  return cache?.models ? Object.keys(cache.models) : undefined;
}

async function probe(run: Runner, agent: AgentName): Promise<AgentInfo> {
  try {
    const res = await run(agent, ["--version"], { cwd: homedir(), timeoutMs: 15_000 });
    if (res.code !== 0) return { agent, installed: false };
    const models = knownModels(agent);
    return { agent, installed: true, version: res.stdout.trim().split("\n")[0], ...(models ? { models } : {}) };
  } catch {
    return { agent, installed: false };
  }
}

export function listAgents(run: Runner): Promise<readonly AgentInfo[]> {
  return Promise.all(AGENTS.map((agent) => probe(run, agent)));
}
