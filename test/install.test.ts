import { chmodSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { codexTomlBlock, findOnPath, install, registerCodex, serverCommand } from "../src/install.js";

function binDir(names: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "consult-bin-"));
  for (const name of names) {
    writeFileSync(join(dir, name), "#!/bin/sh\n");
    chmodSync(join(dir, name), 0o755);
  }
  return dir;
}

describe("codexTomlBlock", () => {
  it("writes a stdio server table with a raised tool timeout and quoted paths", () => {
    const block = codexTomlBlock({ node: "/usr/bin/node", script: '/a b/"cli".js', path: "/bin:/usr/bin" });
    expect(block).toContain("[mcp_servers.consult]");
    expect(block).toContain('command = "/usr/bin/node"');
    expect(block).toContain('args = ["/a b/\\"cli\\".js", "serve"]');
    expect(block).toContain("tool_timeout_sec = 960");
    expect(block).toContain('env = { PATH = "/bin:/usr/bin" }');
  });
});

describe("registerCodex", () => {
  const cmd = { node: "/n", script: "/s.js", path: "/bin" };

  it("creates the config file and its directory when codex has none yet", () => {
    const config = join(mkdtempSync(join(tmpdir(), "consult-home-")), ".codex", "config.toml");
    expect(registerCodex(cmd, config)).toMatch(/registered/);
    expect(readFileSync(config, "utf8")).toContain("[mcp_servers.consult]");
  });

  it("appends to an existing config once", () => {
    const config = join(mkdtempSync(join(tmpdir(), "consult-home-")), "config.toml");
    writeFileSync(config, 'model = "gpt-6-astra"\n');
    registerCodex(cmd, config);
    expect(registerCodex(cmd, config)).toMatch(/already registered/);
    const text = readFileSync(config, "utf8");
    expect(text.startsWith('model = "gpt-6-astra"\n')).toBe(true);
    expect(text.match(/\[mcp_servers\.consult\]/g)).toHaveLength(1);
  });
});

describe("install", () => {
  it("skips CLIs that are not installed and reports failures without stopping", async () => {
    const run = async () => ({ stdout: "", stderr: "denied", code: 1 });
    const results = await install(run, { node: "/n", script: "/s.js", path: "/bin" }, ["claude"]);
    expect(results).toEqual([
      { agent: "claude", ok: false, message: expect.stringMatching(/claude mcp add failed: denied/) },
      { agent: "codex", ok: true, message: "codex: not installed, skipped" },
      { agent: "grok", ok: true, message: "grok: not installed, skipped" },
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
  it("builds a minimal PATH from node, the installed agent CLIs and system dirs", () => {
    const a = binDir(["node", "claude"]);
    const b = binDir(["codex"]);
    const noise = binDir(["unrelated"]);
    const cmd = serverCommand("/x/cli.js", [noise, a, b].join(":"));
    expect(cmd.node).toBe(join(a, "node"));
    expect(cmd.path.split(":")).toEqual([a, b, "/usr/bin", "/bin", "/usr/sbin", "/sbin"]);
  });

  it("fails clearly when node is not on PATH", () => {
    expect(() => serverCommand("/x/cli.js", binDir(["claude"]))).toThrow(/node not found/);
  });
});
