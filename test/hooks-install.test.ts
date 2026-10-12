import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyHookFile, applyHooks, hookCommand, hookFilePath, withConsultHooks } from "../src/hooks-install.js";

const tmp = () => mkdtempSync(join(tmpdir(), "consult-hooks-"));
const cmd = { command: "/usr/bin/node", args: ["/opt/consult/dist/cli.js", "serve"], path: "/usr/bin:/bin" };
const read = (path: string) => JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;

describe("hookCommand", () => {
  it("runs `consult hook` through the same launcher as the server", () => {
    expect(hookCommand(cmd)).toContain("CONSULT_HOOK=1 PATH='/usr/bin:/bin':\"$PATH\" '/usr/bin/node' '/opt/consult/dist/cli.js' 'hook'");
    const viaNpx = hookCommand({ command: "/usr/bin/npx", args: ["-y", "consult-mcp@latest", "serve"], path: "/usr/bin" });
    expect(viaNpx).toContain("'/usr/bin/npx' '-y' 'consult-mcp@latest' 'hook'");
  });

  it("starts consult only when a session with waiting messages is named in the event", () => {
    const dir = tmp();
    const fake = join(dir, "fake-consult");
    writeFileSync(fake, "#!/bin/sh\necho \"ran $1 with $(cat)\"\n");
    chmodSync(fake, 0o755);
    const command = hookCommand({ command: fake, args: ["serve"], path: "/usr/bin:/bin" });
    // Hosts differ in the shell they run hooks with; zsh fails a command whose glob matches nothing.
    const shells = ["/bin/sh", "/bin/bash", "/bin/zsh"].filter((shell) => existsSync(shell));
    const runHook = (shell: string, input: string) =>
      execFileSync(shell, ["-c", command], { input, env: { XDG_STATE_HOME: dir, PATH: "/usr/bin:/bin" }, encoding: "utf8" });

    for (const shell of shells) expect(runHook(shell, '{"session_id":"s-1"}')).toBe("");
    mkdirSync(join(dir, "consult", "inbox"), { recursive: true });
    for (const shell of shells) expect(runHook(shell, '{"session_id":"s-1"}')).toBe("");
    mkdirSync(join(dir, "consult", "inbox", "s-2"));
    for (const shell of shells) {
      expect(runHook(shell, '{"session_id":"s-1"}')).toBe("");
      expect(runHook(shell, '{"session_id":"s-2"}')).toBe('ran hook with {"session_id":"s-2"}\n');
    }
  });
});

describe("withConsultHooks", () => {
  const other = { matcher: "Bash", hooks: [{ type: "command", command: "other-tool" }] };

  it("adds consult's handler to each event and keeps everything else", () => {
    const next = withConsultHooks({ model: "opus", hooks: { PostToolUse: [other] } }, "CONSULT_HOOK=1 x", ["PostToolUse", "Stop"]);
    expect(next.model).toBe("opus");
    const hooks = next.hooks as Record<string, any[]>;
    expect(hooks.PostToolUse).toEqual([other, { hooks: [{ type: "command", command: "CONSULT_HOOK=1 x", timeout: 10 }] }]);
    expect(hooks.Stop).toHaveLength(1);
  });

  it("replaces an earlier consult handler instead of adding a second", () => {
    const once = withConsultHooks({}, "CONSULT_HOOK=1 old", ["Stop"]);
    const twice = withConsultHooks(once, "CONSULT_HOOK=1 new", ["Stop"]);
    expect((twice.hooks as Record<string, any[]>).Stop).toEqual([{ hooks: [{ type: "command", command: "CONSULT_HOOK=1 new", timeout: 10 }] }]);
  });

  it("removes only consult's handlers", () => {
    const mixed = { hooks: [{ type: "command", command: "other-tool" }, { type: "command", command: "CONSULT_HOOK=1 x" }] };
    const withOurs = withConsultHooks({ hooks: { PostToolUse: [other, mixed] } }, "CONSULT_HOOK=1 x", ["Stop"]);
    expect(withConsultHooks(withOurs, undefined, [])).toEqual({
      hooks: { PostToolUse: [other, { hooks: [{ type: "command", command: "other-tool" }] }] },
    });
    expect(withConsultHooks(withConsultHooks({ model: "opus" }, "CONSULT_HOOK=1 x", ["Stop"]), undefined, [])).toEqual({ model: "opus" });
  });
});

describe("applyHookFile", () => {
  it("creates the file, reports no change the second time, and removes a file that held only consult's hooks", () => {
    const path = join(tmp(), "hooks", "consult.json");
    expect(applyHookFile(path, "CONSULT_HOOK=1 x", ["Stop"])).toBe(true);
    expect(read(path).hooks.Stop).toHaveLength(1);
    expect(applyHookFile(path, "CONSULT_HOOK=1 x", ["Stop"])).toBe(false);
    expect(applyHookFile(path, undefined, [])).toBe(true);
    expect(existsSync(path)).toBe(false);
    expect(applyHookFile(path, undefined, [])).toBe(false);
  });

  it("keeps a settings file's other content when removing", () => {
    const path = join(tmp(), "settings.json");
    writeFileSync(path, JSON.stringify({ model: "opus" }));
    applyHookFile(path, "CONSULT_HOOK=1 x", ["Stop"]);
    applyHookFile(path, undefined, []);
    expect(read(path)).toEqual({ model: "opus" });
  });

  it("refuses to overwrite a file that is not valid JSON", () => {
    const path = join(tmp(), "settings.json");
    writeFileSync(path, "{broken");
    expect(() => applyHookFile(path, "CONSULT_HOOK=1 x", ["Stop"])).toThrow(/not valid JSON/);
    expect(readFileSync(path, "utf8")).toBe("{broken");
  });
});

describe("applyHooks", () => {
  it("writes each host's file, with no prompt hook for grok, and reports failures per host", () => {
    const home = tmp();
    const env = { CLAUDE_CONFIG_DIR: join(home, "claude"), CODEX_HOME: join(home, "codex") };
    mkdirSync(env.CODEX_HOME);
    writeFileSync(join(env.CODEX_HOME, "hooks.json"), "{broken");
    const results = applyHooks(["claude", "codex"], "CONSULT_HOOK=1 x", env);
    expect(results.map((r) => [r.agent, r.ok, r.changed])).toEqual([
      ["claude", true, true],
      ["codex", false, false],
    ]);
    expect(Object.keys(read(hookFilePath("claude", env)).hooks)).toEqual(["UserPromptSubmit", "PostToolUse", "Stop"]);
    expect(hookFilePath("grok", env)).toMatch(/\.grok\/hooks\/consult\.json$/);
  });
});
