import { chmodSync, existsSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  codexConfigPath,
  codexTomlBlock,
  findOnPath,
  install,
  registerCodex,
  removeTomlTable,
  serverCommand,
  uninstall,
  unregisterCodex,
} from "../src/install.js";
import type { Runner } from "../src/types.js";

function binDir(names: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "consult-bin-"));
  for (const name of names) {
    writeFileSync(join(dir, name), "#!/bin/sh\n");
    chmodSync(join(dir, name), 0o755);
  }
  return dir;
}

const tmpConfig = () => join(mkdtempSync(join(tmpdir(), "consult-home-")), "config.toml");
const local = { command: "/n", args: ["/s.js", "serve"], path: "/bin" };

describe("codexTomlBlock", () => {
  it("writes a stdio server table with a raised tool timeout and quoted paths", () => {
    const block = codexTomlBlock({ command: "/usr/bin/node", args: ['/a b/"cli".js', "serve"], path: "/bin:/usr/bin" });
    expect(block).toContain("[mcp_servers.consult]");
    expect(block).toContain('command = "/usr/bin/node"');
    expect(block).toContain('args = ["/a b/\\"cli\\".js", "serve"]');
    expect(block).toContain("tool_timeout_sec = 960");
    expect(block).toContain("startup_timeout_sec = 60");
    expect(block).toContain('env = { PATH = "/bin:/usr/bin" }');
  });
});

describe("removeTomlTable", () => {
  it("removes the table and its subtables and keeps everything else", () => {
    const toml = [
      'model = "gpt-6-astra"',
      "",
      "[mcp_servers.consult]",
      'command = "/old/node"',
      "",
      "[mcp_servers.consult.env]",
      'PATH = "/bin"',
      "",
      "[mcp_servers.consultant]",
      'command = "keep"',
      "",
      "[[profiles]]",
      'name = "x"',
      "",
    ].join("\n");
    const out = removeTomlTable(toml, "mcp_servers.consult");
    expect(out).not.toContain("/old/node");
    expect(out).not.toContain('PATH = "/bin"');
    expect(out).toContain('model = "gpt-6-astra"');
    expect(out).toContain("[mcp_servers.consultant]");
    expect(out).toContain("[[profiles]]");
  });

  it("keeps neighbours with quoted keys, CRLF endings and the comment above them", () => {
    const toml = [
      "[mcp_servers.consult]",
      'command = "/old"',
      "",
      "# my github server",
      "[mcp_servers.'my-srv'] # gh",
      'command = "a"',
      '[mcp_servers."my srv"]',
      'command = "b"',
      "",
    ].join("\r\n");
    const out = removeTomlTable(toml, "mcp_servers.consult");
    expect(out).not.toContain("/old");
    expect(out).toContain("# my github server");
    expect(out).toContain("[mcp_servers.'my-srv'] # gh");
    expect(out).toContain('[mcp_servers."my srv"]');
  });

  it("removes a quoted spelling of the table name", () => {
    expect(removeTomlTable('[mcp_servers."consult"]\ncommand = "x"\n', "mcp_servers.consult").trim()).toBe("");
  });

  it("does not treat nested array lines as table headers", () => {
    const toml = ["[mcp_servers.consult]", "args = [", '  ["a", "b"],', "]", "", "[other]", "x = 1", ""].join("\n");
    expect(removeTomlTable(toml, "mcp_servers.consult").trim()).toBe("[other]\nx = 1");
  });
});

describe("registerCodex", () => {
  it("creates the config file and its directory when codex has none yet", () => {
    const config = join(mkdtempSync(join(tmpdir(), "consult-home-")), ".codex", "config.toml");
    expect(registerCodex(local, config)).toMatch(/registered/);
    expect(readFileSync(config, "utf8")).toContain("[mcp_servers.consult]");
  });

  it("replaces an older registration instead of duplicating it", () => {
    const config = tmpConfig();
    writeFileSync(config, 'model = "gpt-6-astra"\n');
    registerCodex(local, config);
    const npx = { command: "/bin/npx", args: ["-y", "consult-mcp@latest", "serve"], path: "/bin" };
    expect(registerCodex(npx, config)).toMatch(/updated/);
    const text = readFileSync(config, "utf8");
    expect(text.startsWith('model = "gpt-6-astra"\n')).toBe(true);
    expect(text.match(/\[mcp_servers\.consult\]/g)).toHaveLength(1);
    expect(text).toContain('command = "/bin/npx"');
    expect(text).not.toContain("/s.js");
  });
});

describe("codex config safety", () => {
  it("refuses to touch a config it cannot parse", () => {
    const config = tmpConfig();
    writeFileSync(config, "model = \n[broken");
    expect(() => registerCodex(local, config)).toThrow(/could not parse/);
    expect(readFileSync(config, "utf8")).toBe("model = \n[broken");
  });

  it("refuses when consult is defined in a form it cannot remove, instead of writing a duplicate", () => {
    const config = tmpConfig();
    const original = '[mcp_servers]\nconsult = { command = "/old" }\n';
    writeFileSync(config, original);
    expect(() => registerCodex(local, config)).toThrow(/by hand/);
    expect(readFileSync(config, "utf8")).toBe(original);
  });

  it("keeps a backup of the previous config", () => {
    const config = tmpConfig();
    writeFileSync(config, 'model = "m"\n');
    registerCodex(local, config);
    expect(readFileSync(`${config}.bak`, "utf8")).toBe('model = "m"\n');
  });

  it("reads CODEX_HOME like codex does", () => {
    expect(codexConfigPath({ CODEX_HOME: "/custom" })).toBe(join("/custom", "config.toml"));
    expect(codexConfigPath({})).toMatch(/\.codex[\/\\]config\.toml$/);
  });
});

