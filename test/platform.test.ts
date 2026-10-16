import { describe, expect, it } from "vitest";
import { maxCommandLine, resolveForSpawn, shimTarget } from "../src/platform.js";

// The shim npm's cmd-shim writes for a node script, e.g. %APPDATA%\npm\codex.cmd.
const NPM_NODE_SHIM = `@ECHO off\r
GOTO start\r
:find_dp0\r
SET dp0=%~dp0\r
EXIT /b\r
:start\r
SETLOCAL\r
CALL :find_dp0\r
\r
IF EXIST "%dp0%\\node.exe" (\r
  SET "_prog=%dp0%\\node.exe"\r
) ELSE (\r
  SET "_prog=node"\r
  SET PATHEXT=%PATHEXT:;.JS;=;%\r
)\r
\r
endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r
`;

// The shim cmd-shim writes for a native binary.
const NPM_EXE_SHIM = `@ECHO off\r
GOTO start\r
:find_dp0\r
SET dp0=%~dp0\r
EXIT /b\r
:start\r
SETLOCAL\r
CALL :find_dp0\r
"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*\r
`;

// pnpm's shim style.
const PNPM_SHIM = `@SETLOCAL\r
@IF NOT DEFINED NODE_PATH (\r
  @SET "NODE_PATH=C:\\pnpm\\global\\5\\node_modules"\r
)\r
@IF EXIST "%~dp0\\node.exe" (\r
  "%~dp0\\node.exe"  "%~dp0\\global\\5\\node_modules\\grok-cli\\dist\\index.js" %*\r
) ELSE (\r
  @SET PATHEXT=%PATHEXT:;.JS;=;%\r
  node  "%~dp0\\global\\5\\node_modules\\grok-cli\\dist\\index.js" %*\r
)\r
`;

const files = (map: Record<string, string>) => ({
  exists: (p: string) => p.toLowerCase() in Object.fromEntries(Object.keys(map).map((k) => [k.toLowerCase(), true])),
  read: (p: string) => {
    const key = Object.keys(map).find((k) => k.toLowerCase() === p.toLowerCase());
    if (!key) throw new Error("ENOENT");
    return map[key]!;
  },
});

describe("shimTarget", () => {
  it("finds the node script behind an npm shim", () => {
    expect(shimTarget(NPM_NODE_SHIM, "C:\\npm")).toEqual({ path: "C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js", node: true });
  });

  it("finds the binary behind an npm shim for a native executable", () => {
    expect(shimTarget(NPM_EXE_SHIM, "C:\\npm")).toEqual({ path: "C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe", node: false });
  });

  it("finds the script behind a pnpm shim", () => {
    expect(shimTarget(PNPM_SHIM, "C:\\pnpm")).toEqual({ path: "C:\\pnpm\\global\\5\\node_modules\\grok-cli\\dist\\index.js", node: true });
  });

  it("gives up on a batch file it does not recognise", () => {
    expect(shimTarget("@echo off\r\ncall something-else.bat %*\r\n", "C:\\x")).toBeUndefined();
    expect(shimTarget("@echo off\r\necho hi\r\n", "C:\\x")).toBeUndefined();
  });
});

describe("resolveForSpawn", () => {
  const env = { PATH: "C:\\Windows\\System32;C:\\npm", PATHEXT: ".COM;.EXE;.BAT;.CMD" };

  it("leaves commands alone outside Windows", () => {
    expect(resolveForSpawn("codex", ["exec", "hi"], { platform: "darwin", env, node: "/node", ...files({}) })).toEqual({ command: "codex", args: ["exec", "hi"] });
  });

  it("runs an .exe on PATH directly", () => {
    const fs = files({ "C:\\npm\\grok.exe": "" });
    const resolved = resolveForSpawn("grok", ["--single", "a & b"], { platform: "win32", env, node: "C:\\node.exe", ...fs });
    expect(resolved.command.toLowerCase()).toBe("c:\\npm\\grok.exe");
    expect(resolved.args).toEqual(["--single", "a & b"]);
  });

  it("runs the node script behind a .cmd shim with node, never through cmd.exe", () => {
    const fs = files({ "C:\\npm\\codex.cmd": NPM_NODE_SHIM });
    const resolved = resolveForSpawn("codex", ["exec", "line one\nline two & calc"], { platform: "win32", env, node: "C:\\node\\node.exe", ...fs });
    expect(resolved).toEqual({
      command: "C:\\node\\node.exe",
      args: ["C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js", "exec", "line one\nline two & calc"],
    });
  });

  it("runs the binary behind a .cmd shim directly", () => {
    const fs = files({ "C:\\npm\\claude.cmd": NPM_EXE_SHIM });
    expect(resolveForSpawn("claude", ["-p", "x"], { platform: "win32", env, node: "C:\\node.exe", ...fs }).command).toBe(
      "C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe",
    );
  });

  it("prefers PATHEXT order within a directory and PATH order across directories", () => {
    const fs = files({ "C:\\Windows\\System32\\git.cmd": NPM_EXE_SHIM, "C:\\Windows\\System32\\git.exe": "", "C:\\npm\\git.exe": "" });
    expect(resolveForSpawn("git", [], { platform: "win32", env, node: "C:\\node.exe", ...fs }).command.toLowerCase()).toBe("c:\\windows\\system32\\git.exe");
  });

  it("refuses a batch file it cannot run without a shell", () => {
    const fs = files({ "C:\\npm\\agy.bat": "@echo off\r\ncall other.bat %*\r\n" });
    expect(() => resolveForSpawn("agy", [], { platform: "win32", env, node: "C:\\node.exe", ...fs })).toThrow(/without cmd\.exe/);
  });

  it("leaves an unknown command for spawn to report as missing", () => {
    expect(resolveForSpawn("nope", ["a"], { platform: "win32", env, node: "C:\\node.exe", ...files({}) })).toEqual({ command: "nope", args: ["a"] });
  });
});

describe("maxCommandLine", () => {
  it("is tighter on Windows, whose whole command line is capped at 32K characters", () => {
    expect(maxCommandLine("win32")).toBeLessThan(32_767);
    expect(maxCommandLine("linux")).toBeLessThan(131_072);
    expect(maxCommandLine("win32")).toBeLessThan(maxCommandLine("linux"));
  });
});

describe("sessionsSupported", () => {
  it("is off on Windows only", async () => {
    const { sessionsSupported } = await import("../src/platform.js");
    expect(sessionsSupported("win32")).toBe(false);
    expect(sessionsSupported("darwin")).toBe(true);
    expect(sessionsSupported("linux")).toBe(true);
  });
});
