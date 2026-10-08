import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agy, agyPrepare, containmentProblems, findCustomizations, type AgyConfig } from "../src/adapters/agy.js";
import { describeLine } from "../src/narrate.js";
import type { AskRequest, RunResult } from "../src/types.js";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const base: AskRequest = { agent: "agy", question: "q", cwd: "/repo" };
const valueAfter = (args: readonly string[], flag: string) => args[args.indexOf(flag) + 1];

const STRICT = JSON.stringify({ toolPermission: "strict" });
const NO_MCP = "NAME  TYPE  STATUS  COMMAND/URL\n";
const NO_PLUGINS = "No imported plugins.\n";
const MCP_LIST = [
  "NAME             TYPE   STATUS    COMMAND/URL",
  "DaVinci Resolve  stdio  enabled   /Applications/ResolveMCP",
  "consult          stdio  disabled  node serve",
].join("\n");

describe("agy adapter", () => {
  it("runs a headless prompt with streamed JSON and no slash commands", () => {
    const inv = agy.build(base, "PROMPT", []);
    expect(inv.command).toBe("agy");
    expect(valueAfter(inv.args, "-p")).toMatch(/^Use only your file tools.*\n\nPROMPT$/s);
    expect(valueAfter(inv.args, "--output-format")).toBe("stream-json");
    expect(inv.args).toContain("--disable-slash-commands");
    expect(inv.args).not.toContain("--conversation");
  });

  it("resumes a conversation and passes model and effort", () => {
    const inv = agy.build({ ...base, sessionId: "cid", model: "gemini-3.1-pro-high", effort: "low" }, "P", []);
    expect(valueAfter(inv.args, "--conversation")).toBe("cid");
    expect(valueAfter(inv.args, "--model")).toBe("gemini-3.1-pro-high");
    expect(valueAfter(inv.args, "--effort")).toBe("low");
  });

  it("cannot fork live sessions", () => {
    expect(() => agy.fork("SRC", base, "P", [])).toThrow(/cannot fork/);
  });

  it("parses the result event", () => {
    expect(agy.parse(fixture("agy.jsonl"))).toEqual({ answer: "pineapple", sessionId: "7e7c2119-d88d-4094-b96c-1e20b1417675" });
  });

  it("throws when agy reports an error", () => {
    const out = JSON.stringify({ event: "result", result: { conversation_id: "", status: "ERROR", response: "", error: "authentication failed" } });
    expect(() => agy.parse(out)).toThrow(/authentication failed/);
  });

  it("says which tools were denied when agy stops without an answer", () => {
    const out = JSON.stringify({
      event: "result",
      result: { conversation_id: "c", status: "SUCCESS", response: "", denied_actions: [{ action: "command", display_name: "RunCommand" }] },
    });
    expect(() => agy.parse(out)).toThrow(/denied: command/);
  });

  it("throws when there is no result", () => {
    expect(() => agy.parse('{"event":"init","conversation_id":"c"}')).toThrow(/no result/);
  });

  it("narrates tool calls and failures, not text fragments", () => {
    const lines = fixture("agy.jsonl").split("\n").flatMap((l) => describeLine(agy.describe!, l) ?? []);
    expect(lines).toEqual([
      "view_file /repo/a.txt",
      "$ cat a.txt",
      "run_command failed: run_command required the permission that headless mode cannot prompt for, so it was auto-denied.",
    ]);
  });
});

const config = (over: Partial<AgyConfig> = {}): AgyConfig => ({
  settings: STRICT,
  mcpList: NO_MCP,
  pluginList: NO_PLUGINS,
  customizations: [],
  ...over,
});

describe("agy containment", () => {
  it("is contained with strict permissions, no allow rules, no MCP servers, plugins or hooks", () => {
    expect(containmentProblems(config())).toEqual([]);
    expect(containmentProblems(config({ settings: JSON.stringify({ toolPermission: "strict", permissions: { allow: [], deny: ["command(rm)"] } }) }))).toEqual([]);
  });

  it("requires a toolPermission that reviews tools, which headless mode then denies", () => {
    expect(containmentProblems(config({ settings: undefined }))).toEqual([]);
    expect(containmentProblems(config({ settings: "{}" }))).toEqual([]);
    expect(containmentProblems(config({ settings: JSON.stringify({ toolPermission: "request-review" }) }))).toEqual([]);
    expect(containmentProblems(config({ settings: JSON.stringify({ toolPermission: "always-proceed" }) }))).toEqual([
      expect.stringMatching(/toolPermission is "always-proceed", not "request-review"/),
    ]);
    expect(containmentProblems(config({ settings: JSON.stringify({ toolPermission: "proceed-in-sandbox" }) }))).toHaveLength(1);
  });

  it("refuses any allow rules, which let tools run without review", () => {
    for (const allow of [["command(git diff)"], "command(ls)", { a: 1 }]) {
      const settings = JSON.stringify({ toolPermission: "strict", permissions: { allow } });
      expect(containmentProblems(config({ settings }))).toEqual([expect.stringMatching(/permissions\.allow/)]);
    }
  });

  it("refuses settings that are not a JSON object", () => {
    expect(containmentProblems(config({ settings: "{not json" }))).toEqual([expect.stringMatching(/parse/)]);
    expect(containmentProblems(config({ settings: "null" }))).toEqual([expect.stringMatching(/not a JSON object/)]);
  });

  it("names every MCP server that is not disabled", () => {
    expect(containmentProblems(config({ mcpList: MCP_LIST }))).toEqual([expect.stringMatching(/MCP servers enabled: DaVinci Resolve$/)]);
  });

  it("fails closed on MCP or plugin output it does not recognise, including none", () => {
    expect(containmentProblems(config({ mcpList: "" }))).toEqual([expect.stringMatching(/mcp list/)]);
    expect(containmentProblems(config({ mcpList: "something new" }))).toEqual([expect.stringMatching(/mcp list/)]);
    expect(containmentProblems(config({ pluginList: "agmux  enabled" }))).toEqual([expect.stringMatching(/plugin/)]);
  });

  it("refuses when hooks or plugins could load", () => {
    expect(containmentProblems(config({ customizations: ["/h/.gemini/config/hooks.json"] }))).toEqual([
      expect.stringMatching(/hooks or plugins could load from \/h\/.gemini\/config\/hooks.json/),
    ]);
  });
});

