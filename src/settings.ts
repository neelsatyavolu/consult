import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";

export const SESSIONS_MODES = ["off", "repo", "machine"] as const;
export type SessionsMode = (typeof SESSIONS_MODES)[number];
export type Scope = Exclude<SessionsMode, "off">;

const schema = z.object({
  version: z.literal(1),
  sessions: z.object({ enabled: z.boolean(), scope: z.enum(["repo", "machine"]) }),
  // Added after the first release, so files written before it have no tasks entry.
  tasks: z.object({ enabled: z.boolean() }).default({ enabled: false }),
});

export interface Settings {
  readonly version: 1;
  readonly sessions: { readonly enabled: boolean; readonly scope: Scope };
  readonly tasks: { readonly enabled: boolean };
}

/** Live sessions and task dispatch stay off until the user turns them on. */
export const DEFAULT_SETTINGS: Settings = { version: 1, sessions: { enabled: false, scope: "repo" }, tasks: { enabled: false } };

export class SettingsError extends Error {
  override readonly name = "SettingsError";
}

/** `$XDG_CONFIG_HOME/consult/settings.json`, else `~/.config/consult/settings.json`. */
export function settingsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "consult", "settings.json");
}

/** Returns the defaults when the file does not exist; throws SettingsError when it exists but is not valid. */
export function loadSettings(path: string): Settings {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return DEFAULT_SETTINGS;
    throw new SettingsError(`could not read ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new SettingsError(`${path} is not valid JSON; run \`consult settings\` to reset it`);
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    const reason = parsed.error.issues[0]?.message ?? "unknown problem";
    throw new SettingsError(`${path} has invalid settings (${reason}); run \`consult settings\` to reset it`);
  }
  return parsed.data;
}

export function saveSettings(path: string, settings: Settings): void {
  const valid = schema.parse(settings);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(valid, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

export const sessionsMode = (settings: Settings): SessionsMode =>
  settings.sessions.enabled ? settings.sessions.scope : "off";

/** Turning sessions off keeps the scope, so turning them back on restores it. */
export function withSessionsMode(settings: Settings, mode: SessionsMode): Settings {
  return {
    ...settings,
    sessions: mode === "off" ? { ...settings.sessions, enabled: false } : { enabled: true, scope: mode },
  };
}

export const withTasksEnabled = (settings: Settings, enabled: boolean): Settings => ({ ...settings, tasks: { enabled } });
