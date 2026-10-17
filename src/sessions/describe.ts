import { closeSync, fstatSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { codexConfigPath } from "../codex-config.js";
import type { SessionEntry } from "./registry.js";

export interface SessionDetails {
  readonly title?: string;
  readonly lastPrompt?: string;
  readonly lastActive?: string;
}

const TAIL_BYTES = 2 * 1024 * 1024;
const MAX_TITLE = 120;
const MAX_PROMPT = 200;

export function codexIndexPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(dirname(codexConfigPath(env)), "session_index.jsonl");
}

/** The last `bytes` of a file, without the partial line it may start in. */
export function readTail(path: string, bytes = TAIL_BYTES): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buffer = Buffer.alloc(size - start);
    readSync(fd, buffer, 0, buffer.length, start);
    const text = buffer.toString("utf8");
    return start === 0 ? text : text.slice(text.indexOf("\n") + 1);
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** The string `pick` returns for the last JSON line that contains `needle` (checked before parsing, to stay cheap). */
function lastMatch(text: string | undefined, needle: string, pick: (row: Record<string, unknown>) => unknown): string | undefined {
  const lines = text?.split("\n") ?? [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (!line.includes(needle)) continue;
    try {
      const value = pick(JSON.parse(line) as Record<string, unknown>);
      if (typeof value === "string" && value) return value;
    } catch {
      // Not JSON, or cut by the tail.
    }
  }
  return undefined;
}

/** The text of the user's own words: hosts also put injected context (`<system-reminder>`, AGENTS.md) in user turns. */
function typed(text: unknown): string | undefined {
  if (typeof text !== "string") return undefined;
  const trimmed = text.trim();
  const injected = ["<", "# AGENTS.md", "[Request interrupted"].some((prefix) => trimmed.startsWith(prefix));
  return trimmed && !injected ? trimmed : undefined;
}

const texts = (content: unknown): unknown[] =>
  typeof content === "string" ? [content] : Array.isArray(content) ? content.map((b) => (b as { text?: unknown })?.text) : [];

function lastTyped(content: unknown): string | undefined {
  return texts(content).map(typed).filter(Boolean).at(-1);
}

const USER_QUERY = /<user_query>([\s\S]*?)<\/user_query>/;

function lastPrompt(entry: SessionEntry): string | undefined {
  if (!entry.transcriptPath) return undefined;
  switch (entry.agent) {
    case "claude":
      // Tool results are user rows too, but their content blocks carry no text field.
      return lastMatch(readTail(entry.transcriptPath), '"type":"user"', (row) =>
        row.type === "user" && !row.isMeta ? lastTyped((row.message as { content?: unknown })?.content) : undefined,
      );
    case "codex":
      return lastMatch(readTail(entry.transcriptPath), '"role":"user"', (row) => {
        const payload = row.payload as { type?: unknown; role?: unknown; content?: unknown } | undefined;
        return row.type === "response_item" && payload?.type === "message" && payload.role === "user" ? lastTyped(payload.content) : undefined;
      });
    case "grok":
      // grok wraps each prompt in <user_query> inside a turn of injected context.
      return lastMatch(readTail(join(dirname(entry.transcriptPath), "chat_history.jsonl")), "<user_query>", (row) => {
        if (row.type !== "user") return undefined;
        return texts(row.content).map((text) => (typeof text === "string" ? USER_QUERY.exec(text)?.[1]?.trim() : undefined)).filter(Boolean).at(-1);
      });
  }
}

/** grok keeps a one-line summary of the session next to its events. */
function grokSummary(transcriptPath: string): string | undefined {
  try {
    const summary = (JSON.parse(readFileSync(join(dirname(transcriptPath), "summary.json"), "utf8")) as { session_summary?: unknown }).session_summary;
    return typeof summary === "string" && summary ? summary : undefined;
  } catch {
    return undefined;
  }
}

const oneLine = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

function mtime(path: string): string | undefined {
  try {
    return statSync(path).mtime.toISOString();
  } catch {
    return undefined;
  }
}

function title(entry: SessionEntry, codexIndex: string): string | undefined {
  switch (entry.agent) {
    case "claude":
      return entry.transcriptPath
        ? lastMatch(readTail(entry.transcriptPath), '"ai-title"', (row) => (row.type === "ai-title" ? row.aiTitle : undefined))
        : undefined;
    case "codex":
      return lastMatch(readTail(codexIndex), entry.sessionId, (row) => (row.id === entry.sessionId ? row.thread_name : undefined));
    case "grok":
      return entry.transcriptPath ? grokSummary(entry.transcriptPath) : undefined;
  }
}

/**
 * The session's title, its user's latest prompt and its last activity, from the host's own files. Nothing else
 * from the conversation is read.
 */
export function describeSession(entry: SessionEntry, codexIndex: string): SessionDetails {
  const name = title(entry, codexIndex)?.slice(0, MAX_TITLE);
  const prompt = lastPrompt(entry);
  const lastActive = entry.transcriptPath ? mtime(entry.transcriptPath) : undefined;
  return {
    ...(name ? { title: name } : {}),
    ...(prompt ? { lastPrompt: oneLine(prompt, MAX_PROMPT) } : {}),
    ...(lastActive ? { lastActive } : {}),
  };
}
