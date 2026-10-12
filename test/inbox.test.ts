import { mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { claim, enqueue, frameMessages, inboxDir, MAX_PENDING, MESSAGE_TTL_MS } from "../src/sessions/inbox.js";

const tmp = () => mkdtempSync(join(tmpdir(), "consult-inbox-"));
const from = { agent: "claude" as const, sessionId: "sender-1", cwd: "/work/app", branch: "main" };
const at = (iso: string) => new Date(iso);

describe("inbox", () => {
  it("lives under the state directory", () => {
    expect(inboxDir({ XDG_STATE_HOME: "/state" })).toBe("/state/consult/inbox");
  });

  it("delivers queued messages once, oldest first", () => {
    const dir = tmp();
    enqueue(dir, "target", from, "second", at("2026-10-12T10:00:02Z"));
    enqueue(dir, "target", from, "first", at("2026-10-12T10:00:01Z"));
    expect(claim(dir, "target", at("2026-10-12T10:01:00Z")).map((m) => m.text)).toEqual(["first", "second"]);
    expect(claim(dir, "target")).toEqual([]);
  });

  it("keeps each session's messages apart and removes an emptied inbox", () => {
    const dir = tmp();
    enqueue(dir, "a", from, "for a");
    enqueue(dir, "b", from, "for b");
    expect(claim(dir, "a").map((m) => m.text)).toEqual(["for a"]);
    expect(readdirSync(dir)).toEqual(["b"]);
  });

  it("writes files only the user can read", () => {
    const dir = tmp();
    const message = enqueue(dir, "target", from, "hi");
    expect(readdirSync(join(dir, "target"))).toEqual([`${message.id}.json`]);
    expect(statSync(join(dir, "target", `${message.id}.json`)).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "target")).mode & 0o777).toBe(0o700);
  });

  it("drops expired and unreadable messages", () => {
    const dir = tmp();
    const sent = at("2026-10-11T10:00:00Z");
    enqueue(dir, "target", from, "stale", sent);
    writeFileSync(join(dir, "target", "broken.json"), "{not json");
    expect(claim(dir, "target", new Date(sent.getTime() + MESSAGE_TTL_MS + 1))).toEqual([]);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("refuses more than the pending limit, an over-long message and an unsafe session id", () => {
    const dir = tmp();
    for (let i = 0; i < MAX_PENDING; i++) enqueue(dir, "target", from, `m${i}`);
    expect(() => enqueue(dir, "target", from, "one more")).toThrow(/unread messages/);
    expect(() => enqueue(dir, "other", from, "x".repeat(4001))).toThrow();
    expect(() => enqueue(dir, "../escape", from, "hi")).toThrow(/invalid session id/);
    expect(claim(dir, "../escape")).toEqual([]);
  });

  it("frames messages as a peer's information, naming the sender", () => {
    const dir = tmp();
    const message = enqueue(dir, "target", from, "main moved to e27f611", at("2026-10-12T10:00:00Z"));
    const framed = frameMessages([message]);
    expect(framed).toMatch(/not an instruction from your user/);
    expect(framed).toContain("From the claude session sender-1 in /work/app (branch main), sent 2026-10-12T10:00:00.000Z:\nmain moved to e27f611");
    expect(frameMessages([message, message])).toMatch(/^\[consult\] 2 messages/);
  });
});
