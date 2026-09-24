#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { claude } from "./adapters/claude.js";
import { codex } from "./adapters/codex.js";
import { grok } from "./adapters/grok.js";
import { listAgents } from "./agents.js";
import { createConsult } from "./consult.js";
import { findOnPath, install, serverCommand, uninstall, type InstallResult } from "./install.js";
import { run } from "./run.js";
import { createServer } from "./server.js";
import { AGENTS, EFFORTS, type AgentName, type Effort } from "./types.js";
import { VERSION } from "./version.js";

const DEFAULT_TIMEOUT_SEC = 900;

const USAGE = `consult ${VERSION} - let coding agents ask each other for advice

  consult serve                          run the MCP server (stdio)
  consult ask <agent> [options] <question...>
      --model <id>  --effort low|medium|high  --resume <session_id>  --cwd <dir>
  consult agents                         list installed CLIs and models
  consult install                        register the MCP server with claude, codex and grok
  consult uninstall                      remove it from all three

agents: ${AGENTS.join(", ")}    timeout: CONSULT_TIMEOUT_SEC (default ${DEFAULT_TIMEOUT_SEC})`;

function timeoutMs(): number {
  const raw = process.env.CONSULT_TIMEOUT_SEC;
  const sec = raw ? Number(raw) : DEFAULT_TIMEOUT_SEC;
  if (!Number.isFinite(sec) || sec <= 0) throw new Error(`CONSULT_TIMEOUT_SEC must be a positive number, got ${raw}`);
  return sec * 1000;
}

const consult = () => createConsult({ run, adapters: { claude, codex, grok }, timeoutMs: timeoutMs() });

// Advisors run in their own process groups, so they would outlive the server. Stop them when the host
// disconnects or signals us.
async function serve(): Promise<void> {
  const shutdown = new AbortController();
  const { ask } = consult();
  const server = createServer({
    ask: (request, signal) => ask(request, signal ? AbortSignal.any([signal, shutdown.signal]) : shutdown.signal),
    listAgents: () => listAgents(run),
    defaultCwd: process.cwd(),
  });
  const transport = new StdioServerTransport();
  transport.onclose = () => shutdown.abort();
  // The stdio transport doesn't notice the host closing the pipe, so watch stdin directly.
  process.stdin.once("end", () => shutdown.abort());
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.once(sig, () => {
      shutdown.abort();
      process.exit(128 + (sig === "SIGINT" ? 2 : sig === "SIGTERM" ? 15 : 1));
    });
  }
  await server.connect(transport);
}

async function askCommand(argv: readonly string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: { model: { type: "string" }, effort: { type: "string" }, resume: { type: "string" }, cwd: { type: "string" } },
  });
  const [agent, ...words] = positionals;
  if (!AGENTS.includes(agent as AgentName)) throw new Error(`agent must be one of ${AGENTS.join(", ")}`);
  if (values.effort && !EFFORTS.includes(values.effort as Effort)) throw new Error(`effort must be one of ${EFFORTS.join(", ")}`);
  const result = await consult().ask({
    agent: agent as AgentName,
    question: words.join(" "),
    cwd: values.cwd ?? process.cwd(),
    model: values.model,
    effort: values.effort as Effort | undefined,
    sessionId: values.resume,
  });
  process.stdout.write(`${result.answer}\n`);
  process.stderr.write(`\n[${result.agent}${result.model ? ` ${result.model}` : ""} · session ${result.sessionId} · ${(result.durationMs / 1000).toFixed(1)}s]\n`);
}

const installedAgents = () => AGENTS.filter((agent) => findOnPath(agent, process.env.PATH ?? ""));

/** Prints one line per CLI and returns whether every step succeeded. */
function report(results: readonly InstallResult[]): boolean {
  process.stdout.write(`${results.map((r) => r.message).join("\n")}\n`);
  const ok = results.every((r) => r.ok);
  if (!ok) process.exitCode = 1;
  return ok;
}

async function main(argv: readonly string[]): Promise<void> {
  const [command, ...rest] = argv;
  switch (command) {
    case "serve":
      return serve();
    case "ask":
      return askCommand(rest);
    case "agents":
      process.stdout.write(`${JSON.stringify(await listAgents(run), null, 2)}\n`);
      return;
    case "install": {
      const script = realpathSync(fileURLToPath(import.meta.url));
      const searchPath = process.env.PATH ?? "";
      if (report(await install(run, serverCommand(script, searchPath), installedAgents()))) {
        process.stdout.write("Restart running agent sessions to pick up the new tools.\n");
      }
      return;
    }
    case "uninstall":
      report(await uninstall(run, installedAgents()));
      return;
    case "--version":
    case "-v":
      process.stdout.write(`${VERSION}\n`);
      return;
    default:
      process.stdout.write(`${USAGE}\n`);
      if (command && command !== "help" && command !== "--help") process.exitCode = 1;
  }
}

main(process.argv.slice(2)).catch((err: unknown) => {
  process.stderr.write(`consult: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
