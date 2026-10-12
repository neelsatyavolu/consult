#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { agy } from "./adapters/agy.js";
import { claude } from "./adapters/claude.js";
import { codex, codexWorker } from "./adapters/codex.js";
import { grok, grokWorker } from "./adapters/grok.js";
import { listAgents } from "./agents.js";
import { createConsult } from "./consult.js";
import { progressLog } from "./narrate.js";
import { hookReply } from "./hook.js";
import { applyHooks, hookCommand, type HookResult } from "./hooks-install.js";
import { findOnPath, install, isRegistered, serverCommand, uninstall } from "./install.js";
import {
  DEFAULT_SETTINGS,
  loadSettings,
  messagesOn,
  saveSettings,
  sessionsMode,
  settingsPath,
  withMessagesEnabled,
  withSessionsMode,
  type SessionsMode,
} from "./settings.js";
import { run } from "./run.js";
import { createServer } from "./server.js";
import { claim, inboxDir } from "./sessions/inbox.js";
import { listLive, registryDir } from "./sessions/registry.js";
import { assertNotLiveSession } from "./sessions/service.js";
import { sessionTools } from "./sessions/wire.js";
import { createTaskManager } from "./tasks.js";
import { chooseInstallMode, isInteractive, parseMessagesFlag, parseSessionsFlag, promptMessages, promptSessionsMode, runSettings } from "./tui.js";
import { AGENTS, EFFORTS, HOSTS, SESSION_ID_PATTERN, type AgentName, type Effort, type HostName } from "./types.js";
import { VERSION } from "./version.js";

const DEFAULT_TIMEOUT_SEC = 900;
const DEFAULT_TASK_TIMEOUT_SEC = 3600;
const HEARTBEAT_MS = 30_000;

const USAGE = `consult ${VERSION} - let coding agents ask each other for advice

  consult serve                          run the MCP server (stdio)
  consult ask <agent> [options] <question...>
                                         ask an advisor; it can read --cwd but never change anything
      --model <id>  --effort low|medium|high  --resume <session_id>  --cwd <dir>
      a question of "-" is read from stdin; progress goes to stderr, the answer alone to stdout
  consult agents                         list installed CLIs and models
  consult install [--sessions off|repo|machine] [--messages on|off]
                                         register the MCP server with claude, codex and grok
  consult uninstall                      remove it from all three
  consult settings                       live sessions, messages, task dispatch, and which agents use consult (interactive)
  consult hook                           run by the agents' hooks to deliver session messages

agents: ${AGENTS.join(", ")}
timeouts: CONSULT_TIMEOUT_SEC per advisor call (default ${DEFAULT_TIMEOUT_SEC}; raise it for long grok runs),
          CONSULT_TASK_TIMEOUT_SEC per task (default ${DEFAULT_TASK_TIMEOUT_SEC})`;

function secondsFromEnv(name: string, defaultSec: number): number {
  const raw = process.env[name];
  const sec = raw ? Number(raw) : defaultSec;
  if (!Number.isFinite(sec) || sec <= 0) throw new Error(`${name} must be a positive number, got ${raw}`);
  return sec * 1000;
}

const timeoutMs = () => secondsFromEnv("CONSULT_TIMEOUT_SEC", DEFAULT_TIMEOUT_SEC);

/** Invalid settings mean off; sessionTools already warns about them. */
function tasksEnabled(): boolean {
  try {
    return loadSettings(settingsPath()).tasks.enabled;
  } catch {
    return false;
  }
}

/** Resuming a live session in place would write its transcript; those are reachable only through ask_session. */
const refuseLive = (sessionId: string | undefined): void => {
  if (sessionId) assertNotLiveSession(sessionId, listLive(registryDir()));
};

const consult = () => createConsult({ run, adapters: { claude, codex, grok, agy }, timeoutMs: timeoutMs() });

