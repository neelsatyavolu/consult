import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ServerCommand } from "./install.js";
import type { HostName } from "./types.js";

/** Marks consult's handlers in hook files that other tools also write to. */
const MARKER = "CONSULT_HOOK=1";
const TIMEOUT_SEC = 10;
/** How long Claude Code lets the idle watcher wait for a message before it stops it. */
const WATCH_TIMEOUT_SEC = 24 * 60 * 60;
const WATCH_POLL_SEC = 3;

/** Grok discards what a UserPromptSubmit hook prints, so it gets no hook there. */
const EVENTS: Record<HostName, readonly string[]> = {
  claude: ["UserPromptSubmit", "PostToolUse", "Stop"],
  codex: ["UserPromptSubmit", "PostToolUse", "Stop"],
  grok: ["PostToolUse", "Stop"],
};

const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/**
 * The shell command hosts run on each hook event. It runs on every tool call, so it starts consult only when the
 * id of a session with waiting messages appears in the event; otherwise it costs one directory listing.
 */
export function hookCommand(cmd: ServerCommand): string {
  const launcher = [cmd.command, ...cmd.args.slice(0, -1), "hook"].map(shellQuote).join(" ");
  return [
    // No glob: hosts may run hooks through zsh, which fails the whole command when a glob matches nothing.
    'i=$(cat); for s in $(ls "${XDG_STATE_HOME:-$HOME/.local/state}/consult/inbox" 2>/dev/null); do',
    `case "$i" in *"$s"*) printf '%s' "$i" | ${MARKER} PATH=${shellQuote(cmd.path)}:"$PATH" ${launcher}; break;; esac;`,
    "done; exit 0",
  ].join(" ");
}

/**
 * For Claude Code's `asyncRewake`: started in the background when a turn ends, it waits for a message and then
 * exits 2 with the message on stderr, which wakes the idle session. One watcher runs per session, and it stops
 * when the session's process is gone. Grok also reads Claude Code's hook file but runs every handler in the
 * foreground, so the command leaves at once when the event comes from Grok.
 */
export function watchCommand(cmd: ServerCommand): string {
  const launcher = [cmd.command, ...cmd.args.slice(0, -1), "hook", "--rewake"].map(shellQuote).join(" ");
  return [
    `i=$(cat); case "$i" in *'"hookEventName"'*) exit 0;; esac;`,
    `s=$(printf '%s' "$i" | sed -n 's/.*"session_id" *: *"\\([A-Za-z0-9-]*\\)".*/\\1/p'); [ -n "$s" ] || exit 0;`,
    'b="${XDG_STATE_HOME:-$HOME/.local/state}/consult"; w="$b/watch-$s.pid";',
    'p=$(cat "$w" 2>/dev/null); [ -n "$p" ] && kill -0 "$p" 2>/dev/null && exit 0;',
    'mkdir -p "$b"; echo $$ > "$w";',
    "while kill -0 $PPID 2>/dev/null; do",
    `if [ -d "$b/inbox/$s" ]; then printf '%s' "$i" | ${MARKER} PATH=${shellQuote(cmd.path)}:"$PATH" ${launcher}; [ $? -eq 2 ] && { rm -f "$w"; exit 2; }; fi;`,
    `sleep ${WATCH_POLL_SEC};`,
    'done; rm -f "$w"; exit 0',
  ].join(" ");
}

export function hookFilePath(agent: HostName, env: NodeJS.ProcessEnv = process.env): string {
  switch (agent) {
    case "claude":
      return join(env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "settings.json");
    case "codex":
      return join(env.CODEX_HOME || join(homedir(), ".codex"), "hooks.json");
    case "grok":
      return join(homedir(), ".grok", "hooks", "consult.json");
  }
}

type Json = Record<string, unknown>;

/** A handler consult adds beside the plain message hook. */
export interface ExtraHook {
  readonly event: string;
  readonly handler: Json;
}
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const isOurs = (handler: unknown) => isObject(handler) && typeof handler.command === "string" && handler.command.includes(MARKER);

