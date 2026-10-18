import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { viewPullRequest } from "../src/pr.js";
import { AdvisorError, type Runner, type RunResult } from "../src/types.js";

const FIXTURE = readFileSync(join(import.meta.dirname, "fixtures", "gh-pr-view.json"), "utf8");
const REPO = import.meta.dirname;
const result = (over: Partial<RunResult>): RunResult => ({ stdout: "", stderr: "", code: 0, ...over });

describe("viewPullRequest", () => {
  it("reads the base and head commits from gh pr view", async () => {
    const run = vi.fn<Runner>(async () => result({ stdout: FIXTURE }));
    const pr = await viewPullRequest(run, REPO, 2);
    expect(pr).toEqual({
      number: 2,
      baseName: "main",
      baseOid: "3fa60729232e7d4b0ba99d132862ae3527252d0b",
      headOid: "e96ec52e8391585f0538ccc6b016e952654d1c4b",
    });
    expect(run).toHaveBeenCalledWith("gh", ["pr", "view", "2", "--json", "number,baseRefName,baseRefOid,headRefOid"], expect.objectContaining({ cwd: REPO }));
  });

  it("passes gh's error through", async () => {
    const run: Runner = async () => result({ code: 1, stderr: "GraphQL: Could not resolve to a PullRequest with the number of 99999. (repository.pullRequest)\n" });
    const err = await viewPullRequest(run, REPO, 99999).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AdvisorError);
    expect((err as Error).message).toMatch(/gh pr view 99999 failed: GraphQL: Could not resolve/);
  });

  it("says how to get gh when it is not installed", async () => {
    const run: Runner = async () => {
      throw new Error("gh CLI not found on PATH");
    };
    await expect(viewPullRequest(run, REPO, 2)).rejects.toThrow(/cli\.github\.com/);
  });

  it("refuses output that isn't a pull request", async () => {
    const bad = [
      "not json",
      JSON.stringify({ ...JSON.parse(FIXTURE), baseRefOid: "--output=/tmp/x" }),
      JSON.stringify({ ...JSON.parse(FIXTURE), baseRefName: undefined }),
    ];
    for (const stdout of bad) {
      await expect(viewPullRequest(async () => result({ stdout }), REPO, 2)).rejects.toBeInstanceOf(AdvisorError);
    }
  });

  it("refuses a number that isn't a positive integer, or a missing directory, without running gh", async () => {
    const run = vi.fn<Runner>();
    for (const n of [0, -1, 1.5, Number.NaN]) await expect(viewPullRequest(run, REPO, n)).rejects.toBeInstanceOf(AdvisorError);
    await expect(viewPullRequest(run, "/no/such/dir", 2)).rejects.toThrow(/not a directory/);
    expect(run).not.toHaveBeenCalled();
  });
});
