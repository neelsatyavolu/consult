import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  SettingsError,
  loadSettings,
  saveSettings,
  sessionsMode,
  settingsPath,
  withSessionsMode,
  withTasksEnabled,
} from "../src/settings.js";

const tmpPath = () => join(mkdtempSync(join(tmpdir(), "consult-settings-")), "consult", "settings.json");

describe("settingsPath", () => {
  it("uses XDG_CONFIG_HOME when set", () => {
    expect(settingsPath({ XDG_CONFIG_HOME: "/xdg" })).toBe(join("/xdg", "consult", "settings.json"));
  });

  it("falls back to ~/.config", () => {
    expect(settingsPath({})).toBe(join(homedir(), ".config", "consult", "settings.json"));
  });
});

describe("loadSettings / saveSettings", () => {
  it("returns the defaults, with live sessions and task dispatch off, when the file does not exist", () => {
    expect(loadSettings(tmpPath())).toEqual({ version: 1, sessions: { enabled: false, scope: "repo" }, tasks: { enabled: false } });
  });

  it("reads a file written before task dispatch existed as task dispatch off", () => {
    const path = tmpPath();
    saveSettings(path, DEFAULT_SETTINGS);
    writeFileSync(path, JSON.stringify({ version: 1, sessions: { enabled: true, scope: "machine" } }));
    expect(loadSettings(path)).toEqual({ version: 1, sessions: { enabled: true, scope: "machine" }, tasks: { enabled: false } });
  });

  it("round-trips task dispatch", () => {
    const path = tmpPath();
    saveSettings(path, withTasksEnabled(DEFAULT_SETTINGS, true));
    expect(loadSettings(path).tasks.enabled).toBe(true);
    expect(DEFAULT_SETTINGS.tasks.enabled).toBe(false);
  });

  it("round-trips settings and writes a file only the user can read", () => {
    const path = tmpPath();
    const settings = withSessionsMode(DEFAULT_SETTINGS, "machine");
    saveSettings(path, settings);
    expect(loadSettings(path)).toEqual(settings);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("throws a SettingsError that points to consult settings when the file is not JSON", () => {
    const path = tmpPath();
    saveSettings(path, DEFAULT_SETTINGS);
    writeFileSync(path, "{ nope");
    expect(() => loadSettings(path)).toThrow(SettingsError);
    expect(() => loadSettings(path)).toThrow(/consult settings/);
  });

  it("throws a SettingsError when a value is not allowed", () => {
    const path = tmpPath();
    saveSettings(path, DEFAULT_SETTINGS);
    writeFileSync(path, JSON.stringify({ version: 1, sessions: { enabled: true, scope: "galaxy" } }));
    expect(() => loadSettings(path)).toThrow(SettingsError);
  });
});

describe("sessions mode", () => {
  it("reads off, repo and machine", () => {
    expect(sessionsMode(DEFAULT_SETTINGS)).toBe("off");
    expect(sessionsMode(withSessionsMode(DEFAULT_SETTINGS, "repo"))).toBe("repo");
    expect(sessionsMode(withSessionsMode(DEFAULT_SETTINGS, "machine"))).toBe("machine");
  });

  it("keeps the chosen scope when turned off, and never mutates its input", () => {
    const machine = withSessionsMode(DEFAULT_SETTINGS, "machine");
    const off = withSessionsMode(machine, "off");
    expect(off.sessions).toEqual({ enabled: false, scope: "machine" });
    expect(machine.sessions.enabled).toBe(true);
    expect(DEFAULT_SETTINGS.sessions.enabled).toBe(false);
  });
});
