import { cancel, confirm, intro, isCancel, log, multiselect, outro, select } from "@clack/prompts";
import type { InstallResult } from "./install.js";
import {
  DEFAULT_SETTINGS,
  SESSIONS_MODES,
  sessionsMode,
  withSessionsMode,
  withTasksEnabled,
  type SessionsMode,
  type Settings,
} from "./settings.js";
import type { HostName } from "./types.js";

const MODE_OPTIONS = [
  { value: "off", label: "Off", hint: "default: agents can't see each other's sessions" },
  { value: "repo", label: "Same repo", hint: "sessions in the same git repository and its worktrees" },
  { value: "machine", label: "Whole machine", hint: "every consult session you run" },
] as const;

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function parseSessionsFlag(value: string | undefined): SessionsMode | undefined {
  if (value === undefined) return undefined;
  if (!(SESSIONS_MODES as readonly string[]).includes(value)) {
    throw new Error(`--sessions must be one of ${SESSIONS_MODES.join(", ")}`);
  }
  return value as SessionsMode;
}

export const isInteractive = (stdin: { isTTY?: boolean } = process.stdin, stdout: { isTTY?: boolean } = process.stdout) =>
  Boolean(stdin.isTTY && stdout.isTTY);

/** The flag wins; otherwise ask, but only in a terminal. Undefined means leave the setting as it is. */
export async function chooseInstallMode(opts: {
  readonly flag?: SessionsMode;
  readonly current: SessionsMode;
  readonly interactive: boolean;
  readonly prompt: (current: SessionsMode) => Promise<SessionsMode | undefined>;
}): Promise<SessionsMode | undefined> {
  if (opts.flag) return opts.flag;
  return opts.interactive ? opts.prompt(opts.current) : undefined;
}

export interface SettingsPlan {
  readonly settings: Settings;
  readonly register: readonly HostName[];
  readonly unregister: readonly HostName[];
}

export function planSettings(
  current: Settings,
  registered: readonly HostName[],
  chosen: { readonly mode: SessionsMode; readonly tasks: boolean; readonly hosts: readonly HostName[] },
): SettingsPlan {
  return {
    settings: withTasksEnabled(withSessionsMode(current, chosen.mode), chosen.tasks),
    register: chosen.hosts.filter((agent) => !registered.includes(agent)),
    unregister: registered.filter((agent) => !chosen.hosts.includes(agent)),
  };
}

/** Asks for the live-sessions mode. Undefined when the user cancels. */
export async function promptSessionsMode(current: SessionsMode): Promise<SessionsMode | undefined> {
  const mode = await select({
    message: "Live sessions: let agents see and ask each other's running sessions?",
    options: [...MODE_OPTIONS],
    initialValue: current,
  });
  return isCancel(mode) ? undefined : mode;
}

export interface SettingsIo {
  /** Throws SettingsError when the file is invalid. */
  readonly load: () => Settings;
  readonly save: (settings: Settings) => void;
  readonly installed: readonly HostName[];
  readonly isRegistered: (agent: HostName) => Promise<boolean>;
  readonly register: (agents: readonly HostName[]) => Promise<readonly InstallResult[]>;
  readonly unregister: (agents: readonly HostName[]) => Promise<readonly InstallResult[]>;
}

async function loadOrReset(io: SettingsIo): Promise<Settings | undefined> {
  try {
    return io.load();
  } catch (err) {
    log.warn(errorMessage(err));
    const reset = await confirm({ message: "Reset settings to the defaults?", initialValue: true });
    return !isCancel(reset) && reset ? DEFAULT_SETTINGS : undefined;
  }
}

export async function runSettings(io: SettingsIo): Promise<void> {
  intro("consult settings");
  const current = await loadOrReset(io);
  if (!current) return cancel("Left settings unchanged.");
  const registered: HostName[] = [];
  for (const agent of io.installed) {
    try {
      if (await io.isRegistered(agent)) registered.push(agent);
    } catch (err) {
      // One CLI failing its probe must not abort the wizard; the user can still change the other settings.
      log.warn(`${agent}: ${errorMessage(err)}`);
    }
  }

  const mode = await promptSessionsMode(sessionsMode(current));
  if (mode === undefined) return cancel("No changes made.");
  const tasks = await confirm({
    message: "Task dispatch: let agents hand tasks to Codex and Grok workers that edit files and run commands?",
    initialValue: current.tasks.enabled,
  });
  if (isCancel(tasks)) return cancel("No changes made.");
  const hosts =
    io.installed.length === 0
      ? []
      : await multiselect({
          message: "Use consult in",
          options: io.installed.map((agent) => ({ value: agent, label: agent })),
          initialValues: [...registered],
          required: false,
        });
  if (isCancel(hosts)) return cancel("No changes made.");

  const plan = planSettings(current, registered, { mode, tasks, hosts });
  io.save(plan.settings);
  const changed = [...plan.register, ...plan.unregister];
  const results = [
    ...(plan.register.length > 0 ? await io.register(plan.register) : []),
    ...(plan.unregister.length > 0 ? await io.unregister(plan.unregister) : []),
  ].filter((r) => changed.includes(r.agent));
  for (const r of results) (r.ok ? log.success : log.error)(r.message);
  outro(`Live sessions: ${mode}. Task dispatch: ${tasks ? "on" : "off"}. Restart running agent sessions to apply.`);
}
