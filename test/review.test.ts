import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { collectChanges, MAX_DIFF_BYTES, reviewQuestion } from "../src/review.js";
import { maxCommandLine } from "../src/platform.js";
import { run } from "../src/run.js";
import { AdvisorError } from "../src/types.js";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd, stdio: "pipe" });

function repo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "consult-review-")));
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

describe("collectChanges", () => {
  it("returns staged and unstaged changes against HEAD, plus untracked files", async () => {
    const dir = repo();
    writeFileSync(join(dir, "a.ts"), "export const a = 2;\n");
    writeFileSync(join(dir, "new.ts"), "export const n = 1;\n");
    const changes = await collectChanges(run, dir);
    expect(changes.diff).toContain("-export const a = 1;");
    expect(changes.diff).toContain("+export const a = 2;");
    expect(changes.stat).toContain("a.ts");
    expect(changes.untracked).toEqual(["new.ts"]);
    expect(changes.truncated).toBe(false);
    expect(realpathSync.native(changes.root)).toBe(realpathSync.native(dir));
  });

  it("covers the whole repository from a subdirectory, with root-relative paths", async () => {
    const dir = repo();
    mkdirSync(join(dir, "pkg"));
    writeFileSync(join(dir, "a.ts"), "export const a = 2;\n");
    writeFileSync(join(dir, "top-new.ts"), "1\n");
    writeFileSync(join(dir, "pkg", "inner.ts"), "1\n");
    const changes = await collectChanges(run, join(dir, "pkg"));
    expect(realpathSync.native(changes.root)).toBe(realpathSync.native(dir));
    expect(changes.untracked.sort()).toEqual(["pkg/inner.ts", "top-new.ts"]);
    expect(changes.diff).toContain("a/a.ts");
  });

  it("reports a missing directory and a cancelled review as such", async () => {
    await expect(collectChanges(run, "/no/such/dir")).rejects.toThrow(/not a directory/);
    const dir = repo();
    writeFileSync(join(dir, "a.ts"), "2\n");
    await expect(collectChanges(run, dir, undefined, AbortSignal.abort())).rejects.toThrow(/cancelled/);
  });

  it("diffs against the merge base of a branch, including uncommitted work", async () => {
    const dir = repo();
    git(dir, "checkout", "-q", "-b", "feature");
    writeFileSync(join(dir, "a.ts"), "export const a = 3;\n");
    git(dir, "commit", "-q", "-am", "change");
    writeFileSync(join(dir, "b.ts"), "x\n");
    git(dir, "add", "b.ts");
    const changes = await collectChanges(run, dir, "main");
    expect(changes.diff).toContain("+export const a = 3;");
    expect(changes.diff).toContain("b.ts");
    expect(changes.base).toBe("main");
  });

  it("works in a repository with no commits yet", async () => {
    const dir = mkdtempSync(join(tmpdir(), "consult-review-"));
    git(dir, "init", "-q");
    writeFileSync(join(dir, "first.ts"), "1\n");
    git(dir, "add", ".");
    writeFileSync(join(dir, "first.ts"), "2\n");
    const changes = await collectChanges(run, dir);
    expect(changes.diff).toContain("+1");
    expect(changes.diff).toContain("+2");
  });

  it("refuses a directory outside git, a clean tree, and a base that could be a flag", async () => {
    await expect(collectChanges(run, mkdtempSync(join(tmpdir(), "consult-nogit-")))).rejects.toThrow(/not inside a git repository/);
    await expect(collectChanges(run, repo())).rejects.toThrow(/no changes to review/);
    await expect(collectChanges(run, repo(), "--output=/tmp/x")).rejects.toBeInstanceOf(AdvisorError);
    await expect(collectChanges(run, repo(), "nope-branch")).rejects.toThrow(/unknown base/);
  });

  it("truncates a huge diff and says so", async () => {
    const dir = repo();
    writeFileSync(join(dir, "a.ts"), "x".repeat(80) + "\n".repeat(1) + "y\n".repeat(MAX_DIFF_BYTES / 2));
    const changes = await collectChanges(run, dir);
    expect(changes.truncated).toBe(true);
    expect(Buffer.byteLength(changes.diff)).toBeLessThanOrEqual(MAX_DIFF_BYTES);
    expect(changes.diff.endsWith("y")).toBe(true);
  });
});

describe("reviewQuestion", () => {
  const changes = { root: "/repo", stat: " a.ts | 2 +-", diff: "diff --git a/a.ts b/a.ts\n+x", untracked: ["new.ts"], truncated: false };

  it("asks for concrete, prioritized findings and embeds the diff", () => {
    const q = reviewQuestion(changes);
    expect(q).toMatch(/severity/i);
    expect(q).toMatch(/file:line/);
    expect(q).toContain("```diff\ndiff --git a/a.ts b/a.ts\n+x\n```");
    expect(q).toContain("new.ts");
    expect(q).toMatch(/uncommitted changes/);
  });

  it("names the base, the focus and a truncation note when present", () => {
    const q = reviewQuestion({ ...changes, base: "main", truncated: true }, "concurrency in the sync code");
    expect(q).toContain("since it branched from main");
    expect(q).toContain("Focus especially on: concurrency in the sync code");
    expect(q).toMatch(/cut at about/);
  });

  it("opens the diff with a fence no line in the diff can close", () => {
    const q = reviewQuestion({ ...changes, diff: "diff --git a/r.md b/r.md\n ```\n-old\n+new\n ````" });
    expect(q).toContain("`````diff\n");
    expect(q.endsWith("\n`````")).toBe(true);
  });

  it("always fits one command line, however large the diff, stat and file list", () => {
    const huge = { ...changes, diff: "+é line\n".repeat(200_000), stat: "x".repeat(3_900), untracked: Array.from({ length: 500 }, (_, i) => `dir/file-${i}.ts`), truncated: true };
    const q = reviewQuestion(huge, "focus ".repeat(100));
    expect(Buffer.byteLength(q)).toBeLessThan(maxCommandLine() - 4_000);
    expect(q).toMatch(/and 450 more/);
  });
});