describe("unregisterCodex", () => {
  it("removes the table and says so, or reports that nothing was there", () => {
    const config = tmpConfig();
    writeFileSync(config, 'model = "m"\n');
    registerCodex(local, config);
    expect(unregisterCodex(config)).toMatch(/removed/);
    expect(readFileSync(config, "utf8").trim()).toBe('model = "m"');
    expect(unregisterCodex(config)).toMatch(/not registered/);
    expect(unregisterCodex(join(tmpdir(), "does-not-exist", "config.toml"))).toMatch(/not registered/);
  });
});

describe("install", () => {
  it("skips CLIs that are not installed and reports failures without stopping", async () => {
    const run = async () => ({ stdout: "", stderr: "denied", code: 1 });
    const results = await install(run, local, ["claude"]);
    expect(results).toEqual([
      { agent: "claude", ok: false, message: expect.stringMatching(/claude mcp add failed: denied/) },
      { agent: "codex", ok: true, message: "codex: not installed, skipped" },
      { agent: "grok", ok: true, message: "grok: not installed, skipped" },
    ]);
  });

  it("replaces an existing registration so re-running install upgrades it", async () => {
    const run = vi.fn<Runner>(async () => ({ stdout: "", stderr: "", code: 0 }));
    const results = await install(run, local, ["claude", "grok"]);
    const calls = run.mock.calls.map(([cmd, args]) => [cmd, ...args].join(" "));
    expect(calls).toEqual([
      "claude mcp remove consult -s user",
      "claude mcp add consult --scope user -e PATH=/bin -- /n /s.js serve",
      "grok mcp remove consult -s user",
      "grok mcp add consult -e PATH=/bin -- /n /s.js serve",
    ]);
    expect(results.map((r) => r.message)).toEqual([
      "claude: updated (user scope)",
      "codex: not installed, skipped",
      "grok: updated (user scope)",
    ]);
  });
});

describe("uninstall", () => {
  it("removes the server from each installed CLI", async () => {
    const run = vi.fn<Runner>(async (cmd) => ({ stdout: "", stderr: cmd === "grok" ? "no such server" : "", code: cmd === "grok" ? 1 : 0 }));
    const results = await uninstall(run, ["claude", "grok"]);
    expect(run.mock.calls.map(([cmd, args]) => [cmd, ...args].join(" "))).toEqual([
      "claude mcp remove consult -s user",
      "grok mcp remove consult -s user",
    ]);
    expect(results.map((r) => r.message)).toEqual([
      "claude: removed",
      "codex: not installed, skipped",
      "grok: not registered (no such server)",
    ]);
  });
});

describe("findOnPath", () => {
  it("returns the first executable match without resolving symlinks", () => {
    const real = binDir(["node"]);
    const shims = mkdtempSync(join(tmpdir(), "consult-shim-"));
    symlinkSync(join(real, "node"), join(shims, "node"));
    expect(findOnPath("node", `/nonexistent:${shims}:${real}`)).toBe(join(shims, "node"));
    expect(findOnPath("missing", real)).toBeUndefined();
  });
});

describe("serverCommand", () => {
  it("pins a local checkout to node and the script, with a minimal PATH", () => {
    const a = binDir(["node", "claude"]);
    const b = binDir(["codex"]);
    const noise = binDir(["unrelated"]);
    const cmd = serverCommand("/x/cli.js", [noise, a, b].join(":"));
    expect(cmd.command).toBe(join(a, "node"));
    expect(cmd.args).toEqual(["/x/cli.js", "serve"]);
    expect(cmd.path.split(":")).toEqual([a, b, "/usr/bin", "/bin", "/usr/sbin", "/sbin"]);
  });

  it("launches through npx @latest when run from the npx cache, so hosts always get the newest release", () => {
    const a = binDir(["node", "npx", "grok"]);
    const cmd = serverCommand("/home/u/.npm/_npx/abc123/node_modules/consult-mcp/dist/cli.js", a);
    expect(cmd.command).toBe(join(a, "npx"));
    expect(cmd.args).toEqual(["-y", "consult-mcp@latest", "serve"]);
    expect(cmd.path.split(":")[0]).toBe(a);
  });

  it("refuses to register a temporary package-runner cache path", () => {
    const a = binDir(["node"]);
    expect(() => serverCommand("/home/u/.npm/_npx/abc/node_modules/consult-mcp/dist/cli.js", a)).toThrow(/npx not found/);
    expect(() => serverCommand("/tmp/bunx-501-consult-mcp@latest/node_modules/consult-mcp/dist/cli.js", a)).toThrow(/npx/);
  });

  it("fails clearly when node is not on PATH", () => {
    expect(() => serverCommand("/x/cli.js", binDir(["claude"]))).toThrow(/node not found/);
  });
});