// Advisors and workers run in their own process groups, so they would outlive the server. Stop them when the host
// disconnects or signals us.
async function serve(): Promise<void> {
  const shutdown = new AbortController();
  const withShutdown = (signal?: AbortSignal) => (signal ? AbortSignal.any([signal, shutdown.signal]) : shutdown.signal);
  const { ask, askSession } = consult();
  const sessions = await sessionTools({
    run,
    env: process.env,
    cwd: process.cwd(),
    pid: process.pid,
    signal: shutdown.signal,
    askFork: (target, question, effort, signal) => askSession(target, question, effort, withShutdown(signal)),
    warn: (message) => process.stderr.write(`consult: ${message}\n`),
  });
  const tasks = tasksEnabled()
    ? createTaskManager({
        run,
        workers: { codex: codexWorker, grok: grokWorker },
        timeoutMs: secondsFromEnv("CONSULT_TASK_TIMEOUT_SEC", DEFAULT_TASK_TIMEOUT_SEC),
        signal: shutdown.signal,
      })
    : undefined;
  const server = createServer({
    ask: (request, signal) => {
      refuseLive(request.sessionId);
      return ask(request, withShutdown(signal));
    },
    listAgents: () => listAgents(run),
    defaultCwd: process.cwd(),
    ...(sessions ? { sessions } : {}),
    ...(tasks ? { tasks } : {}),
  });
  const transport = new StdioServerTransport();
  transport.onclose = () => shutdown.abort();
  // The stdio transport doesn't notice the host closing the pipe, so watch stdin directly.
  process.stdin.once("end", () => shutdown.abort());
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.once(sig, () => {
      shutdown.abort();
      process.exit(128 + (sig === "SIGINT" ? 2 : sig === "SIGTERM" ? 15 : 1));
    });
  }
  await server.connect(transport);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function askCommand(argv: readonly string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: { model: { type: "string" }, effort: { type: "string" }, resume: { type: "string" }, cwd: { type: "string" } },
  });
  const [agent, ...words] = positionals;
  if (!AGENTS.includes(agent as AgentName)) throw new Error(`agent must be one of ${AGENTS.join(", ")}`);
  if (values.effort && !EFFORTS.includes(values.effort as Effort)) throw new Error(`effort must be one of ${EFFORTS.join(", ")}`);
  if (values.resume !== undefined && !SESSION_ID_PATTERN.test(values.resume)) {
    throw new Error("--resume must be a session id: letters, digits and hyphens, not starting with a hyphen");
  }
  refuseLive(values.resume);
  const question = words.length === 1 && words[0] === "-" ? await readStdin() : words.join(" ");
  const progress = progressLog((line) => process.stderr.write(line), `${agent} is still working`, HEARTBEAT_MS);
  progress.update(`asking ${agent} (read-only)`);
  let result;
  try {
    result = await consult().ask(
      {
        agent: agent as AgentName,
        question,
        cwd: values.cwd ?? process.cwd(),
        model: values.model,
        effort: values.effort as Effort | undefined,
        sessionId: values.resume,
      },
      undefined,
      progress.update,
    );
  } finally {
    progress.stop();
  }
  process.stdout.write(`${result.answer}\n`);
  process.stderr.write(`\n[${result.agent}${result.model ? ` ${result.model}` : ""} · session ${result.sessionId} · ${(result.durationMs / 1000).toFixed(1)}s]\n`);
}

const installedHosts = () => HOSTS.filter((agent) => findOnPath(agent, process.env.PATH ?? ""));

const scriptPath = () => realpathSync(fileURLToPath(import.meta.url));
const searchPath = () => process.env.PATH ?? "";
const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Applies --sessions, or asks in a terminal. With neither, the setting stays as it is. */
async function configureSessions(flag: SessionsMode | undefined): Promise<void> {
  const path = settingsPath();
  let current = DEFAULT_SETTINGS;
  try {
    current = loadSettings(path);
  } catch (err) {
    if (!flag) {
      process.stderr.write(`consult: ${errorMessage(err)}\n`);
      return;
    }
  }
  const mode = await chooseInstallMode({ flag, current: sessionsMode(current), interactive: isInteractive(), prompt: promptSessionsMode });
  if (mode !== undefined) saveSettings(path, withSessionsMode(current, mode));
  process.stdout.write(`Live sessions: ${mode ?? sessionsMode(current)} (change with \`consult settings\`)\n`);
}