/** The event's matcher groups without consult's handlers; groups left with no handlers are dropped. */
function withoutOurs(groups: unknown): readonly unknown[] {
  if (!Array.isArray(groups)) return [];
  return groups.flatMap((group) => {
    if (!isObject(group) || !Array.isArray(group.hooks) || !group.hooks.some(isOurs)) return [group];
    const hooks = group.hooks.filter((handler) => !isOurs(handler));
    return hooks.length > 0 ? [{ ...group, hooks }] : [];
  });
}

/**
 * A hook file's content with consult's handlers set to `command` on `events` plus the `extra` ones, or removed
 * when there is no command. Everything else in the file is kept.
 */
export function withConsultHooks(
  config: unknown,
  command: string | undefined,
  events: readonly string[],
  extra: readonly ExtraHook[] = [],
): Json {
  const base = isObject(config) ? config : {};
  const existing = isObject(base.hooks) ? base.hooks : {};
  const cleaned = Object.entries(existing).flatMap(([event, groups]) => {
    const kept = Array.isArray(groups) ? withoutOurs(groups) : groups;
    return Array.isArray(kept) && kept.length === 0 ? [] : [[event, kept] as const];
  });
  const hooks: Json = Object.fromEntries(cleaned);
  if (command) {
    const entries = [
      ...events.map((event) => ({ event, handler: { type: "command", command, timeout: TIMEOUT_SEC } })),
      ...extra,
    ];
    for (const { event, handler } of entries) {
      hooks[event] = [...(Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : []), { hooks: [handler] }];
    }
  }
  const { hooks: _dropped, ...rest } = base;
  return Object.keys(hooks).length > 0 ? { ...rest, hooks } : rest;
}

/** Writes or removes consult's hooks in one file. Returns whether the file changed. */
export function applyHookFile(
  path: string,
  command: string | undefined,
  events: readonly string[],
  extra: readonly ExtraHook[] = [],
): boolean {
  const exists = existsSync(path);
  if (!exists && !command) return false;
  const before = exists ? readFileSync(path, "utf8") : "";
  let config: unknown = {};
  if (before.trim()) {
    try {
      config = JSON.parse(before);
    } catch {
      throw new Error(`${path} is not valid JSON; fix it and run install again`);
    }
    if (!isObject(config)) throw new Error(`${path} does not hold a JSON object`);
  }
  const next = withConsultHooks(config, command, events, extra);
  if (exists && Object.keys(next).length === 0 && Object.keys(config as Json).length > 0) {
    // Only consult's hooks were in it.
    rmSync(path);
    return true;
  }
  if (JSON.stringify(next) === JSON.stringify(config)) return false;
  const after = `${JSON.stringify(next, null, 2)}\n`;
  // Follow a symlinked settings file rather than replace the link.
  const target = exists ? realpathSync(path) : path;
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, after, { mode: exists ? statSync(target).mode & 0o777 : 0o600 });
  renameSync(tmp, target);
  return true;
}

export interface HookResult {
  readonly agent: HostName;
  readonly ok: boolean;
  /** False when the file already was as wanted, so there is nothing to report. */
  readonly changed: boolean;
  readonly message: string;
}

/** Installs consult's message hook for each CLI, or removes it when there is no command. One failing does not stop the others. */
export function applyHooks(
  agents: readonly HostName[],
  cmd: ServerCommand | undefined,
  env: NodeJS.ProcessEnv = process.env,
): readonly HookResult[] {
  const command = cmd ? hookCommand(cmd) : undefined;
  return agents.map((agent) => {
    const path = hookFilePath(agent, env);
    try {
      // Only Claude Code can be woken by a hook; Codex is woken through `codex queue` and Grok not at all.
      const watcher: readonly ExtraHook[] =
        cmd && agent === "claude"
          ? [{ event: "Stop", handler: { type: "command", command: watchCommand(cmd), asyncRewake: true, timeout: WATCH_TIMEOUT_SEC } }]
          : [];
      const changed = applyHookFile(path, command, EVENTS[agent], watcher);
      const what = command ? (changed ? "message hook written to" : "message hook already in") : changed ? "message hook removed from" : "no message hook in";
      const trust = command && agent === "codex" ? "; codex may need you to trust the hook before it runs" : "";
      return { agent, ok: true, changed, message: `${agent}: ${what} ${path}${trust}` };
    } catch (err) {
      return { agent, ok: false, changed: false, message: `${agent}: FAILED - ${err instanceof Error ? err.message : String(err)}` };
    }
  });
}
