import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { HOSTS, SESSION_ID_PATTERN } from "../types.js";

const entrySchema = z.object({
  version: z.literal(1),
  /** The consult server's pid; it names the file and tells readers whether the entry is stale. */
  pid: z.number().int().positive(),
  agent: z.enum(HOSTS),
  sessionId: z.string().regex(SESSION_ID_PATTERN),
  cwd: z.string().min(1),
  repoKey: z.string().min(1),
  branch: z.string().optional(),
  startedAt: z.string(),
  transcriptPath: z.string().optional(),
});

export type SessionEntry = Readonly<z.infer<typeof entrySchema>>;

const ENTRY_FILE = /^(\d+)\.json$/;

/** `$XDG_STATE_HOME/consult/sessions`, else `~/.local/state/consult/sessions`. */
export function registryDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "consult", "sessions");
}

const fileFor = (dir: string, pid: number) => join(dir, `${pid}.json`);

export function writeEntry(dir: string, entry: SessionEntry): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `.${entry.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(entrySchema.parse(entry)), { mode: 0o600 });
  renameSync(tmp, fileFor(dir, entry.pid));
}

export function removeEntry(dir: string, pid: number): void {
  rmSync(fileFor(dir, pid), { force: true });
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readEntry(path: string): SessionEntry | undefined {
  try {
    const parsed = entrySchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Entries of running consult servers, newest first and one per session. Files left by servers that died are
 * deleted; unreadable files of live servers are skipped, since they may be mid-write.
 */
export function listLive(dir: string, isAlive: (pid: number) => boolean = pidAlive): readonly SessionEntry[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const bySession = new Map<string, SessionEntry>();
  for (const name of names) {
    const pid = Number(ENTRY_FILE.exec(name)?.[1]);
    if (!pid) continue;
    if (!isAlive(pid)) {
      removeEntry(dir, pid);
      continue;
    }
    const entry = readEntry(join(dir, name));
    if (!entry || entry.pid !== pid) continue;
    const seen = bySession.get(entry.sessionId);
    if (!seen || seen.startedAt < entry.startedAt) bySession.set(entry.sessionId, entry);
  }
  return [...bySession.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}