/** Applies --messages, or asks in a terminal while live sessions are on. With neither, the setting stays as it is. */
async function configureMessages(flag: boolean | undefined): Promise<boolean> {
  const path = settingsPath();
  let current;
  try {
    current = loadSettings(path);
  } catch {
    // configureSessions has reported the invalid file.
    return false;
  }
  const asked = flag ?? (isInteractive() && current.sessions.enabled ? await promptMessages(current.messages.enabled) : undefined);
  const next = asked === undefined ? current : withMessagesEnabled(current, asked);
  if (asked !== undefined) saveSettings(path, next);
  if (next.messages.enabled && !next.sessions.enabled) {
    process.stdout.write("Session messages: off until live sessions are turned on\n");
  } else {
    process.stdout.write(`Session messages: ${messagesOn(next) ? "on" : "off"} (change with \`consult settings\`)\n`);
  }
  return messagesOn(next);
}

/** Puts the message hook in `agents` and removes it from every other installed CLI. Reports only what changed. */
function setMessageHooks(agents: readonly HostName[]): readonly HookResult[] {
  const command = agents.length > 0 ? hookCommand(serverCommand(scriptPath(), searchPath())) : undefined;
  const hosts = installedHosts();
  return [
    ...applyHooks(hosts.filter((agent) => agents.includes(agent)), command),
    ...applyHooks(hosts.filter((agent) => !agents.includes(agent)), undefined),
  ].filter((r) => r.changed || !r.ok);
}

/** Never fails and never prints anything but a hook reply: the host runs this on every tool call. */
async function hookCommandMain(): Promise<void> {
  try {
    if (!messagesOn(loadSettings(settingsPath()))) return;
    const reply = hookReply(JSON.parse(await readStdin()), (sessionId) => claim(inboxDir(), sessionId));
    if (reply) process.stdout.write(`${reply}\n`);
  } catch {
    // Unread messages stay queued for the next event.
  }
}

/** Prints one line per CLI and returns whether every step succeeded. */
function report(results: readonly { readonly ok: boolean; readonly message: string }[]): boolean {
  process.stdout.write(`${results.map((r) => r.message).join("\n")}\n`);
  const ok = results.every((r) => r.ok);
  if (!ok) process.exitCode = 1;
  return ok;
}

async function main(argv: readonly string[]): Promise<void> {
  const [command, ...rest] = argv;
  switch (command) {
    case "serve":
      return serve();
    case "ask":
      return askCommand(rest);
    case "agents":
      process.stdout.write(`${JSON.stringify(await listAgents(run), null, 2)}\n`);
      return;
    case "install": {
      const { values } = parseArgs({ args: [...rest], options: { sessions: { type: "string" }, messages: { type: "string" } } });
      const flag = parseSessionsFlag(values.sessions);
      const messagesFlag = parseMessagesFlag(values.messages);
      if (report(await install(run, serverCommand(scriptPath(), searchPath()), installedHosts()))) {
        await configureSessions(flag);
        const hooks = setMessageHooks((await configureMessages(messagesFlag)) ? installedHosts() : []);
        if (hooks.length > 0) report(hooks);
        process.stdout.write("Restart running agent sessions to pick up the new tools.\n");
      } else if (flag || messagesFlag !== undefined) {
        process.stderr.write("consult: live sessions and messages settings left unchanged because registration failed\n");
      }
      return;
    }
    case "hook":
      return hookCommandMain();
    case "settings": {
      if (!isInteractive()) {
        throw new Error("consult settings needs an interactive terminal; in scripts use `consult install --sessions=off|repo|machine`");
      }
      const cmd = serverCommand(scriptPath(), searchPath());
      const path = settingsPath();
      await runSettings({
        load: () => loadSettings(path),
        save: (settings) => saveSettings(path, settings),
        installed: installedHosts(),
        isRegistered: (agent) => isRegistered(run, agent),
        register: (agents) => install(run, cmd, agents),
        unregister: (agents) => uninstall(run, agents),
        setMessageHooks,
      });
      return;
    }
    case "uninstall":
      report([...(await uninstall(run, installedHosts())), ...setMessageHooks([])]);
      return;
    case "--version":
    case "-v":
      process.stdout.write(`${VERSION}\n`);
      return;
    default:
      process.stdout.write(`${USAGE}\n`);
      if (command && command !== "help" && command !== "--help") process.exitCode = 1;
  }
}

main(process.argv.slice(2)).catch((err: unknown) => {
  process.stderr.write(`consult: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
