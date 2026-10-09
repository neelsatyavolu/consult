import { log, multiselect } from "@clack/prompts";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, withSessionsMode, withTasksEnabled } from "../src/settings.js";
import { chooseInstallMode, parseSessionsFlag, planSettings, runSettings } from "../src/tui.js";

vi.mock("@clack/prompts", () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  cancel: vi.fn(),
  log: { warn: vi.fn(), success: vi.fn(), error: vi.fn() },
  isCancel: () => false,
  select: vi.fn(async () => "repo"),
  confirm: vi.fn(async () => false),
  multiselect: vi.fn(async () => ["claude"]),
}));

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
    const plan = planSettings(DEFAULT_SETTINGS, ["claude", "codex"], { mode: "repo", tasks: false, hosts: ["codex", "grok"] });
    expect(plan.settings).toEqual(withSessionsMode(DEFAULT_SETTINGS, "repo"));
    expect(plan.register).toEqual(["grok"]);
    expect(plan.unregister).toEqual(["claude"]);
  });

  it("applies the task dispatch choice", () => {
    const plan = planSettings(DEFAULT_SETTINGS, [], { mode: "off", tasks: true, hosts: [] });
    expect(plan.settings).toEqual(withTasksEnabled(DEFAULT_SETTINGS, true));
  });

  it("changes nothing when nothing changed", () => {
    expect(planSettings(DEFAULT_SETTINGS, ["claude"], { mode: "off", tasks: false, hosts: ["claude"] })).toEqual({
      settings: DEFAULT_SETTINGS,
      register: [],
      unregister: [],
    });
  });
});

describe("runSettings", () => {
  it("continues when one CLI's registration check throws", async () => {
    const save = vi.fn();
    await runSettings({
      load: () => DEFAULT_SETTINGS,
      save,
      installed: ["claude", "codex"],
      isRegistered: async (agent) => {
        if (agent === "codex") throw new Error("could not parse config");
        return true;
      },
      register: async () => [],
      unregister: async () => [],
    });
    expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/codex: could not parse config/));
    expect(multiselect).toHaveBeenCalledWith(expect.objectContaining({ initialValues: ["claude"] }));
    expect(save).toHaveBeenCalled();
  });
});
