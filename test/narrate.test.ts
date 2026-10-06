import { afterEach, describe, expect, it, vi } from "vitest";
import { describeLine, oneLine, progressLog, unwrapShell } from "../src/narrate.js";

describe("narration helpers", () => {
  it("flattens and shortens text to one line", () => {
    expect(oneLine("  a\n  b\tc ")).toBe("a b c");
    expect(oneLine("x".repeat(10), 5)).toBe("xxxx…");
  });

  it("unwraps login-shell commands only", () => {
    expect(unwrapShell("/bin/zsh -lc 'npm test'")).toBe("npm test");
    expect(unwrapShell("npm test")).toBe("npm test");
  });

  it("describes JSONL lines, skipping non-JSON, unreported and failing events", () => {
    const describe = (e: Record<string, unknown>) => {
      if (e.boom) throw new Error("bad");
      return typeof e.say === "string" ? e.say : undefined;
    };
    expect(describeLine(describe, '{"say":"  ran\\n tests "}')).toBe("ran tests");
    expect(describeLine(describe, '{"other":1}')).toBeUndefined();
    expect(describeLine(describe, "plain log text")).toBeUndefined();
    expect(describeLine(describe, '{"boom":true}')).toBeUndefined();
  });
});

describe("progressLog", () => {
  afterEach(() => vi.useRealTimers());

  it("timestamps updates and sends a heartbeat only after a quiet stretch", () => {
    vi.useFakeTimers();
    const lines: string[] = [];
    const log = progressLog((l) => lines.push(l), "grok is still working", 30_000);
    log.update("asking grok (read-only)");
    vi.advanceTimersByTime(20_000);
    log.update("$ rg retry");
    vi.advanceTimersByTime(20_000);
    expect(lines).toEqual(["[0s] asking grok (read-only)\n", "[20s] $ rg retry\n"]);
    vi.advanceTimersByTime(20_000);
    expect(lines.at(-1)).toBe("[50s] grok is still working\n");
    log.stop();
    vi.advanceTimersByTime(120_000);
    expect(lines).toHaveLength(3);
  });
});
