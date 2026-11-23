import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agy, CONTAINMENT_SETTINGS, findWorkspaceHooks, versionAtLeast } from "../src/adapters/agy.js";
import { describeLine } from "../src/narrate.js";
import type { AskRequest, RunResult } from "../src/types.js";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const base: AskRequest = { agent: "agy", question: "q", cwd: "/repo" };
const valueAfter = (args: readonly string[], flag: string) => args[args.indexOf(flag) + 1];

describe("agy adapter", () => {
  it("runs a headless prompt with streamed JSON and no slash commands", () => {
    const inv = agy.build(base, "PROMPT", []);
    expect(inv.command).toBe("agy");
    expect(valueAfter(inv.args, "-p")).toMatch(/^You are advising read-only\..*\n\nPROMPT$/s);
    expect(valueAfter(inv.args, "--output-format")).toBe("stream-json");
    expect(inv.args).toContain("--disable-slash-commands");
    expect(inv.args).not.toContain("--conversation");
  });

  it("denies every tool that can change anything, on every call, whatever agy's own config says", () => {
    for (const request of [base, { ...base, sessionId: "cid" }]) {
      const settings = JSON.parse(valueAfter(agy.build(request, "P", []).args, "--settings")!);
      expect(settings).toEqual({
        toolPermission: "request-review",
        permissions: {
          allow: [],
          deny: ["command(*)", "write_file(*)", "mcp(*)", "read_url(*)", "download_url(*)", "execute_url(*)"],
        },
      });
    }
    expect(valueAfter(agy.build(base, "P", []).args, "--settings")).toBe(CONTAINMENT_SETTINGS);
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

  const hookStep = (tool: string, state = "ERROR", message = "tool call denied by pre-tool hook:") =>
    JSON.stringify({ event: "step_update", step_update: { step_type: "tool", state, tool_name: tool, tool_info: state === "ERROR" ? { error: { message } } : {} } });
  const okResult = (response: string) => JSON.stringify({ event: "result", result: { conversation_id: "c", status: "SUCCESS", response } });

  it("refuses an answer written after a hook denied every read, and names the hook as the cause", () => {
    const out = [hookStep("read_file"), hookStep("read_file"), hookStep("run_command"), okResult("I could not read it.")].join("\n");
    expect(() => agy.parse(out)).toThrow(/hook denied read_file, so agy could not read.*print nothing/s);
  });

  it("keeps the answer when a hook blocked some reads or other tools but a read got through", () => {
    const partial = [hookStep("read_file"), hookStep("read_file", "DONE"), okResult("answer")].join("\n");
    expect(agy.parse(partial)).toEqual({ answer: "answer", sessionId: "c" });
    const notReads = [hookStep("run_command"), okResult("answer")].join("\n");
    expect(agy.parse(notReads)).toEqual({ answer: "answer", sessionId: "c" });
  });

  it("keeps the answer when only consult's deny rules refused a tool", () => {
    const denied = JSON.stringify({
      event: "step_update",
      step_update: { step_type: "tool", state: "ERROR", tool_name: "run_command", tool_info: { error: { message: "Permission denied for command(ls). Matches user-configured deny rule." } } },
    });
    const result = JSON.stringify({ event: "result", result: { conversation_id: "c", status: "SUCCESS", response: "answer" } });
    expect(agy.parse(`${denied}\n${result}`)).toEqual({ answer: "answer", sessionId: "c" });
  });
});

describe("agy version check", () => {
  it("compares dotted versions numerically", () => {
    expect(versionAtLeast("1.5.14", "1.5.14")).toBe(true);
    expect(versionAtLeast("agy 1.5.15\n", "1.5.14")).toBe(true);
    expect(versionAtLeast("1.10.0", "1.5.14")).toBe(true);
    expect(versionAtLeast("2.0.0", "1.5.14")).toBe(true);
    expect(versionAtLeast("1.5.9", "1.5.14")).toBe(false);
    expect(versionAtLeast("1.4.20", "1.5.14")).toBe(false);
    expect(versionAtLeast("", "1.5.14")).toBe(false);
    expect(versionAtLeast("unknown", "1.5.14")).toBe(false);
    expect(versionAtLeast("1.5.14-rc.1", "1.5.14")).toBe(false);
    expect(versionAtLeast("update available: 9.0.0\n1.5.9", "1.5.14")).toBe(false);
  });
});

describe("agy workspace hooks", () => {
  const tree = () => realpathSync(mkdtempSync(join(tmpdir(), "consult-agy-")));

  it("finds hook and plugin files from the cwd up to the repository root, not above it", () => {
    const outer = tree();
    const repo = join(outer, "repo");
    const sub = join(repo, "pkg");
    mkdirSync(join(repo, ".git"), { recursive: true });
    mkdirSync(join(sub, "_agent"), { recursive: true });
    writeFileSync(join(sub, "_agent", "hooks.json"), "{}");
    mkdirSync(join(repo, ".agents", "plugins", "p"), { recursive: true });
    writeFileSync(join(repo, ".agents", "plugins.json"), "{}");
    mkdirSync(join(outer, ".agents"), { recursive: true });
    writeFileSync(join(outer, ".agents", "hooks.json"), "{}");
    expect(findWorkspaceHooks(sub)).toEqual([
      join(sub, "_agent", "hooks.json"),
      join(repo, ".agents", "plugins.json"),
      join(repo, ".agents", "plugins"),
    ]);
  });

  it("ignores skills, rules, workflows and empty hook files, which run no commands", () => {
    const repo = tree();
    mkdirSync(join(repo, ".git"));
    mkdirSync(join(repo, ".agents", "skills", "s"), { recursive: true });
    mkdirSync(join(repo, ".agents", "rules"), { recursive: true });
    mkdirSync(join(repo, ".agents", "plugins"), { recursive: true });
    writeFileSync(join(repo, ".agents", "rules", "r.md"), "be nice");
    writeFileSync(join(repo, ".agents", "hooks.json"), "");
    expect(findWorkspaceHooks(repo)).toEqual([]);
  });

  it("follows a symlinked cwd to the real repository it points into", () => {
    const repo = tree();
    mkdirSync(join(repo, ".git"));
    mkdirSync(join(repo, "pkg"));
    mkdirSync(join(repo, ".agents"));
    writeFileSync(join(repo, ".agents", "hooks.json"), "{}");
    const link = join(tree(), "link");
    symlinkSync(join(repo, "pkg"), link);
    expect(findWorkspaceHooks(link)).toEqual([join(repo, ".agents", "hooks.json")]);
  });

  it("checks only the cwd outside a repository", () => {
    const dir = tree();
    mkdirSync(join(dir, ".agent"), { recursive: true });
    writeFileSync(join(dir, ".agent", "hooks.json"), "{}");
    expect(findWorkspaceHooks(dir)).toEqual([join(dir, ".agent", "hooks.json")]);
  });
});

describe("agy prepare", () => {
  const fakeRun = (stdout: string, code = 0) => {
    const calls: string[][] = [];
    const run = async (cmd: string, args: readonly string[]): Promise<RunResult> => {
      calls.push([cmd, ...args]);
      return { stdout, stderr: "", code };
    };
    return { run, calls };
  };
  const cwd = () => mkdtempSync(join(tmpdir(), "consult-agy-cwd-"));

  it("adds no args for a new enough agy in a repository without hooks, whatever agy's global config", async () => {
    const { run, calls } = fakeRun("1.5.14\n");
    expect(await agy.prepare!(run, cwd())).toEqual([]);
    expect(calls).toEqual([["agy", "--version"]]);
  });

  it("refuses an agy older than the deny rules were verified on, or one that cannot report its version", async () => {
    await expect(agy.prepare!(fakeRun("1.5.9\n").run, cwd())).rejects.toThrow(/needs agy 1\.5\.14 or later.*found 1\.5\.9.*agy update/);
    await expect(agy.prepare!(fakeRun("", 1).run, cwd())).rejects.toThrow(/found no version/);
  });

  it("refuses to run where the repository has agy hooks", async () => {
    const dir = cwd();
    mkdirSync(join(dir, ".agents"));
    writeFileSync(join(dir, ".agents", "hooks.json"), '{"PreToolUse":[]}');
    await expect(agy.prepare!(fakeRun("1.5.14").run, dir)).rejects.toThrow(/repository has agy hooks or plugins.*hooks\.json/);
  });
});
