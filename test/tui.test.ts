import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, withSessionsMode } from "../src/settings.js";
import { chooseInstallMode, parseSessionsFlag, planSettings } from "../src/tui.js";

describe("parseSessionsFlag", () => {
  it("accepts off, repo and machine, and is undefined when absent", () => {
    expect(parseSessionsFlag("off")).toBe("off");
    expect(parseSessionsFlag("repo")).toBe("repo");
    expect(parseSessionsFlag("machine")).toBe("machine");
    expect(parseSessionsFlag(undefined)).toBeUndefined();
  });

  it("rejects anything else and lists the allowed values", () => {
    expect(() => parseSessionsFlag("all")).toThrow(/off, repo, machine/);
  });
});

describe("chooseInstallMode", () => {
  it("uses the flag without prompting", async () => {
    const prompt = vi.fn();
    expect(await chooseInstallMode({ flag: "machine", current: "off", interactive: true, prompt })).toBe("machine");
    expect(prompt).not.toHaveBeenCalled();
  });

  it("never prompts without a terminal, leaving the setting as it is", async () => {
    const prompt = vi.fn();
    expect(await chooseInstallMode({ current: "repo", interactive: false, prompt })).toBeUndefined();
    expect(prompt).not.toHaveBeenCalled();
  });

  it("asks in a terminal, starting from the current mode", async () => {
    const prompt = vi.fn(async () => "repo" as const);
    expect(await chooseInstallMode({ current: "off", interactive: true, prompt })).toBe("repo");
    expect(prompt).toHaveBeenCalledWith("off");
  });
});

describe("planSettings", () => {
  it("applies the mode and registers or removes only the hosts that changed", () => {
    const plan = planSettings(DEFAULT_SETTINGS, ["claude", "codex"], { mode: "repo", hosts: ["codex", "grok"] });
    expect(plan.settings).toEqual(withSessionsMode(DEFAULT_SETTINGS, "repo"));
    expect(plan.register).toEqual(["grok"]);
    expect(plan.unregister).toEqual(["claude"]);
  });

  it("changes nothing when nothing changed", () => {
    expect(planSettings(DEFAULT_SETTINGS, ["claude"], { mode: "off", hosts: ["claude"] })).toEqual({
      settings: DEFAULT_SETTINGS,
      register: [],
      unregister: [],
    });
  });
});
