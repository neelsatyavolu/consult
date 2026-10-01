import { closeSync, fstatSync, openSync, readSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { codexConfigPath } from "../codex-config.js";
import type { SessionEntry } from "./registry.js";

export interface SessionDetails {
  readonly title?: string;
  readonly lastActive?: string;
}

const TAIL_BYTES = 2 * 1024 * 1024;
const MAX_TITLE = 120;

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
      return undefined;
  }
}

/** The session's title and last activity, from the host's own files. Nothing else from the conversation is read. */
export function describeSession(entry: SessionEntry, codexIndex: string): SessionDetails {
  const name = title(entry, codexIndex)?.slice(0, MAX_TITLE);
  const lastActive = entry.transcriptPath ? mtime(entry.transcriptPath) : undefined;
  return { ...(name ? { title: name } : {}), ...(lastActive ? { lastActive } : {}) };
}
