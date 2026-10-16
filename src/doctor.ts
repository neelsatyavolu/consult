import type { AgentInfo } from "./agents.js";
import { messagesOn, type Settings } from "./settings.js";
import { HOSTS, type AgentName, type AskResult, type HostName } from "./types.js";

export type CheckStatus = "ok" | "warn" | "fail";

export interface Check {
  readonly status: CheckStatus;
  readonly label: string;
  readonly detail?: string;
  /** What to do about it, for warnings and failures. */
  readonly fix?: string;
}

export interface DoctorDeps {
  readonly nodeVersion: string;
  readonly agents: readonly AgentInfo[];
  readonly isRegistered: (agent: HostName) => Promise<boolean>;
  /** Throws when the settings file is invalid. */
  readonly loadSettings: () => Settings;
  readonly hasMessageHook: (agent: HostName) => boolean;
  /** Throws when agy's config would let it write, run commands or reach MCP servers. */
  readonly agyContainment: () => Promise<void>;
  /** With it, each installed advisor is sent one tiny question, which shows whether its CLI is signed in. */
  readonly ping?: (agent: AgentName) => Promise<AskResult>;
}

const MIN_NODE_MAJOR = 22;
const INSTALL_FIX = "run `npx -y consult-mcp@latest install`";
const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));
const isHost = (agent: AgentName): agent is HostName => (HOSTS as readonly string[]).includes(agent);

function nodeCheck(version: string): Check {
  const major = Number(/^v?(\d+)/.exec(version)?.[1]);
  return major >= MIN_NODE_MAJOR
    ? { status: "ok", label: `node ${version}` }
    : { status: "fail", label: `node ${version}`, fix: `install Node ${MIN_NODE_MAJOR} or later` };
}

function settingsChecks(deps: DoctorDeps, hosts: readonly HostName[]): readonly Check[] {
  let settings: Settings;
  try {
    settings = deps.loadSettings();
  } catch (err) {
    return [{ status: "fail", label: "settings file invalid", detail: errorMessage(err), fix: "fix or delete the file, then run `consult settings`" }];
  }
  const features = [
    `live sessions ${settings.sessions.enabled ? settings.sessions.scope : "off"}`,
    `messages ${messagesOn(settings) ? "on" : "off"}`,
    `task dispatch ${settings.tasks.enabled ? "on" : "off"}`,
  ];
  const summary: Check = { status: "ok", label: "settings", detail: features.join(", ") };
  if (!messagesOn(settings)) return [summary];
  const hooks = hosts.map((agent): Check =>
    deps.hasMessageHook(agent)
      ? { status: "ok", label: `${agent} message hook installed` }
      : { status: "fail", label: `${agent} message hook missing`, fix: INSTALL_FIX },
  );
  return [summary, ...hooks];
}

async function pingCheck(ping: NonNullable<DoctorDeps["ping"]>, agent: AgentName): Promise<Check> {
  try {
    const result = await ping(agent);
    const detail = [...(result.model ? [result.model] : []), `${(result.durationMs / 1000).toFixed(1)}s`].join(", ");
    return { status: "ok", label: `${agent} answered`, detail };
  } catch (err) {
    return { status: "fail", label: `${agent} did not answer`, detail: errorMessage(err), fix: `check that \`${agent}\` works and is signed in when you run it yourself` };
  }
}

/** Checks the setup consult depends on: node, the agent CLIs, registrations, settings, hooks and agy's containment. */
export async function diagnose(deps: DoctorDeps): Promise<readonly Check[]> {
  const installed = deps.agents.filter((a) => a.installed).map((a) => a.agent);
  const agentChecks = deps.agents.map((a): Check =>
    a.installed ? { status: "ok", label: `${a.agent} ${a.version ?? ""}`.trim() } : { status: "warn", label: `${a.agent} not installed` },
  );
  if (installed.length === 0) {
    return [nodeCheck(deps.nodeVersion), ...agentChecks, { status: "fail", label: "no agent CLI installed", fix: "install and sign in to claude, codex, grok or agy" }];
  }
  const hosts = installed.filter(isHost);
  const registrations = await Promise.all(
    hosts.map(async (agent): Promise<Check> =>
      (await deps.isRegistered(agent)) ? { status: "ok", label: `${agent} registered` } : { status: "fail", label: `${agent} not registered`, fix: INSTALL_FIX },
    ),
  );
  let agyOk = true;
  const agy: Check[] = [];
  if (installed.includes("agy")) {
    try {
      await deps.agyContainment();
      agy.push({ status: "ok", label: "agy is read-only" });
    } catch (err) {
      agyOk = false;
      agy.push({ status: "warn", label: "agy is not read-only", detail: errorMessage(err), fix: "consult refuses to run agy until this is fixed; the other advisors are unaffected" });
    }
  }
  const { ping } = deps;
  const pings = ping ? await Promise.all(installed.filter((a) => a !== "agy" || agyOk).map((a) => pingCheck(ping, a))) : [];
  return [nodeCheck(deps.nodeVersion), ...agentChecks, ...registrations, ...settingsChecks(deps, hosts), ...agy, ...pings];
}

const MARKS: Record<CheckStatus, string> = { ok: "✓", warn: "!", fail: "✗" };

export function formatChecks(checks: readonly Check[]): string {
  const lines = checks.flatMap((c) => [
    `${MARKS[c.status]} ${c.label}${c.detail ? `: ${c.detail}` : ""}`,
    ...(c.fix && c.status !== "ok" ? [`  → ${c.fix}`] : []),
  ]);
  const problems = checks.filter((c) => c.status === "fail").length;
  const summary = problems === 0 ? "No problems found." : `${problems} problem${problems === 1 ? "" : "s"} found.`;
  return `${lines.join("\n")}\n\n${summary}`;
}
