import { existsSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listLive, registryDir, removeEntry, writeEntry, type SessionEntry } from "../src/sessions/registry.js";

const tmpDir = () => join(mkdtempSync(join(tmpdir(), "consult-registry-")), "sessions");
const entry = (overrides: Partial<SessionEntry> = {}): SessionEntry => ({
  version: 1,
  pid: 101,
  agent: "codex",
  sessionId: "s-101",
  cwd: "/repo",
  repoKey: "/repo/.git",
  startedAt: "2026-10-01T10:00:00.000Z",
  ...overrides,
});
const alive = (pids: number[]) => (pid: number) => pids.includes(pid);

describe("registryDir", () => {
  it("uses XDG_STATE_HOME when set, else ~/.local/state", () => {
    expect(registryDir({ XDG_STATE_HOME: "/state" })).toBe(join("/state", "consult", "sessions"));
    expect(registryDir({})).toBe(join(homedir(), ".local", "state", "consult", "sessions"));
  });
});

describe("registry", () => {
  it("lists what was written, newest first, in a directory only the user can read", () => {
    const dir = tmpDir();
    writeEntry(dir, entry());
    writeEntry(dir, entry({ pid: 102, sessionId: "s-102", startedAt: "2026-10-01T11:00:00.000Z" }));
    expect(listLive(dir, alive([101, 102])).map((e) => e.sessionId)).toEqual(["s-102", "s-101"]);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, "101.json")).mode & 0o777).toBe(0o600);
  });

  it("deletes entries whose server has died", () => {
    const dir = tmpDir();
    writeEntry(dir, entry());
    expect(listLive(dir, alive([]))).toEqual([]);
    expect(existsSync(join(dir, "101.json"))).toBe(false);
  });

  it("skips half-written entries of live servers without deleting them, and ignores other files", () => {
    const dir = tmpDir();
    writeEntry(dir, entry());
    writeFileSync(join(dir, "101.json"), "{ half-writ");
    writeFileSync(join(dir, "notes.txt"), "not an entry");
    expect(listLive(dir, alive([101]))).toEqual([]);
    expect(existsSync(join(dir, "101.json"))).toBe(true);
  });

  it("skips an entry whose session id could be parsed as a flag", () => {
    const dir = tmpDir();
    writeEntry(dir, entry());
    writeFileSync(join(dir, "102.json"), JSON.stringify(entry({ pid: 102, sessionId: "-x" })));
    expect(listLive(dir, alive([101, 102])).map((e) => e.sessionId)).toEqual(["s-101"]);
  });

  it("ignores an entry whose pid does not match its file name", () => {
    const dir = tmpDir();
    writeEntry(dir, entry());
    writeFileSync(join(dir, "104.json"), JSON.stringify(entry({ pid: 103 })));
    expect(listLive(dir, alive([101, 104])).map((e) => e.pid)).toEqual([101]);
  });

  it("keeps only the newest entry for a session registered twice", () => {
    const dir = tmpDir();
    writeEntry(dir, entry({ pid: 101, startedAt: "2026-10-01T10:00:00.000Z" }));
    writeEntry(dir, entry({ pid: 102, startedAt: "2026-10-01T12:00:00.000Z" }));
    expect(listLive(dir, alive([101, 102])).map((e) => e.pid)).toEqual([102]);
  });

  it("returns nothing when the directory does not exist yet", () => {
    expect(listLive(tmpDir(), alive([101]))).toEqual([]);
  });

  it("removes an entry, tolerates removing it twice, and leaves no temp files", () => {
    const dir = tmpDir();
    writeEntry(dir, entry());
    removeEntry(dir, 101);
    removeEntry(dir, 101);
    expect(readdirSync(dir)).toEqual([]);
  });
});
