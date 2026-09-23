// Opt-in: talks to the real CLIs over the built MCP server. Run with `npm run build && npm run test:live`.
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";
import { AGENTS } from "../src/types.js";

const live = process.env.CONSULT_LIVE === "1";
const root = fileURLToPath(new URL("..", import.meta.url));
const FAST_MODEL: Record<string, string | undefined> = { claude: "haiku" };

describe.skipIf(!live)("live MCP server", () => {
  it.each(AGENTS)("%s answers from the repo and keeps the session for a follow-up", { timeout: 600_000 }, async (agent) => {
    const client = new Client({ name: "live-test", version: "0" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: ["dist/cli.js", "serve"], cwd: root }));
    try {
      const first = await client.callTool(
        { name: "ask_agent", arguments: { agent, model: FAST_MODEL[agent], question: "Read package.json. Reply with only the value of its name field." } },
        undefined,
        { timeout: 600_000 },
      );
      expect(first.isError).toBeFalsy();
      const { answer, session_id } = first.structuredContent as { answer: string; session_id: string };
      expect(answer.toLowerCase()).toContain("consult");

      const followUp = await client.callTool(
        { name: "ask_agent", arguments: { agent, model: FAST_MODEL[agent], session_id, question: "Repeat that name in uppercase, nothing else." } },
        undefined,
        { timeout: 600_000 },
      );
      expect(followUp.isError).toBeFalsy();
      expect((followUp.structuredContent as { answer: string }).answer).toContain("CONSULT");
    } finally {
      await client.close();
    }
  });
});
