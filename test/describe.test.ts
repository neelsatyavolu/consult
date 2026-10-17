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

  it("takes the latest typed prompt of a claude transcript, skipping tool results and injected context", () => {
    const path = join(dir(), "s1.jsonl");
    writeFileSync(
      path,
      jsonl(
        { type: "user", message: { role: "user", content: "first ask" } },
        { type: "user", message: { role: "user", content: [{ type: "text", text: "add a  tree\n scope" }] } },
        { type: "user", message: { role: "user", content: [{ type: "tool_result", content: "file text" }] } },
        { type: "user", message: { role: "user", content: "<system-reminder>x</system-reminder>" } },
        { type: "user", message: { role: "user", content: "[Request interrupted by user]" } },
        { type: "user", isMeta: true, message: { role: "user", content: "meta" } },
      ),
    );
    expect(describeSession(entry({ transcriptPath: path }), "/no/index").lastPrompt).toBe("add a tree scope");
  });

  it("takes the latest user message of a codex rollout, skipping AGENTS.md and environment context", () => {
    const path = join(dir(), "rollout.jsonl");
    const user = (text: string) => ({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } });
    writeFileSync(path, jsonl(user("# AGENTS.md instructions for /r"), user("fix the hook"), user("<environment_context>x</environment_context>")));
    expect(describeSession(entry({ agent: "codex", sessionId: "t1", transcriptPath: path }), "/no/index").lastPrompt).toBe("fix the hook");
  });

  it("reads a grok prompt from its user_query tag and its title from summary.json", () => {
    const session = dir();
    const events = join(session, "events.jsonl");
    writeFileSync(events, "");
    writeFileSync(join(session, "summary.json"), JSON.stringify({ session_summary: "Port the CLI" }));
    writeFileSync(
      join(session, "chat_history.jsonl"),
      jsonl(
        { type: "user", content: [{ type: "text", text: "<user_info>x</user_info>\n<user_query>\nport it\n</user_query>" }] },
        { type: "user", content: [{ type: "text", text: "<system-reminder>y</system-reminder>" }] },
      ),
    );
    expect(describeSession(entry({ agent: "grok", transcriptPath: events }), "/no/index")).toMatchObject({ title: "Port the CLI", lastPrompt: "port it" });
  });

  it("caps long prompts", () => {
    const path = join(dir(), "s1.jsonl");
    writeFileSync(path, jsonl({ type: "user", message: { role: "user", content: "y".repeat(500) } }));
    expect(describeSession(entry({ transcriptPath: path }), "/no/index").lastPrompt).toHaveLength(200);
  });

  it("puts the codex index next to the codex config", () => {
    expect(codexIndexPath({ CODEX_HOME: "/ch" })).toBe(join("/ch", "session_index.jsonl"));
  });
});
