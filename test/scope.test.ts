import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { run } from "../src/run.js";
import { gitBranch, inScope, repoKey } from "../src/sessions/scope.js";
import type { Runner } from "../src/types.js";

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), "consult-scope-")));
const reply = (stdout: string, code = 0) => vi.fn<Runner>(async () => ({ stdout, stderr: "", code }));

describe("repoKey", () => {
  it("resolves a relative git common dir against the cwd", async () => {
    const dir = tmp();
    expect(await repoKey(reply(".git\n"), dir)).toBe(join(dir, ".git"));
  });

  it("falls back to the directory outside a git repo", async () => {
    const dir = tmp();
    expect(await repoKey(reply("", 128), dir)).toBe(dir);
  });

  it("falls back to the directory when git is not installed", async () => {
    const dir = tmp();
    const missing = vi.fn<Runner>(async () => {
      throw new Error("git CLI not found on PATH");
    });
    expect(await repoKey(missing, dir)).toBe(dir);
  });

  it("gives every worktree of a repository the same key, and other repos a different one", async () => {
    const main = tmp();
    const git = (cwd: string, ...args: string[]) =>
      run("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, timeoutMs: 10_000 });
    await git(main, "init", "-q");
    await git(main, "commit", "-q", "--allow-empty", "-m", "init");
    const worktree = join(tmp(), "wt");
    expect((await git(main, "worktree", "add", "-q", worktree, "-b", "feature")).code).toBe(0);
    expect(await repoKey(run, worktree)).toBe(await repoKey(run, main));
    expect(await repoKey(run, tmp())).not.toBe(await repoKey(run, main));
  });
});

describe("gitBranch", () => {
  it("returns the current branch", async () => {
    expect(await gitBranch(reply("main\n"), "/r")).toBe("main");
  });

  it("returns undefined for a detached HEAD or outside git", async () => {
    expect(await gitBranch(reply("HEAD\n"), "/r")).toBeUndefined();
    expect(await gitBranch(reply("", 128), "/r")).toBeUndefined();
  });
});

describe("inScope", () => {
  it("matches only the same repo in repo scope, and everything in machine scope", () => {
    const a = { repoKey: "/a/.git" };
    const b = { repoKey: "/b/.git" };
    expect(inScope(a, { repoKey: "/a/.git" }, "repo")).toBe(true);
    expect(inScope(a, b, "repo")).toBe(false);
    expect(inScope(a, b, "machine")).toBe(true);
  });
});
