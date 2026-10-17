import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyInstructions, instructionsBlock, instructionsPath, withInstructions } from "../src/instructions-install.js";
import { DEFAULT_SETTINGS, type Settings } from "../src/settings.js";

const tmp = () => mkdtempSync(join(tmpdir(), "consult-instructions-"));
const allOn: Settings = { version: 1, sessions: { enabled: true, scope: "repo" }, tasks: { enabled: true }, messages: { enabled: true } };

describe("instructionsPath", () => {
  it("uses each host's global instructions file", () => {
    const env = { CLAUDE_CONFIG_DIR: "/c", CODEX_HOME: "/x", HOME: "/h" };
    expect(instructionsPath("claude", env)).toBe("/c/CLAUDE.md");
    expect(instructionsPath("codex", env)).toBe("/x/AGENTS.md");
    expect(instructionsPath("grok", env)).toMatch(/\.grok\/AGENTS\.md$/);
  });
});

describe("instructionsBlock", () => {
  it("mentions only the features that are on", () => {
    const off = instructionsBlock(DEFAULT_SETTINGS);
    expect(off).toContain("ask_agent");
    expect(off).not.toContain("ask_session");
    expect(off).not.toContain("send_message");
    expect(off).not.toContain("dispatch_task");

    const on = instructionsBlock(allOn);
    for (const tool of ["ask_session", "list_sessions", "send_message", "dispatch_task"]) expect(on).toContain(tool);
  });

  it("leaves out messages while live sessions are off", () => {
    const block = instructionsBlock({ ...allOn, sessions: { enabled: false, scope: "repo" } });
    expect(block).not.toContain("send_message");
    expect(block).toContain("dispatch_task");
  });
});

describe("withInstructions", () => {
  const block = instructionsBlock(DEFAULT_SETTINGS);

  it("appends the block after existing text, and replaces it in place later", () => {
    const first = withInstructions("# Mine\n\nKeep this.\n", block);
    expect(first.startsWith("# Mine\n\nKeep this.\n\n")).toBe(true);
    expect(first).toContain(block);

    const second = withInstructions(`${first}\nAfter.\n`, instructionsBlock(allOn));
    expect(second).toContain("send_message");
    expect(second).not.toContain(block);
    expect(second.startsWith("# Mine\n\nKeep this.\n")).toBe(true);
    expect(second.endsWith("\nAfter.\n")).toBe(true);
    expect(second.match(/consult:start/g)).toHaveLength(1);
  });

  it("removes the block and the blank line before it", () => {
    expect(withInstructions(withInstructions("# Mine\n", block), undefined)).toBe("# Mine\n");
    expect(withInstructions("# Mine\n", undefined)).toBe("# Mine\n");
  });
});

describe("applyInstructions", () => {
  it("writes, updates and removes the block, and deletes a file that held only the block", () => {
    const dir = tmp();
    const env = { CLAUDE_CONFIG_DIR: join(dir, "claude"), CODEX_HOME: join(dir, "codex") };
    mkdirSync(env.CODEX_HOME);
    writeFileSync(join(env.CODEX_HOME, "AGENTS.md"), "# Codex rules\n");

    const written = applyInstructions(["claude", "codex"], DEFAULT_SETTINGS, env);
    expect(written.map((r) => [r.ok, r.changed])).toEqual([[true, true], [true, true]]);
    expect(readFileSync(join(env.CODEX_HOME, "AGENTS.md"), "utf8")).toMatch(/^# Codex rules\n\n<!-- consult:start/);

    expect(applyInstructions(["claude"], DEFAULT_SETTINGS, env)[0]?.changed).toBe(false);
    expect(applyInstructions(["claude"], allOn, env)[0]?.changed).toBe(true);

    applyInstructions(["claude", "codex"], undefined, env);
    expect(existsSync(join(env.CLAUDE_CONFIG_DIR, "CLAUDE.md"))).toBe(false);
    expect(readFileSync(join(env.CODEX_HOME, "AGENTS.md"), "utf8")).toBe("# Codex rules\n");
  });

  it("does not create a file just to remove nothing from it", () => {
    const dir = tmp();
    const env = { CLAUDE_CONFIG_DIR: join(dir, "claude") };
    expect(applyInstructions(["claude"], undefined, env)[0]?.changed).toBe(false);
    expect(existsSync(join(env.CLAUDE_CONFIG_DIR, "CLAUDE.md"))).toBe(false);
  });
});
