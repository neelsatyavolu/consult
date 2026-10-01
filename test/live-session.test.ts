import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IdentityDeps } from "../src/sessions/identity.js";
import { startLiveSession, type LiveOptions } from "../src/sessions/live.js";
import type { Runner } from "../src/types.js";

const git: Runner = async (_cmd, args) => ({ stdout: args.includes("--git-common-dir") ? ".git\n" : "main\n", stderr: "", code: 0 });
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const rollout = (id: string) => `/home/u/.codex/sessions/2026/10/01/rollout-2026-10-01T10-00-00-${id}.jsonl`;
const codexHost = (files: () => readonly string[]): IdentityDeps => ({
  env: {},
  ancestors: async () => [{ pid: 77, name: "codex" }],
  openFiles: async () => files(),
  claudeSessionOf: () => undefined,
  claudeTranscript: () => undefined,
});

function options(pid: number, identity: IdentityDeps, signal: AbortSignal): LiveOptions & { readonly root: string } {
  const root = mkdtempSync(join(tmpdir(), "consult-live-"));
  return { root, run: git, dir: join(root, "sessions"), cwd: root, pid, identity, refreshMs: 1000, signal, warn: vi.fn() };
}
const read = (dir: string, pid: number) => JSON.parse(readFileSync(join(dir, `${pid}.json`), "utf8"));

afterEach(() => {
  vi.useRealTimers();
});

describe("startLiveSession", () => {
  it("registers the host session with its repo, branch and transcript", async () => {
    const stop = new AbortController();
    const opts = options(4242, codexHost(() => [rollout(A)]), stop.signal);
    const live = await startLiveSession({ ...opts, now: () => new Date("2026-10-01T10:00:00.000Z") });
    expect(read(opts.dir, 4242)).toEqual({
      version: 1,
      pid: 4242,
      agent: "codex",
      sessionId: A,
      cwd: opts.root,
      repoKey: join(opts.root, ".git"),
      branch: "main",
      startedAt: "2026-10-01T10:00:00.000Z",
      transcriptPath: rollout(A),
    });
    expect(live.self()).toEqual({ repoKey: join(opts.root, ".git"), sessionId: A });
    stop.abort();
  });

  it("registers once codex opens its rollout, and follows /new to the new thread", async () => {
    vi.useFakeTimers();
    let files: readonly string[] = [];
    const stop = new AbortController();
    const opts = options(4243, codexHost(() => files), stop.signal);
    const live = await startLiveSession(opts);
    expect(existsSync(join(opts.dir, "4243.json"))).toBe(false);
    expect(live.self().sessionId).toBeUndefined();

    files = [rollout(A)];
    await vi.advanceTimersByTimeAsync(1000);
    expect(read(opts.dir, 4243).sessionId).toBe(A);

    files = [rollout(B)];
    await vi.advanceTimersByTimeAsync(1000);
    expect(read(opts.dir, 4243).sessionId).toBe(B);
    expect(live.self().sessionId).toBe(B);
    stop.abort();
  });

  it("does not register when no agent CLI started the server", async () => {
    const stop = new AbortController();
    const identity: IdentityDeps = {
      env: {},
      ancestors: async () => [{ pid: 9, name: "zsh" }],
      openFiles: async () => [],
      claudeSessionOf: () => undefined,
      claudeTranscript: () => undefined,
    };
    const opts = options(4244, identity, stop.signal);
    const live = await startLiveSession(opts);
    expect(existsSync(join(opts.dir, "4244.json"))).toBe(false);
    expect(live.self()).toEqual({ repoKey: join(opts.root, ".git") });
    stop.abort();
  });

  it("removes its entry and stops refreshing on shutdown", async () => {
    vi.useFakeTimers();
    const openFiles = vi.fn(async () => [rollout(A)]);
    const stop = new AbortController();
    const opts = options(4245, { ...codexHost(() => []), openFiles }, stop.signal);
    await startLiveSession(opts);
    expect(existsSync(join(opts.dir, "4245.json"))).toBe(true);
    stop.abort();
    expect(existsSync(join(opts.dir, "4245.json"))).toBe(false);
    const calls = openFiles.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(openFiles.mock.calls.length).toBe(calls);
  });

  it("warns instead of crashing when the registry cannot be written", async () => {
    const stop = new AbortController();
    const opts = options(4246, codexHost(() => [rollout(A)]), stop.signal);
    await startLiveSession({ ...opts, dir: "/dev/null/sessions" });
    expect(opts.warn).toHaveBeenCalledWith(expect.stringMatching(/could not register this session/));
    stop.abort();
  });
});
