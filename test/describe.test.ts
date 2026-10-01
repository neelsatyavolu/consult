import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { codexIndexPath, describeSession, readTail } from "../src/sessions/describe.js";
import type { SessionEntry } from "../src/sessions/registry.js";

const dir = () => mkdtempSync(join(tmpdir(), "consult-describe-"));
const entry = (overrides: Partial<SessionEntry>): SessionEntry => ({
  version: 1,
  pid: 1,
  agent: "claude",
  sessionId: "s1",
  cwd: "/r",
  repoKey: "/r",
  startedAt: "2026-10-01T10:00:00.000Z",
  ...overrides,
});
const jsonl = (...rows: object[]) => `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;

describe("readTail", () => {
  it("drops the partial first line when it starts mid-file", () => {
    const path = join(dir(), "t.jsonl");
    writeFileSync(path, "first line\nsecond line\nthird\n");
    expect(readTail(path, 14)).toBe("third\n");
    expect(readTail(path, 1000)).toBe("first line\nsecond line\nthird\n");
  });

  it("returns undefined for a missing file", () => {
    expect(readTail(join(dir(), "nope"))).toBeUndefined();
  });
});

describe("describeSession", () => {
  it("uses the latest ai-title of a claude transcript, and its mtime as last activity", () => {
    const path = join(dir(), "s1.jsonl");
    writeFileSync(
      path,
      jsonl(
        { type: "user", message: "hi" },
        { type: "ai-title", aiTitle: "Old title" },
        { type: "assistant" },
        { type: "ai-title", aiTitle: "Fix flaky retry test" },
      ),
    );
    const when = new Date("2026-10-01T12:34:56.000Z");
    utimesSync(path, when, when);
    expect(describeSession(entry({ transcriptPath: path }), "/no/index")).toEqual({
      title: "Fix flaky retry test",
      lastActive: "2026-10-01T12:34:56.000Z",
    });
  });

  it("reads a codex thread name from the session index, the latest line winning", () => {
    const index = join(dir(), "session_index.jsonl");
    writeFileSync(
      index,
      jsonl({ id: "t1", thread_name: "first" }, { id: "other", thread_name: "x" }, { id: "t1", thread_name: "Renamed thread" }),
    );
    expect(describeSession(entry({ agent: "codex", sessionId: "t1" }), index)).toEqual({ title: "Renamed thread" });
  });

  it("returns only what it finds, and caps long titles", () => {
    expect(describeSession(entry({ agent: "grok" }), "/no/index")).toEqual({});
    const path = join(dir(), "s1.jsonl");
    writeFileSync(path, jsonl({ type: "ai-title", aiTitle: "x".repeat(500) }));
    expect(describeSession(entry({ transcriptPath: path }), "/no/index").title).toHaveLength(120);
  });

  it("puts the codex index next to the codex config", () => {
    expect(codexIndexPath({ CODEX_HOME: "/ch" })).toBe(join("/ch", "session_index.jsonl"));
  });
});
