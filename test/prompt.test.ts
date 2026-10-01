import { describe, expect, it } from "vitest";
import { frameForkPrompt } from "../src/prompt.js";

describe("frameForkPrompt", () => {
  it("tells the fork it is a read-only copy answering another agent, not resuming its task", () => {
    const prompt = frameForkPrompt("-what changed in the API?");
    expect(prompt).toMatch(/^[A-Za-z]/);
    expect(prompt).toMatch(/read-only copy/i);
    expect(prompt).toMatch(/do not continue/i);
    expect(prompt.endsWith("-what changed in the API?")).toBe(true);
  });
});