describe("agy customizations", () => {
  const tree = () => mkdtempSync(join(tmpdir(), "consult-agy-"));

  it("finds non-empty global hook files and plugin dirs, ignoring empty or missing ones", () => {
    const home = tree();
    writeFileSync(join(home, "hooks.json"), '{"PreToolUse":[]}');
    writeFileSync(join(home, "empty.json"), " \n");
    mkdirSync(join(home, "plugins", "agmux"), { recursive: true });
    mkdirSync(join(home, "no-plugins"));
    const globals = ["hooks.json", "empty.json", "plugins", "no-plugins", "missing"].map((p) => join(home, p));
    expect(findCustomizations(tree(), globals)).toEqual([join(home, "hooks.json"), join(home, "plugins")]);
  });

  it("finds workspace customization roots from the cwd up to the repository root, not above it", () => {
    const outer = tree();
    const repo = join(outer, "repo");
    const sub = join(repo, "pkg");
    mkdirSync(join(repo, ".git"), { recursive: true });
    mkdirSync(join(sub, "_agent"), { recursive: true });
    writeFileSync(join(sub, "_agent", "hooks.json"), "{}");
    mkdirSync(join(repo, ".agents", "plugins"), { recursive: true });
    mkdirSync(join(outer, ".agents", "skills"), { recursive: true });
    expect(findCustomizations(sub, [])).toEqual([join(sub, "_agent"), join(repo, ".agents")]);
  });

  it("checks only the cwd outside a repository", () => {
    const dir = tree();
    mkdirSync(join(dir, ".agent", "x"), { recursive: true });
    expect(findCustomizations(dir, [])).toEqual([join(dir, ".agent")]);
  });
});

describe("agy prepare", () => {
  const settingsFile = (text?: string) => {
    const file = join(mkdtempSync(join(tmpdir(), "consult-agy-")), "settings.json");
    if (text !== undefined) writeFileSync(file, text);
    return file;
  };
  const fakeRun = (mcp: string, plugins = NO_PLUGINS, code = 0) => {
    const calls: string[][] = [];
    const run = async (cmd: string, args: readonly string[]): Promise<RunResult> => {
      calls.push([cmd, ...args]);
      return { stdout: args[0] === "mcp" ? mcp : plugins, stderr: code ? "boom" : "", code };
    };
    return { run, calls };
  };
  const cwd = () => mkdtempSync(join(tmpdir(), "consult-agy-cwd-"));

  it("adds no args when agy is contained, checking MCP servers and plugins in the cwd's config", async () => {
    const { run, calls } = fakeRun(NO_MCP);
    expect(await agyPrepare(settingsFile(STRICT), [])(run, cwd())).toEqual([]);
    expect(calls).toEqual([["agy", "mcp", "list"], ["agy", "plugin", "list"]]);
  });

  it("refuses to run, with what to change, when agy is not contained", async () => {
    const { run } = fakeRun(MCP_LIST);
    const settings = settingsFile(JSON.stringify({ toolPermission: "always-proceed" }));
    await expect(agyPrepare(settings, [])(run, cwd())).rejects.toThrow(/not read-only.*toolPermission.*DaVinci Resolve/s);
  });

  it("refuses to run when a global hook file exists", async () => {
    const hooks = settingsFile('{"PreToolUse":[]}');
    const { run } = fakeRun(NO_MCP);
    await expect(agyPrepare(settingsFile(STRICT), [hooks])(run, cwd())).rejects.toThrow(/hooks or plugins could load/);
  });

  it("refuses to run when agy cannot list its MCP servers", async () => {
    const { run } = fakeRun("", NO_PLUGINS, 1);
    await expect(agyPrepare(settingsFile(STRICT), [])(run, cwd())).rejects.toThrow(/boom/);
  });
});
