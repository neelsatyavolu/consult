# Live Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an agent in a running Claude Code, Codex or Grok session list other live agent sessions on the machine and ask one of them a question through a read-only fork. The feature is off by default and is configured at install time or with `consult settings`.

**Architecture:** Each `consult serve` process (one per host session) registers its host session in a per-user file registry when live sessions are on. `list_sessions` reads the registry, filtered by scope. `ask_session` forks the target session headlessly with the existing advisor containment flags, in the target's directory. Settings live in an XDG config file that a `@clack/prompts` TUI edits.

**Tech Stack:** TypeScript (NodeNext ESM, Node >= 22), `@modelcontextprotocol/sdk`, zod v4, vitest, `@clack/prompts` ^1.8.1 (new).

**Spec:** `docs/superpowers/specs/2026-10-01-live-sessions-design.md`

## Global Constraints

- Node >= 22, ESM only; import local modules with a `.js` suffix (`NodeNext`).
- Keep data `readonly`; return new objects instead of mutating inputs.
- Throw `AdvisorError` for failures that should reach the MCP caller.
- Unit tests inject `Runner`, identity deps and temp paths; only `test/live.test.ts` spawns agent CLIs (unit tests may run `git`).
- Live sessions are **off by default**.
- Settings: `$XDG_CONFIG_HOME/consult/settings.json` (default `~/.config/consult/settings.json`).
- Registry: `$XDG_STATE_HOME/consult/sessions/<pid>.json` (default `~/.local/state/consult/sessions/`).
- Directories are created `0700` and files written `0600`, atomically (temp file + rename).
- A fork always uses the adapter's existing containment flags and never resumes the source session in place.
- The only new runtime dependency is `@clack/prompts` ^1.8.1.
- The repo is public: no secrets, emails, machine names or real `/Users/...` paths in committed files (tests use fake paths such as `/home/u`).
- Any change to adapter flags updates the README table "How advisors are contained" and `SECURITY.md`.
- Commit messages: `<type>: <description>` (feat, fix, test, docs, chore); no attribution lines.
- Stage files explicitly by path. Never `git add -A` (the working tree has untracked files that are not part of this work).

## Review Focus

1. **Corrupt or half-written settings file** (a manual edit, or a crash mid-write): `consult serve` must still start, print a warning on stderr and run with live sessions off. `ask_agent` and the other tools must keep working. Test in Task 11.
2. **`consult install` without a TTY** (CI, piped output, scripted `npx`): it must never prompt or hang, and must leave the setting unchanged unless `--sessions` is passed. Test in Task 13.
3. **An agent CLI started from inside another agent's terminal** (for example `grok` launched from a Claude Code shell inherits `CLAUDE_CODE_SESSION_ID`): the host is the nearest agent ancestor process, not the inherited variable. Test in Task 4.
4. **Live sessions turned off, or the scope narrowed, while sessions are running:** `list_sessions` and `ask_session` must refuse or filter on the next call, not after a restart. Test in Task 8.
5. **Target session in another repo** (`machine` scope): the fork runs in the target's cwd, because Claude finds sessions per project directory, and the reply tells the asker to pass that cwd for follow-ups. Tests in Task 7 and Task 9.

---

## File Structure

| Action | Path | Responsibility |
|---|---|---|
| Create | `src/settings.ts` | Settings schema, path, load/save, mode helpers |
| Create | `src/sessions/scope.ts` | `repoKey`, `gitBranch`, `inScope` |
| Create | `src/sessions/registry.ts` | Registry entries on disk: write, remove, list live |
| Create | `src/sessions/identity.ts` | Which host started this server and its session id |
| Create | `src/sessions/describe.ts` | Title and last-active for an entry |
| Create | `src/sessions/live.ts` | Register this server's session and keep it current |
| Create | `src/sessions/service.ts` | `list` / `ask` with settings and scope checked per call |
| Create | `src/sessions/wire.ts` | Composition for `consult serve` |
| Create | `src/session-tools.ts` | MCP tools `list_sessions`, `ask_session` |
| Create | `src/tui.ts` | `consult settings` TUI and install-time question |
| Modify | `src/types.ts` | `Adapter.fork` |
| Modify | `src/adapters/claude.ts`, `codex.ts`, `grok.ts` | `fork()` |
| Modify | `src/prompt.ts` | `frameForkPrompt` |
| Modify | `src/consult.ts` | `askSession`, `ForkTarget` |
| Modify | `src/server.ts` | Optional `sessions` deps |
| Modify | `src/codex-config.ts`, `src/install.ts` | `isCodexRegistered`, `isRegistered` |
| Modify | `src/cli.ts` | `serve` wiring, `install --sessions`, `settings` command |
| Modify | `README.md`, `SECURITY.md`, `AGENTS.md`, `CLAUDE.md` | Docs |
| Create | `test/settings.test.ts`, `test/scope.test.ts`, `test/registry.test.ts`, `test/identity.test.ts`, `test/describe.test.ts`, `test/prompt.test.ts`, `test/sessions-service.test.ts`, `test/session-tools.test.ts`, `test/live-session.test.ts`, `test/sessions-wire.test.ts`, `test/tui.test.ts` | Unit tests |
| Modify | `test/adapters.test.ts`, `test/consult.test.ts`, `test/install.test.ts`, `test/live.test.ts` | Tests |

---

### Task 0: Branch

- [ ] **Step 1: Create the feature branch**

```bash
git checkout -b feat/live-sessions
```

Expected: `Switched to a new branch 'feat/live-sessions'`.

---

### Task 1: Settings

**Files:**
- Create: `src/settings.ts`
- Test: `test/settings.test.ts`

**Interfaces:**
- Produces:
  - `SESSIONS_MODES: readonly ["off", "repo", "machine"]`, `type SessionsMode`, `type Scope = "repo" | "machine"`
  - `interface Settings { version: 1; sessions: { enabled: boolean; scope: Scope } }` (readonly), `DEFAULT_SETTINGS`
  - `class SettingsError extends Error`
  - `settingsPath(env?: NodeJS.ProcessEnv): string`
  - `loadSettings(path: string): Settings` (missing file returns defaults; an invalid file throws `SettingsError`)
  - `saveSettings(path: string, settings: Settings): void`
  - `sessionsMode(settings: Settings): SessionsMode`
  - `withSessionsMode(settings: Settings, mode: SessionsMode): Settings`

- [ ] **Step 1: Write the failing test**

`test/settings.test.ts`:

```ts
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  SettingsError,
  loadSettings,
  saveSettings,
  sessionsMode,
  settingsPath,
  withSessionsMode,
} from "../src/settings.js";

const tmpPath = () => join(mkdtempSync(join(tmpdir(), "consult-settings-")), "consult", "settings.json");

describe("settingsPath", () => {
  it("uses XDG_CONFIG_HOME when set", () => {
    expect(settingsPath({ XDG_CONFIG_HOME: "/xdg" })).toBe(join("/xdg", "consult", "settings.json"));
  });

  it("falls back to ~/.config", () => {
    expect(settingsPath({})).toBe(join(homedir(), ".config", "consult", "settings.json"));
  });
});

describe("loadSettings / saveSettings", () => {
  it("returns the defaults, with live sessions off, when the file does not exist", () => {
    expect(loadSettings(tmpPath())).toEqual({ version: 1, sessions: { enabled: false, scope: "repo" } });
  });

  it("round-trips settings and writes a file only the user can read", () => {
    const path = tmpPath();
    const settings = withSessionsMode(DEFAULT_SETTINGS, "machine");
    saveSettings(path, settings);
    expect(loadSettings(path)).toEqual(settings);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("throws a SettingsError that points to consult settings when the file is not JSON", () => {
    const path = tmpPath();
    saveSettings(path, DEFAULT_SETTINGS);
    writeFileSync(path, "{ nope");
    expect(() => loadSettings(path)).toThrow(SettingsError);
    expect(() => loadSettings(path)).toThrow(/consult settings/);
  });

  it("throws a SettingsError when a value is not allowed", () => {
    const path = tmpPath();
    saveSettings(path, DEFAULT_SETTINGS);
    writeFileSync(path, JSON.stringify({ version: 1, sessions: { enabled: true, scope: "galaxy" } }));
    expect(() => loadSettings(path)).toThrow(SettingsError);
  });
});

describe("sessions mode", () => {
  it("reads off, repo and machine", () => {
    expect(sessionsMode(DEFAULT_SETTINGS)).toBe("off");
    expect(sessionsMode(withSessionsMode(DEFAULT_SETTINGS, "repo"))).toBe("repo");
    expect(sessionsMode(withSessionsMode(DEFAULT_SETTINGS, "machine"))).toBe("machine");
  });

  it("keeps the chosen scope when turned off, and never mutates its input", () => {
    const machine = withSessionsMode(DEFAULT_SETTINGS, "machine");
    const off = withSessionsMode(machine, "off");
    expect(off.sessions).toEqual({ enabled: false, scope: "machine" });
    expect(machine.sessions.enabled).toBe(true);
    expect(DEFAULT_SETTINGS.sessions.enabled).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/settings.test.ts`
Expected: FAIL, `Failed to load url ../src/settings.js`.

- [ ] **Step 3: Implement**

`src/settings.ts`:

```ts
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";

export const SESSIONS_MODES = ["off", "repo", "machine"] as const;
export type SessionsMode = (typeof SESSIONS_MODES)[number];
export type Scope = Exclude<SessionsMode, "off">;

const schema = z.object({
  version: z.literal(1),
  sessions: z.object({ enabled: z.boolean(), scope: z.enum(["repo", "machine"]) }),
});

export interface Settings {
  readonly version: 1;
  readonly sessions: { readonly enabled: boolean; readonly scope: Scope };
}

/** Live sessions stay off until the user turns them on. */
export const DEFAULT_SETTINGS: Settings = { version: 1, sessions: { enabled: false, scope: "repo" } };

export class SettingsError extends Error {
  override readonly name = "SettingsError";
}

/** `$XDG_CONFIG_HOME/consult/settings.json`, else `~/.config/consult/settings.json`. */
export function settingsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "consult", "settings.json");
}

/** Returns the defaults when the file does not exist; throws SettingsError when it exists but is not valid. */
export function loadSettings(path: string): Settings {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return DEFAULT_SETTINGS;
    throw new SettingsError(`could not read ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new SettingsError(`${path} is not valid JSON; run \`consult settings\` to reset it`);
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    const reason = parsed.error.issues[0]?.message ?? "unknown problem";
    throw new SettingsError(`${path} has invalid settings (${reason}); run \`consult settings\` to reset it`);
  }
  return parsed.data;
}

export function saveSettings(path: string, settings: Settings): void {
  const valid = schema.parse(settings);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(valid, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

export const sessionsMode = (settings: Settings): SessionsMode =>
  settings.sessions.enabled ? settings.sessions.scope : "off";

/** Turning sessions off keeps the scope, so turning them back on restores it. */
export function withSessionsMode(settings: Settings, mode: SessionsMode): Settings {
  return {
    ...settings,
    sessions: mode === "off" ? { ...settings.sessions, enabled: false } : { enabled: true, scope: mode },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/settings.test.ts && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/settings.ts test/settings.test.ts
git commit -m "feat: settings file for live sessions, off by default"
```

---

### Task 2: Scope

**Files:**
- Create: `src/sessions/scope.ts`
- Test: `test/scope.test.ts`

**Interfaces:**
- Consumes: `Scope` from `src/settings.ts`; `Runner` from `src/types.ts`; `run` from `src/run.ts` (test only).
- Produces:
  - `repoKey(run: Runner, cwd: string): Promise<string>`
  - `gitBranch(run: Runner, cwd: string): Promise<string | undefined>`
  - `inScope(self: { readonly repoKey: string }, other: { readonly repoKey: string }, scope: Scope): boolean`

- [ ] **Step 1: Write the failing test**

`test/scope.test.ts`:

```ts
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { run } from "../src/run.js";
import { gitBranch, inScope, repoKey } from "../src/sessions/scope.js";
import type { Runner } from "../src/types.js";

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), "consult-scope-")));
const reply = (stdout: string, code = 0) => vi.fn<Runner>(async () => ({ stdout, stderr: "", code }));

describe("repoKey", () => {
  it("resolves a relative git common dir against the cwd", async () => {
    const dir = tmp();
    expect(await repoKey(reply(".git\n"), dir)).toBe(join(dir, ".git"));
  });

  it("falls back to the directory outside a git repo", async () => {
    const dir = tmp();
    expect(await repoKey(reply("", 128), dir)).toBe(dir);
  });

  it("falls back to the directory when git is not installed", async () => {
    const dir = tmp();
    const missing = vi.fn<Runner>(async () => {
      throw new Error("git CLI not found on PATH");
    });
    expect(await repoKey(missing, dir)).toBe(dir);
  });

  it("gives every worktree of a repository the same key, and other repos a different one", async () => {
    const main = tmp();
    const git = (cwd: string, ...args: string[]) =>
      run("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, timeoutMs: 10_000 });
    await git(main, "init", "-q");
    await git(main, "commit", "-q", "--allow-empty", "-m", "init");
    const worktree = join(tmp(), "wt");
    expect((await git(main, "worktree", "add", "-q", worktree, "-b", "feature")).code).toBe(0);
    expect(await repoKey(run, worktree)).toBe(await repoKey(run, main));
    expect(await repoKey(run, tmp())).not.toBe(await repoKey(run, main));
  });
});

describe("gitBranch", () => {
  it("returns the current branch", async () => {
    expect(await gitBranch(reply("main\n"), "/r")).toBe("main");
  });

  it("returns undefined for a detached HEAD or outside git", async () => {
    expect(await gitBranch(reply("HEAD\n"), "/r")).toBeUndefined();
    expect(await gitBranch(reply("", 128), "/r")).toBeUndefined();
  });
});

describe("inScope", () => {
  it("matches only the same repo in repo scope, and everything in machine scope", () => {
    const a = { repoKey: "/a/.git" };
    const b = { repoKey: "/b/.git" };
    expect(inScope(a, { repoKey: "/a/.git" }, "repo")).toBe(true);
    expect(inScope(a, b, "repo")).toBe(false);
    expect(inScope(a, b, "machine")).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/scope.test.ts`
Expected: FAIL, cannot load `../src/sessions/scope.js`.

- [ ] **Step 3: Implement**

`src/sessions/scope.ts`:

```ts
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { Scope } from "../settings.js";
import type { Runner } from "../types.js";

const GIT_TIMEOUT_MS = 5_000;

const real = (path: string) => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

async function git(run: Runner, cwd: string, args: readonly string[]): Promise<string> {
  const res = await run("git", args, { cwd, timeoutMs: GIT_TIMEOUT_MS }).catch(() => undefined);
  return res?.code === 0 ? res.stdout.trim() : "";
}

/** Identifies a repository by its git common dir, which all its worktrees share. Outside git: the directory. */
export async function repoKey(run: Runner, cwd: string): Promise<string> {
  const commonDir = await git(run, cwd, ["rev-parse", "--git-common-dir"]);
  return real(commonDir ? resolve(cwd, commonDir) : resolve(cwd));
}

export async function gitBranch(run: Runner, cwd: string): Promise<string | undefined> {
  const branch = await git(run, cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return branch && branch !== "HEAD" ? branch : undefined;
}

export function inScope(self: { readonly repoKey: string }, other: { readonly repoKey: string }, scope: Scope): boolean {
  return scope === "machine" || self.repoKey === other.repoKey;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/scope.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sessions/scope.ts test/scope.test.ts
git commit -m "feat: repo and machine scope for live sessions"
```

---

### Task 3: Registry

**Files:**
- Create: `src/sessions/registry.ts`
- Test: `test/registry.test.ts`

**Interfaces:**
- Consumes: `AGENTS` from `src/types.ts`.
- Produces:
  - `type SessionEntry = Readonly<{ version: 1; pid: number; agent: AgentName; sessionId: string; cwd: string; repoKey: string; branch?: string; startedAt: string; transcriptPath?: string }>`
  - `registryDir(env?: NodeJS.ProcessEnv): string`
  - `writeEntry(dir: string, entry: SessionEntry): void`
  - `removeEntry(dir: string, pid: number): void`
  - `pidAlive(pid: number): boolean`
  - `listLive(dir: string, isAlive?: (pid: number) => boolean): readonly SessionEntry[]` (newest first)

- [ ] **Step 1: Write the failing test**

`test/registry.test.ts`:

```ts
import { existsSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listLive, registryDir, removeEntry, writeEntry, type SessionEntry } from "../src/sessions/registry.js";

const tmpDir = () => join(mkdtempSync(join(tmpdir(), "consult-registry-")), "sessions");
const entry = (overrides: Partial<SessionEntry> = {}): SessionEntry => ({
  version: 1,
  pid: 101,
  agent: "codex",
  sessionId: "s-101",
  cwd: "/repo",
  repoKey: "/repo/.git",
  startedAt: "2026-10-01T10:00:00.000Z",
  ...overrides,
});
const alive = (pids: number[]) => (pid: number) => pids.includes(pid);

describe("registryDir", () => {
  it("uses XDG_STATE_HOME when set, else ~/.local/state", () => {
    expect(registryDir({ XDG_STATE_HOME: "/state" })).toBe(join("/state", "consult", "sessions"));
    expect(registryDir({})).toBe(join(homedir(), ".local", "state", "consult", "sessions"));
  });
});

describe("registry", () => {
  it("lists what was written, newest first, in a directory only the user can read", () => {
    const dir = tmpDir();
    writeEntry(dir, entry());
    writeEntry(dir, entry({ pid: 102, sessionId: "s-102", startedAt: "2026-10-01T11:00:00.000Z" }));
    expect(listLive(dir, alive([101, 102])).map((e) => e.sessionId)).toEqual(["s-102", "s-101"]);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, "101.json")).mode & 0o777).toBe(0o600);
  });

  it("deletes entries whose server has died", () => {
    const dir = tmpDir();
    writeEntry(dir, entry());
    expect(listLive(dir, alive([]))).toEqual([]);
    expect(existsSync(join(dir, "101.json"))).toBe(false);
  });

  it("skips half-written entries of live servers without deleting them, and ignores other files", () => {
    const dir = tmpDir();
    writeEntry(dir, entry());
    writeFileSync(join(dir, "101.json"), "{ half-writ");
    writeFileSync(join(dir, "notes.txt"), "not an entry");
    expect(listLive(dir, alive([101]))).toEqual([]);
    expect(existsSync(join(dir, "101.json"))).toBe(true);
  });

  it("ignores an entry whose pid does not match its file name", () => {
    const dir = tmpDir();
    writeEntry(dir, entry());
    writeFileSync(join(dir, "104.json"), JSON.stringify(entry({ pid: 103 })));
    expect(listLive(dir, alive([101, 104])).map((e) => e.pid)).toEqual([101]);
  });

  it("keeps only the newest entry for a session registered twice", () => {
    const dir = tmpDir();
    writeEntry(dir, entry({ pid: 101, startedAt: "2026-10-01T10:00:00.000Z" }));
    writeEntry(dir, entry({ pid: 102, startedAt: "2026-10-01T12:00:00.000Z" }));
    expect(listLive(dir, alive([101, 102])).map((e) => e.pid)).toEqual([102]);
  });

  it("returns nothing when the directory does not exist yet", () => {
    expect(listLive(tmpDir(), alive([101]))).toEqual([]);
  });

  it("removes an entry, tolerates removing it twice, and leaves no temp files", () => {
    const dir = tmpDir();
    writeEntry(dir, entry());
    removeEntry(dir, 101);
    removeEntry(dir, 101);
    expect(readdirSync(dir)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/registry.test.ts`
Expected: FAIL, cannot load `../src/sessions/registry.js`.

- [ ] **Step 3: Implement**

`src/sessions/registry.ts`:

```ts
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { AGENTS } from "../types.js";

const entrySchema = z.object({
  version: z.literal(1),
  /** The consult server's pid; it names the file and tells readers whether the entry is stale. */
  pid: z.number().int().positive(),
  agent: z.enum(AGENTS),
  sessionId: z.string().min(1),
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/registry.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sessions/registry.ts test/registry.test.ts
git commit -m "feat: file registry of live agent sessions"
```

---

### Task 4: Host and session identity

**Files:**
- Create: `src/sessions/identity.ts`
- Test: `test/identity.test.ts`

**Interfaces:**
- Consumes: `AGENTS`, `AgentName`, `Runner` from `src/types.ts`.
- Produces:
  - `interface ProcessInfo { pid: number; name: string }`
  - `interface Host { agent: AgentName; pid?: number }`
  - `interface Identity { sessionId: string; transcriptPath?: string }`
  - `interface IdentityDeps { env: NodeJS.ProcessEnv; ancestors(): Promise<readonly ProcessInfo[]>; openFiles(pid: number): Promise<readonly string[]>; claudeTranscript(sessionId: string): string | undefined }`
  - `detectHost(deps: IdentityDeps): Promise<Host | undefined>`
  - `currentSession(host: Host, deps: IdentityDeps): Promise<Identity | undefined>`
  - `systemIdentityDeps(run: Runner, env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform, startPid?: number): IdentityDeps`

Facts verified on 2026-10-01: Claude passes `CLAUDE_CODE_SESSION_ID` to MCP servers. Codex passes no session variable, but its process holds `~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<thread uuid>.jsonl` open. Under npx the chain is `codex|claude -> npm exec ... -> node cli.js serve`. Grok is unresolved (Task 16).

- [ ] **Step 1: Write the failing test**

`test/identity.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import {
  currentSession,
  detectHost,
  systemIdentityDeps,
  type IdentityDeps,
  type ProcessInfo,
} from "../src/sessions/identity.js";
import type { Runner } from "../src/types.js";

const ID = "11111111-2222-7333-8444-555555555555";
const LATER = "66666666-7777-7888-9999-aaaaaaaaaaaa";

function deps(overrides: Partial<IdentityDeps> = {}): IdentityDeps {
  return { env: {}, ancestors: async () => [], openFiles: async () => [], claudeTranscript: () => undefined, ...overrides };
}
const chain = (...names: string[]): readonly ProcessInfo[] => names.map((name, i) => ({ pid: 100 + i, name }));

describe("detectHost", () => {
  it("finds the nearest agent CLI among the server's ancestors", async () => {
    expect(await detectHost(deps({ ancestors: async () => chain("npm", "codex", "zsh") }))).toEqual({ agent: "codex", pid: 101 });
  });

  it("prefers the nearest agent over a CLAUDE_CODE_SESSION_ID inherited from an outer Claude Code shell", async () => {
    const d = deps({ env: { CLAUDE_CODE_SESSION_ID: "outer" }, ancestors: async () => chain("npm", "grok", "zsh", "claude") });
    expect(await detectHost(d)).toEqual({ agent: "grok", pid: 101 });
  });

  it("falls back to CLAUDE_CODE_SESSION_ID when claude runs under another process name", async () => {
    const d = deps({ env: { CLAUDE_CODE_SESSION_ID: ID }, ancestors: async () => chain("npm", "node") });
    expect(await detectHost(d)).toEqual({ agent: "claude" });
  });

  it("returns undefined when no agent started the server", async () => {
    expect(await detectHost(deps({ ancestors: async () => chain("zsh", "login") }))).toBeUndefined();
  });
});

describe("currentSession", () => {
  it("reads claude's session id from the environment and finds its transcript", async () => {
    const d = deps({ env: { CLAUDE_CODE_SESSION_ID: ID }, claudeTranscript: (id) => `/home/u/.claude/projects/p/${id}.jsonl` });
    expect(await currentSession({ agent: "claude" }, d)).toEqual({
      sessionId: ID,
      transcriptPath: `/home/u/.claude/projects/p/${ID}.jsonl`,
    });
  });

  it("rejects a claude session id that could escape the projects directory", async () => {
    expect(await currentSession({ agent: "claude" }, deps({ env: { CLAUDE_CODE_SESSION_ID: "../../etc" } }))).toBeUndefined();
  });

  it("takes codex's main thread from the rollout files its process holds open", async () => {
    const main = `/home/u/.codex/sessions/2026/10/01/rollout-2026-10-01T11-32-34-${ID}.jsonl`;
    const openFiles = vi.fn(async () => [
      "/dev/null",
      `/home/u/.codex/sessions/2026/10/01/rollout-2026-10-01T11-40-00-${LATER}.jsonl`,
      main,
    ]);
    expect(await currentSession({ agent: "codex", pid: 4242 }, deps({ openFiles }))).toEqual({ sessionId: ID, transcriptPath: main });
    expect(openFiles).toHaveBeenCalledWith(4242);
  });

  it("returns undefined for codex before it opens a rollout, and for grok", async () => {
    expect(await currentSession({ agent: "codex", pid: 1 }, deps({ openFiles: async () => ["/dev/null"] }))).toBeUndefined();
    expect(await currentSession({ agent: "grok", pid: 1 }, deps())).toBeUndefined();
  });
});

describe("systemIdentityDeps", () => {
  it("walks ps output up the process tree", async () => {
    const table: Record<string, string> = {
      "50": "   40 npm exec consult-mcp@latest serve\n",
      "40": "   30 /usr/local/bin/codex\n",
      "30": "    1 -zsh\n",
    };
    const run = vi.fn<Runner>(async (_cmd, args) => {
      const out = table[args.at(-1)!];
      return { stdout: out ?? "", stderr: "", code: out ? 0 : 1 };
    });
    const { ancestors } = systemIdentityDeps(run, {}, "darwin", 50);
    expect(await ancestors()).toEqual([
      { pid: 50, name: "npm" },
      { pid: 40, name: "codex" },
      { pid: 30, name: "-zsh" },
    ]);
  });

  it("parses lsof's file names on macOS", async () => {
    const run = vi.fn<Runner>(async () => ({
      stdout: "p40\nfcwd\nn/home/u/repo\nf12\nn/home/u/.codex/sessions/r.jsonl\n",
      stderr: "",
      code: 0,
    }));
    expect(await systemIdentityDeps(run, {}, "darwin").openFiles(40)).toEqual(["/home/u/repo", "/home/u/.codex/sessions/r.jsonl"]);
    expect(run).toHaveBeenCalledWith("lsof", ["-p", "40", "-Fn"], expect.anything());
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/identity.test.ts`
Expected: FAIL, cannot load `../src/sessions/identity.js`.

- [ ] **Step 3: Implement**

`src/sessions/identity.ts`:

```ts
import { existsSync, readdirSync, readlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { AGENTS, type AgentName, type Runner } from "../types.js";

export interface ProcessInfo {
  readonly pid: number;
  readonly name: string;
}

/** The agent CLI that started this server. `pid` is missing when it was recognised only by its environment. */
export interface Host {
  readonly agent: AgentName;
  readonly pid?: number;
}

export interface Identity {
  readonly sessionId: string;
  readonly transcriptPath?: string;
}

export interface IdentityDeps {
  readonly env: NodeJS.ProcessEnv;
  /** This server's ancestor processes, nearest first. */
  readonly ancestors: () => Promise<readonly ProcessInfo[]>;
  readonly openFiles: (pid: number) => Promise<readonly string[]>;
  readonly claudeTranscript: (sessionId: string) => string | undefined;
}

const MAX_DEPTH = 6;
const PROC_OPTS = { cwd: "/", timeoutMs: 5_000 } as const;
const PS_LINE = /^\s*(\d+)\s+(\S.*?)\s*$/;
const SAFE_ID = /^[A-Za-z0-9-]+$/;
const ROLLOUT = /rollout-[^/]*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/;

const isAgent = (name: string): name is AgentName => (AGENTS as readonly string[]).includes(name);

/**
 * The nearest agent CLI among this server's ancestors. An agent started from another agent's terminal inherits
 * that agent's environment, so the process tree decides; CLAUDE_CODE_SESSION_ID is only a fallback for claude
 * builds that run under a different process name.
 */
export async function detectHost(deps: IdentityDeps): Promise<Host | undefined> {
  const nearest = (await deps.ancestors()).find((p) => isAgent(p.name));
  if (nearest) return { agent: nearest.name as AgentName, pid: nearest.pid };
  return deps.env.CLAUDE_CODE_SESSION_ID ? { agent: "claude" } : undefined;
}

export async function currentSession(host: Host, deps: IdentityDeps): Promise<Identity | undefined> {
  switch (host.agent) {
    case "claude": {
      const sessionId = deps.env.CLAUDE_CODE_SESSION_ID;
      if (!sessionId || !SAFE_ID.test(sessionId)) return undefined;
      const transcriptPath = deps.claudeTranscript(sessionId);
      return { sessionId, ...(transcriptPath ? { transcriptPath } : {}) };
    }
    case "codex": {
      if (host.pid === undefined) return undefined;
      // Subagent threads open rollouts too. The main thread opened its rollout first, and the name starts
      // with that timestamp, so it sorts first.
      const rollouts = (await deps.openFiles(host.pid))
        .filter((f) => ROLLOUT.test(f))
        .sort((a, b) => basename(a).localeCompare(basename(b)));
      const transcriptPath = rollouts[0];
      const sessionId = transcriptPath ? ROLLOUT.exec(transcriptPath)?.[1] : undefined;
      return transcriptPath && sessionId ? { sessionId, transcriptPath } : undefined;
    }
    case "grok":
      // Grok does not expose which session a process runs, so grok sessions can ask but cannot be asked.
      return undefined;
  }
}

function procFds(pid: number): readonly string[] {
  try {
    return readdirSync(`/proc/${pid}/fd`).flatMap((fd) => {
      try {
        return [readlinkSync(`/proc/${pid}/fd/${fd}`)];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

export function systemIdentityDeps(
  run: Runner,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  startPid: number = process.ppid,
): IdentityDeps {
  return {
    env,
    async ancestors() {
      const chain: ProcessInfo[] = [];
      for (let pid = startPid; pid > 1 && chain.length < MAX_DEPTH; ) {
        const res = await run("ps", ["-o", "ppid=,comm=", "-p", String(pid)], PROC_OPTS).catch(() => undefined);
        const match = res?.code === 0 ? PS_LINE.exec(res.stdout) : null;
        if (!match) break;
        chain.push({ pid, name: basename(match[2]!.split(/\s+/)[0]!) });
        pid = Number(match[1]);
      }
      return chain;
    },
    async openFiles(pid) {
      if (platform === "linux") return procFds(pid);
      const res = await run("lsof", ["-p", String(pid), "-Fn"], PROC_OPTS).catch(() => undefined);
      return (res?.stdout ?? "")
        .split("\n")
        .filter((line) => line.startsWith("n"))
        .map((line) => line.slice(1));
    },
    claudeTranscript(sessionId) {
      const projects = join(env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects");
      let dirs: string[];
      try {
        dirs = readdirSync(projects);
      } catch {
        return undefined;
      }
      return dirs.map((dir) => join(projects, dir, `${sessionId}.jsonl`)).find((path) => existsSync(path));
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/identity.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sessions/identity.ts test/identity.test.ts
git commit -m "feat: identify the host agent session a consult server runs in"
```

---

### Task 5: Session title and last activity

**Files:**
- Create: `src/sessions/describe.ts`
- Test: `test/describe.test.ts`

**Interfaces:**
- Consumes: `SessionEntry` (Task 3); `codexConfigPath` from `src/codex-config.ts`.
- Produces:
  - `interface SessionDetails { title?: string; lastActive?: string }`
  - `readTail(path: string, bytes?: number): string | undefined`
  - `codexIndexPath(env?: NodeJS.ProcessEnv): string`
  - `describeSession(entry: SessionEntry, codexIndex: string): SessionDetails`

Facts verified on 2026-10-01: Claude transcripts contain lines `{"type":"ai-title","aiTitle":"…","sessionId":"…"}`, and later ones replace earlier ones. Codex keeps `$CODEX_HOME/session_index.jsonl` with lines `{"id":"…","thread_name":"…","updated_at":"…"}`.

- [ ] **Step 1: Write the failing test**

`test/describe.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/describe.test.ts`
Expected: FAIL, cannot load `../src/sessions/describe.js`.

- [ ] **Step 3: Implement**

`src/sessions/describe.ts`:

```ts
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/describe.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sessions/describe.ts test/describe.test.ts
git commit -m "feat: titles and last activity for live sessions"
```

---

### Task 6: Adapters can fork a session

**Files:**
- Modify: `src/types.ts` (`Adapter` interface)
- Modify: `src/adapters/claude.ts`, `src/adapters/codex.ts`, `src/adapters/grok.ts`
- Modify: `src/prompt.ts`
- Test: `test/adapters.test.ts` (append), `test/prompt.test.ts` (create)

**Interfaces:**
- Produces:
  - `Adapter.fork(sourceSessionId: string, request: AskRequest, prompt: string, extraArgs: readonly string[]): Invocation`
  - `frameForkPrompt(question: string): string`

Fork commands verified on 2026-10-01: `claude --resume <id> --fork-session`; `codex exec fork [OPTIONS] <SESSION_ID> [PROMPT]` (accepts `--json`, `--skip-git-repo-check`, `-c`); `grok --resume <id> --fork-session`.

- [ ] **Step 1: Write the failing tests**

Append to `test/adapters.test.ts`:

```ts
describe("forking a live session", () => {
  const request: AskRequest = { agent: "claude", question: "q", cwd: "/repo", effort: "low" };

  it("claude resumes the source with --fork-session and the same containment", () => {
    const inv = claude.fork("SRC", request, "PROMPT", []);
    expect(valueAfter(inv.args, "--resume")).toBe("SRC");
    expect(inv.args).toContain("--fork-session");
    expect(inv.args).toContain("--restricted");
    expect(inv.args).toContain("--strict-mcp-config");
    expect(valueAfter(inv.args, "--tools")).toBe("Read,Grep,Glob");
    expect(valueAfter(inv.args, "--effort")).toBe("low");
    expect(inv.args).not.toContain("--session-id");
    expect(inv.args.at(-1)).toBe("PROMPT");
  });

  it("codex uses exec fork with the read-only sandbox and the MCP switches from prepare", () => {
    const inv = codex.fork("SRC", { ...request, agent: "codex" }, "PROMPT", ["-c", "mcp_servers.x.enabled=false"]);
    expect(inv.command).toBe("codex");
    expect(inv.args.slice(0, 3)).toEqual(["exec", "fork", "--json"]);
    expect(inv.args).toContain('sandbox_mode="read-only"');
    expect(inv.args).toContain('approval_policy="never"');
    expect(inv.args).toContain("mcp_servers.x.enabled=false");
    expect(inv.args).toContain('model_reasoning_effort="low"');
    expect(inv.args.slice(-2)).toEqual(["SRC", "PROMPT"]);
  });

  it("grok resumes the source with --fork-session and only read-only tools", () => {
    const inv = grok.fork("SRC", { ...request, agent: "grok" }, "PROMPT", []);
    expect(valueAfter(inv.args, "--single")).toBe("PROMPT");
    expect(valueAfter(inv.args, "--resume")).toBe("SRC");
    expect(inv.args).toContain("--fork-session");
    expect(valueAfter(inv.args, "--tools")).toBe("read_file,grep,list_dir");
    expect(valueAfter(inv.args, "--disallowed-tools")).toBe("Agent,search_tool,use_tool");
    expect(inv.args).not.toContain("--session-id");
  });
});
```

Create `test/prompt.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/adapters.test.ts test/prompt.test.ts`
Expected: FAIL, `claude.fork is not a function` and `frameForkPrompt` is not exported.

- [ ] **Step 3: Implement**

In `src/types.ts`, add to `interface Adapter` after `build(...)`:

```ts
  /** Like build, but in a new session forked from `sourceSessionId`. The source session is only read. */
  fork(sourceSessionId: string, request: AskRequest, prompt: string, extraArgs: readonly string[]): Invocation;
```

Replace the body of `src/adapters/claude.ts` above `parse` (keep `parse` and the `ClaudeResult` interface unchanged):

```ts
import { randomUUID } from "node:crypto";
import { AdvisorError, type Adapter, type AskRequest, type Invocation } from "../types.js";

// (ClaudeResult interface unchanged)

// --restricted drops every tool that runs commands or code and confines file tools to the cwd;
// --strict-mcp-config with no --mcp-config loads no MCP servers, so the advisor cannot call consult back.
const CONTAINMENT = ["--restricted", "--tools", "Read,Grep,Glob", "--strict-mcp-config"] as const;

function invocation(request: AskRequest, prompt: string, session: readonly string[]): Invocation {
  return {
    command: "claude",
    args: [
      "-p",
      "--output-format", "json",
      ...CONTAINMENT,
      ...session,
      ...(request.model ? ["--model", request.model] : []),
      ...(request.effort ? ["--effort", request.effort] : []),
      prompt,
    ],
  };
}

export const claude: Adapter = {
  name: "claude",
  command: "claude",

  build(request, prompt) {
    return invocation(request, prompt, request.sessionId ? ["--resume", request.sessionId] : ["--session-id", randomUUID()]);
  },

  // --fork-session copies the source into a new session id, so the live session's transcript is never written.
  fork(sourceSessionId, request, prompt) {
    return invocation(request, prompt, ["--resume", sourceSessionId, "--fork-session"]);
  },

  // parse(stdout) { ...unchanged... },
};
```

In `src/adapters/codex.ts`, add the `AskRequest` type import, replace `build` and add `fork`:

```ts
import { AdvisorError, type Adapter, type AskRequest } from "../types.js";

function configArgs(request: AskRequest, extraArgs: readonly string[]): readonly string[] {
  return [
    "-c", 'sandbox_mode="read-only"',
    "-c", 'approval_policy="never"',
    ...(request.model ? ["-c", `model=${JSON.stringify(request.model)}`] : []),
    ...(request.effort ? ["-c", `model_reasoning_effort="${request.effort}"`] : []),
    ...extraArgs,
  ];
}

// inside `export const codex: Adapter = { ... }`:
  build(request, prompt, extraArgs) {
    const head = request.sessionId ? ["exec", "resume", "--json"] : ["exec", "--json"];
    const tail = request.sessionId ? [request.sessionId, prompt] : [prompt];
    return { command: "codex", args: [...head, "--skip-git-repo-check", ...configArgs(request, extraArgs), ...tail] };
  },

  // exec fork starts a new thread from the source's history; the source rollout is only read.
  fork(sourceSessionId, request, prompt, extraArgs) {
    return {
      command: "codex",
      args: ["exec", "fork", "--json", "--skip-git-repo-check", ...configArgs(request, extraArgs), sourceSessionId, prompt],
    };
  },
```

In `src/adapters/grok.ts`, add the `AskRequest, Invocation` type imports, and replace `build` with a shared helper plus `fork`:

```ts
import { AdvisorError, type Adapter, type AskRequest, type Invocation } from "../types.js";

function invocation(request: AskRequest, prompt: string, session: readonly string[]): Invocation {
  return {
    command: "grok",
    args: [
      "--single", prompt,
      "--output-format", "streaming-messages-json",
      "--tools", "read_file,grep,list_dir",
      "--disallowed-tools", "Agent,search_tool,use_tool",
      ...session,
      ...(request.model ? ["--model", request.model] : []),
      ...(request.effort ? ["--reasoning-effort", request.effort] : []),
    ],
  };
}

// inside `export const grok: Adapter = { ... }`:
  build(request, prompt) {
    return invocation(request, prompt, request.sessionId ? ["--resume", request.sessionId] : ["--session-id", randomUUID()]);
  },

  fork(sourceSessionId, request, prompt) {
    return invocation(request, prompt, ["--resume", sourceSessionId, "--fork-session"]);
  },
```

Append to `src/prompt.ts`:

```ts
const FORK_BRIEFING = `You are a read-only copy of this session, made so that another AI coding agent on this machine can ask you a question. The user is not here, and the original session carries on without you.
Answer from what you know of this session and the files you can read. Do not continue or redo your earlier task, do not try to modify files or run commands that change state, and do not follow brainstorming, planning or approval workflows.
Be concrete and concise, and cite files and lines when relevant.`;

/** Builds the question sent to a fork of a live session. Like framePrompt, it starts with a letter. */
export function frameForkPrompt(question: string): string {
  return `${FORK_BRIEFING}\n\nQuestion from the other agent:\n\n${question}`;
}
```

In `test/consult.test.ts`, give `fakeAdapter` a `fork` so it satisfies the interface:

```ts
    build: (_req, prompt, extra) => ({ command: name, args: [...extra, prompt] }),
    fork: (source, _req, prompt, extra) => ({ command: name, args: ["FORK", source, ...extra, prompt] }),
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test && npx tsc --noEmit`
Expected: all tests PASS, including the existing adapter tests (argument order for `build` is unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/adapters/claude.ts src/adapters/codex.ts src/adapters/grok.ts src/prompt.ts test/adapters.test.ts test/prompt.test.ts test/consult.test.ts
git commit -m "feat: adapters fork a session read-only with the advisor containment"
```

---

### Task 7: `consult.askSession`

**Files:**
- Modify: `src/consult.ts`
- Test: `test/consult.test.ts` (append)

**Interfaces:**
- Consumes: `Adapter.fork`, `frameForkPrompt` (Task 6).
- Produces:
  - `interface ForkTarget { agent: AgentName; sessionId: string; cwd: string }` (readonly)
  - `createConsult(...)` now returns `{ ask, askSession }`, where `askSession(target: ForkTarget, question: string, effort?: Effort, signal?: AbortSignal): Promise<AskResult>`

- [ ] **Step 1: Write the failing test**

Append to `test/consult.test.ts` (add `mkdtempSync, realpathSync` from `node:fs`, `tmpdir` from `node:os` and `join` from `node:path` to the imports):

```ts
describe("consult.askSession", () => {
  const target = () => realpathSync(mkdtempSync(join(tmpdir(), "consult-target-")));

  it("forks the target session in the target's own directory with the fork briefing", async () => {
    const run = vi.fn<Runner>(async () => ok("raw"));
    const cwd = target();
    const result = await setup(run).askSession({ agent: "codex", sessionId: "live-1", cwd }, "What did you change in the API?", "high");
    expect(result).toMatchObject({ agent: "codex", answer: "answer:raw", sessionId: "sid-1" });
    const [cmd, args, opts] = run.mock.calls[0]!;
    expect(cmd).toBe("codex");
    expect(args.slice(0, 2)).toEqual(["FORK", "live-1"]);
    expect(opts).toMatchObject({ cwd });
    expect(args.at(-1)).toMatch(/read-only copy/i);
    expect(args.at(-1)).toContain("What did you change in the API?");
  });

  it("runs prepare in the target's directory", async () => {
    const prepare = vi.fn(async () => ["-c", "off"]);
    const run = vi.fn<Runner>(async () => ok());
    const cwd = target();
    await setup(run, fakeAdapter("codex", { prepare })).askSession({ agent: "codex", sessionId: "s", cwd }, "q");
    expect(prepare).toHaveBeenCalledWith(run, cwd, undefined);
    expect(run.mock.calls[0]![1]).toContain("off");
  });

  it("reports a target whose directory is gone", async () => {
    await expect(setup(vi.fn<Runner>()).askSession({ agent: "codex", sessionId: "s", cwd: "/does/not/exist" }, "q")).rejects.toThrow(
      /cwd is not a directory/,
    );
  });

  it("reports a failed fork like any advisor failure", async () => {
    const run = vi.fn<Runner>(async () => ({ stdout: "", stderr: "no such session", code: 1 }));
    await expect(setup(run).askSession({ agent: "codex", sessionId: "s", cwd: target() }, "q")).rejects.toThrow(
      /codex exited with code 1: no such session/,
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/consult.test.ts`
Expected: FAIL, `askSession is not a function`.

- [ ] **Step 3: Implement**

In `src/consult.ts`, change the imports and replace `createConsult` (keep `validate`, `stoppedMessage` and `STDERR_TAIL` as they are):

```ts
import { frameForkPrompt, framePrompt } from "./prompt.js";
import {
  AdvisorError,
  type Adapter,
  type AgentName,
  type AskRequest,
  type AskResult,
  type Effort,
  type Invocation,
  type Runner,
  type StopReason,
} from "./types.js";

/** A live session to fork: the CLI that owns it, its id, and the directory it runs in. */
export interface ForkTarget {
  readonly agent: AgentName;
  readonly sessionId: string;
  readonly cwd: string;
}

export function createConsult({ run, adapters, timeoutMs }: ConsultDeps) {
  async function execute(
    adapter: Adapter,
    request: AskRequest,
    invoke: (extraArgs: readonly string[]) => Invocation,
    signal?: AbortSignal,
  ): Promise<AskResult> {
    validate(request);
    const started = Date.now();
    // Computed per call, never cached: containment must reflect the config as it is right now.
    const extraArgs = adapter.prepare ? await adapter.prepare(run, request.cwd, signal) : [];
    const invocation = invoke(extraArgs);
    const res = await run(invocation.command, invocation.args, { cwd: request.cwd, timeoutMs, signal });

    if (res.stopped) throw new AdvisorError(stoppedMessage(adapter.name, res.stopped, timeoutMs));
    if (res.code !== 0) {
      const detail = (res.stderr.trim() || res.stdout.trim()).slice(-STDERR_TAIL);
      throw new AdvisorError(`${adapter.name} exited with code ${res.code}: ${detail}`);
    }
    return { agent: adapter.name, ...adapter.parse(res.stdout), durationMs: Date.now() - started };
  }

  async function ask(request: AskRequest, signal?: AbortSignal): Promise<AskResult> {
    const adapter = adapters[request.agent];
    const prompt = framePrompt(request.question, Boolean(request.sessionId));
    return execute(adapter, request, (extra) => adapter.build(request, prompt, extra), signal);
  }

  /** Asks a read-only fork of a live session. It runs in that session's directory, where its CLI can find it. */
  async function askSession(target: ForkTarget, question: string, effort?: Effort, signal?: AbortSignal): Promise<AskResult> {
    const adapter = adapters[target.agent];
    const request: AskRequest = { agent: target.agent, question, cwd: target.cwd, ...(effort ? { effort } : {}) };
    return execute(adapter, request, (extra) => adapter.fork(target.sessionId, request, frameForkPrompt(question), extra), signal);
  }

  return { ask, askSession };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/consult.test.ts && npx tsc --noEmit`
Expected: PASS, both the old `consult.ask` tests and the new ones.

- [ ] **Step 5: Commit**

```bash
git add src/consult.ts test/consult.test.ts
git commit -m "feat: ask a read-only fork of a live session"
```

---

### Task 8: Sessions service

**Files:**
- Create: `src/sessions/service.ts`
- Test: `test/sessions-service.test.ts`

**Interfaces:**
- Consumes: `Settings` (Task 1), `inScope` (Task 2), `SessionEntry` (Task 3), `SessionDetails` (Task 5), `ForkTarget` (Task 7).
- Produces:
  - `interface Self { repoKey: string; sessionId?: string }`
  - `interface SessionView { session_id: string; agent: AgentName; cwd: string; branch?: string; title?: string; started_at: string; last_active?: string }`
  - `interface SessionAnswer extends AskResult { cwd: string; source: string }`
  - `interface SessionsDeps { self(): Self; settings(): Settings; listLive(): readonly SessionEntry[]; describe(entry): SessionDetails; askFork(target: ForkTarget, question: string, effort: Effort | undefined, signal?: AbortSignal): Promise<AskResult> }`
  - `createSessions(deps): { list(): readonly SessionView[]; ask(sessionId: string, question: string, effort: Effort | undefined, signal?: AbortSignal): Promise<SessionAnswer> }`

- [ ] **Step 1: Write the failing test**

`test/sessions-service.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, withSessionsMode, type Settings } from "../src/settings.js";
import type { SessionEntry } from "../src/sessions/registry.js";
import { createSessions, type SessionsDeps } from "../src/sessions/service.js";

const entry = (sessionId: string, repoKey: string, overrides: Partial<SessionEntry> = {}): SessionEntry => ({
  version: 1,
  pid: 1,
  agent: "codex",
  sessionId,
  cwd: `/work/${sessionId}`,
  repoKey,
  startedAt: "2026-10-01T10:00:00.000Z",
  ...overrides,
});

function setup(settings: Settings) {
  const deps: SessionsDeps = {
    self: () => ({ repoKey: "/a/.git", sessionId: "me" }),
    settings: () => settings,
    listLive: () => [entry("me", "/a/.git"), entry("same-repo", "/a/.git", { branch: "feat" }), entry("elsewhere", "/b/.git")],
    describe: (e) => (e.sessionId === "same-repo" ? { title: "Auth refactor", lastActive: "2026-10-01T11:00:00.000Z" } : {}),
    askFork: vi.fn(async (target) => ({ agent: target.agent, answer: "We renamed it.", sessionId: "fork-1", durationMs: 5 })),
  };
  return { deps, sessions: createSessions(deps) };
}

describe("live sessions service", () => {
  it("lists other sessions in the same repo, with their details, in repo scope", () => {
    const { sessions } = setup(withSessionsMode(DEFAULT_SETTINGS, "repo"));
    expect(sessions.list()).toEqual([
      {
        session_id: "same-repo",
        agent: "codex",
        cwd: "/work/same-repo",
        branch: "feat",
        title: "Auth refactor",
        started_at: "2026-10-01T10:00:00.000Z",
        last_active: "2026-10-01T11:00:00.000Z",
      },
    ]);
  });

  it("lists every other session in machine scope", () => {
    const { sessions } = setup(withSessionsMode(DEFAULT_SETTINGS, "machine"));
    expect(sessions.list().map((s) => s.session_id)).toEqual(["same-repo", "elsewhere"]);
  });

  it("refuses to list or ask once live sessions are turned off, without a restart", async () => {
    const { sessions } = setup(DEFAULT_SETTINGS);
    expect(() => sessions.list()).toThrow(/turned off.*consult settings/);
    await expect(sessions.ask("same-repo", "q", undefined)).rejects.toThrow(/turned off/);
  });

  it("asks a fork of the target in the target's directory and says where to follow up", async () => {
    const { sessions, deps } = setup(withSessionsMode(DEFAULT_SETTINGS, "repo"));
    const answer = await sessions.ask("same-repo", "What did you rename?", "low");
    expect(deps.askFork).toHaveBeenCalledWith(
      { agent: "codex", sessionId: "same-repo", cwd: "/work/same-repo" },
      "What did you rename?",
      "low",
      undefined,
    );
    expect(answer).toMatchObject({ answer: "We renamed it.", sessionId: "fork-1", cwd: "/work/same-repo", source: "same-repo" });
  });

  it("refuses its own session, unknown sessions and sessions outside the scope", async () => {
    const { sessions } = setup(withSessionsMode(DEFAULT_SETTINGS, "repo"));
    await expect(sessions.ask("me", "q", undefined)).rejects.toThrow(/your own session/);
    await expect(sessions.ask("ghost", "q", undefined)).rejects.toThrow(/no live session ghost/);
    await expect(sessions.ask("elsewhere", "q", undefined)).rejects.toThrow(/no live session elsewhere/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/sessions-service.test.ts`
Expected: FAIL, cannot load `../src/sessions/service.js`.

- [ ] **Step 3: Implement**

`src/sessions/service.ts`:

```ts
import type { ForkTarget } from "../consult.js";
import type { Settings } from "../settings.js";
import { AdvisorError, type AgentName, type AskResult, type Effort } from "../types.js";
import type { SessionDetails } from "./describe.js";
import type { SessionEntry } from "./registry.js";
import { inScope } from "./scope.js";

/** This server's own session: its repo, and its session id once known. */
export interface Self {
  readonly repoKey: string;
  readonly sessionId?: string;
}

/** What list_sessions shows about a session: metadata only. */
export interface SessionView {
  readonly session_id: string;
  readonly agent: AgentName;
  readonly cwd: string;
  readonly branch?: string;
  readonly title?: string;
  readonly started_at: string;
  readonly last_active?: string;
}

export interface SessionAnswer extends AskResult {
  /** Where the fork ran. A follow-up through ask_agent must use the same directory. */
  readonly cwd: string;
  /** The live session the fork was made from. */
  readonly source: string;
}

export interface SessionsDeps {
  readonly self: () => Self;
  /** Read on every call, so turning sessions off or narrowing the scope applies without a restart. */
  readonly settings: () => Settings;
  readonly listLive: () => readonly SessionEntry[];
  readonly describe: (entry: SessionEntry) => SessionDetails;
  readonly askFork: (target: ForkTarget, question: string, effort: Effort | undefined, signal?: AbortSignal) => Promise<AskResult>;
}

function toView(entry: SessionEntry, details: SessionDetails): SessionView {
  return {
    session_id: entry.sessionId,
    agent: entry.agent,
    cwd: entry.cwd,
    ...(entry.branch ? { branch: entry.branch } : {}),
    ...(details.title ? { title: details.title } : {}),
    started_at: entry.startedAt,
    ...(details.lastActive ? { last_active: details.lastActive } : {}),
  };
}

export function createSessions(deps: SessionsDeps) {
  function visible(self: Self): readonly SessionEntry[] {
    const { sessions } = deps.settings();
    if (!sessions.enabled) throw new AdvisorError("live sessions are turned off; run `consult settings` to turn them on");
    return deps.listLive().filter((e) => e.sessionId !== self.sessionId && inScope(self, e, sessions.scope));
  }

  function list(): readonly SessionView[] {
    return visible(deps.self()).map((entry) => toView(entry, deps.describe(entry)));
  }

  async function ask(sessionId: string, question: string, effort: Effort | undefined, signal?: AbortSignal): Promise<SessionAnswer> {
    const self = deps.self();
    const target = visible(self).find((e) => e.sessionId === sessionId);
    if (!target) {
      throw new AdvisorError(
        sessionId === self.sessionId
          ? "that is your own session; ask a different one"
          : `no live session ${sessionId} in scope; call list_sessions to see the current ones`,
      );
    }
    const result = await deps.askFork({ agent: target.agent, sessionId: target.sessionId, cwd: target.cwd }, question, effort, signal);
    return { ...result, cwd: target.cwd, source: target.sessionId };
  }

  return { list, ask };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/sessions-service.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sessions/service.ts test/sessions-service.test.ts
git commit -m "feat: list and ask live sessions within the configured scope"
```

---

### Task 9: MCP tools `list_sessions` and `ask_session`

**Files:**
- Create: `src/session-tools.ts`
- Modify: `src/server.ts`
- Test: `test/session-tools.test.ts`

**Interfaces:**
- Consumes: `SessionView`, `SessionAnswer` (Task 8); `withProgress` from `src/progress.ts`.
- Produces:
  - `interface SessionToolDeps { list(): readonly SessionView[]; ask(sessionId: string, question: string, effort: Effort | undefined, signal?: AbortSignal): Promise<SessionAnswer> }`
  - `SESSIONS_INSTRUCTIONS: string`
  - `registerSessionTools(server: McpServer, deps: SessionToolDeps, progressIntervalMs: number): void`
  - `ServerDeps.sessions?: SessionToolDeps`

- [ ] **Step 1: Write the failing test**

`test/session-tools.test.ts`:

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { createServer } from "../src/server.js";
import type { SessionToolDeps } from "../src/session-tools.js";

async function connect(sessions?: SessionToolDeps) {
  const server = createServer({
    ask: vi.fn(),
    listAgents: vi.fn(),
    defaultCwd: "/repo",
    progressIntervalMs: 10,
    ...(sessions ? { sessions } : {}),
  });
  const client = new Client({ name: "test", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

const text = (res: unknown) => (res as { content: { type: string; text: string }[] }).content[0]!.text;
const view = { session_id: "s-2", agent: "codex" as const, cwd: "/work/api", branch: "feat", started_at: "2026-10-01T10:00:00.000Z" };

describe("session tools", () => {
  it("are absent, and not mentioned, when live sessions are off", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).not.toContain("list_sessions");
    expect(client.getInstructions()).not.toMatch(/list_sessions/);
  });

  it("are listed with all four hints and explained in the instructions when on", async () => {
    const client = await connect({ list: vi.fn(() => []), ask: vi.fn() });
    const { tools } = await client.listTools();
    const hints = Object.fromEntries(tools.map((t) => [t.name, t.annotations]));
    expect(hints.list_sessions).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false });
    expect(hints.ask_session).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true });
    expect(client.getInstructions()).toMatch(/ask_session/);
  });

  it("list_sessions returns the sessions, or says there are none", async () => {
    const list = vi.fn().mockReturnValueOnce([view]).mockReturnValueOnce([]);
    const client = await connect({ list, ask: vi.fn() });
    const first = await client.callTool({ name: "list_sessions", arguments: {} });
    expect(first.structuredContent).toEqual({ sessions: [view] });
    const second = await client.callTool({ name: "list_sessions", arguments: {} });
    expect(text(second)).toMatch(/no other live sessions/i);
  });

  it("list_sessions reports errors such as sessions being turned off", async () => {
    const list = vi.fn(() => {
      throw new Error("live sessions are turned off");
    });
    const client = await connect({ list, ask: vi.fn() });
    const res = await client.callTool({ name: "list_sessions", arguments: {} });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/turned off/);
  });

  it("ask_session forwards the question and returns the fork's session_id and cwd for follow-ups", async () => {
    const ask = vi.fn(async () => ({
      agent: "codex" as const,
      answer: "Renamed to fetchUser.",
      sessionId: "fork-1",
      durationMs: 1200,
      cwd: "/work/api",
      source: "s-2",
    }));
    const client = await connect({ list: vi.fn(() => []), ask });
    const res = await client.callTool({ name: "ask_session", arguments: { session_id: "s-2", question: "What did you rename?", effort: "low" } });
    expect(ask).toHaveBeenCalledWith("s-2", "What did you rename?", "low", expect.any(AbortSignal));
    expect(res.structuredContent).toEqual({
      agent: "codex",
      answer: "Renamed to fetchUser.",
      session_id: "fork-1",
      source_session_id: "s-2",
      cwd: "/work/api",
      duration_ms: 1200,
    });
    expect(text(res)).toContain("Renamed to fetchUser.");
    expect(text(res)).toMatch(/ask_agent.*session_id.*cwd/);
  });

  it("ask_session reports failures as tool errors", async () => {
    const ask = vi.fn(async () => {
      throw new Error("no live session s-9 in scope");
    });
    const client = await connect({ list: vi.fn(() => []), ask });
    const res = await client.callTool({ name: "ask_session", arguments: { session_id: "s-9", question: "q" } });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/no live session s-9/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/session-tools.test.ts`
Expected: FAIL, cannot load `../src/session-tools.js`.

- [ ] **Step 3: Implement**

`src/session-tools.ts`:

```ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { withProgress } from "./progress.js";
import type { SessionAnswer, SessionView } from "./sessions/service.js";
import { EFFORTS, type Effort } from "./types.js";

export interface SessionToolDeps {
  readonly list: () => readonly SessionView[];
  readonly ask: (sessionId: string, question: string, effort: Effort | undefined, signal?: AbortSignal) => Promise<SessionAnswer>;
}

export const SESSIONS_INSTRUCTIONS = `Live sessions are on. list_sessions shows other agent sessions running on this machine; ask_session asks a read-only copy of one of them, which knows that session's whole conversation.
Ask one when another agent has context you need: it wrote the code you are changing, or it works on the other side of an interface you share. The original session is not interrupted and never sees your question.`;

const LIST_DESCRIPTION = `List other AI coding agent sessions (Claude Code, Codex, Grok) running live on this machine that you can ask with ask_session: agent, session_id, directory, git branch, title, and when each started and was last active. Only sessions allowed by the user's live-sessions scope are shown.`;

const ASK_DESCRIPTION = `Ask a question of a live session from list_sessions. consult forks that session into a read-only copy, so the answer draws on everything the session has seen and done; the original keeps working and never sees your question.
The copy runs headless and cannot edit files or run commands. It replays the session's conversation, so it can take longer than ask_agent. The reply includes the copy's session_id and cwd: pass both, with the same agent, to ask_agent for a follow-up.`;

// Forks only read files; replies differ between calls and come from the session's model provider.
const FORK_HINTS = { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

function footer(result: SessionAnswer): string {
  return [
    `agent: ${result.agent}`,
    ...(result.model ? [`model: ${result.model}`] : []),
    `forked from: ${result.source}`,
    `session_id: ${result.sessionId}`,
    `cwd: ${result.cwd}`,
    `${(result.durationMs / 1000).toFixed(1)}s`,
  ].join(" · ");
}

export function registerSessionTools(server: McpServer, deps: SessionToolDeps, progressIntervalMs: number): void {
  server.registerTool(
    "list_sessions",
    {
      title: "List live sessions",
      description: LIST_DESCRIPTION,
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async () => {
      try {
        const sessions = deps.list();
        const body = sessions.length > 0 ? JSON.stringify(sessions, null, 2) : "No other live sessions in scope.";
        return { content: [{ type: "text", text: body }], structuredContent: { sessions } };
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: errorMessage(err) }] };
      }
    },
  );

  server.registerTool(
    "ask_session",
    {
      title: "Ask a live session",
      description: ASK_DESCRIPTION,
      inputSchema: {
        session_id: z.string().min(1).describe("session_id from list_sessions"),
        question: z
          .string()
          .min(1)
          .describe("The question. The copy knows its own session's conversation but not yours, so include what it needs to know about your side"),
        effort: z.enum(EFFORTS).optional().describe("Reasoning effort. Omit for the CLI's default"),
      },
      annotations: FORK_HINTS,
    },
    async (args, extra) => {
      try {
        const work = deps.ask(args.session_id, args.question, args.effort, extra.signal);
        const result = await withProgress(extra, progressIntervalMs, (s) => `asking a copy of ${args.session_id} (${s}s)`, work);
        return {
          content: [
            {
              type: "text",
              text: `${result.answer}\n\n---\n${footer(result)}\nFor a follow-up, call ask_agent with this agent, session_id and cwd.`,
            },
          ],
          structuredContent: {
            agent: result.agent,
            answer: result.answer,
            session_id: result.sessionId,
            source_session_id: result.source,
            cwd: result.cwd,
            ...(result.model ? { model: result.model } : {}),
            duration_ms: result.durationMs,
          },
        };
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: errorMessage(err) }] };
      }
    },
  );
}
```

In `src/server.ts`:

```ts
// add import
import { registerSessionTools, SESSIONS_INSTRUCTIONS, type SessionToolDeps } from "./session-tools.js";

// add to ServerDeps
  /** Present when live sessions are on: adds list_sessions and ask_session. */
  readonly sessions?: SessionToolDeps;

// createServer: destructure `sessions`, build instructions from it, register the tools before `return server`
export function createServer({
  ask,
  listAgents,
  defaultCwd,
  progressIntervalMs = DEFAULT_PROGRESS_INTERVAL_MS,
  sessions,
}: ServerDeps): McpServer {
  const instructions = sessions ? `${INSTRUCTIONS}\n${SESSIONS_INSTRUCTIONS}` : INSTRUCTIONS;
  const server = new McpServer({ name: "consult", version: VERSION }, { instructions });
  // ...existing ask_agent, ask_agents, list_agents registrations unchanged...
  if (sessions) registerSessionTools(server, sessions, progressIntervalMs);
  return server;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test && npx tsc --noEmit`
Expected: PASS, including the existing `test/server.test.ts` (the tool list and hints are unchanged without `sessions`).

- [ ] **Step 5: Commit**

```bash
git add src/session-tools.ts src/server.ts test/session-tools.test.ts
git commit -m "feat: list_sessions and ask_session MCP tools"
```

---

### Task 10: Register this server's live session

**Files:**
- Create: `src/sessions/live.ts`
- Test: `test/live-session.test.ts`

**Interfaces:**
- Consumes: `detectHost`, `currentSession`, `IdentityDeps` (Task 4); `writeEntry`, `removeEntry`, `SessionEntry` (Task 3); `repoKey`, `gitBranch` (Task 2); `Self` (Task 8).
- Produces:
  - `interface LiveOptions { run: Runner; dir: string; cwd: string; pid: number; identity: IdentityDeps; refreshMs: number; signal: AbortSignal; warn: (message: string) => void; now?: () => Date }`
  - `startLiveSession(opts: LiveOptions): Promise<{ self(): Self }>`

- [ ] **Step 1: Write the failing test**

`test/live-session.test.ts`:

```ts
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IdentityDeps } from "../src/sessions/identity.js";
import { startLiveSession, type LiveOptions } from "../src/sessions/live.js";
import type { Runner } from "../src/types.js";

const git: Runner = async (_cmd, args) => ({ stdout: args.includes("--git-common-dir") ? ".git\n" : "main\n", stderr: "", code: 0 });
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const rollout = (id: string) => `/home/u/.codex/sessions/2026/10/01/rollout-2026-10-01T10-00-00-${id}.jsonl`;
const codexHost = (files: () => readonly string[]): IdentityDeps => ({
  env: {},
  ancestors: async () => [{ pid: 77, name: "codex" }],
  openFiles: async () => files(),
  claudeTranscript: () => undefined,
});

function options(pid: number, identity: IdentityDeps, signal: AbortSignal): LiveOptions & { readonly root: string } {
  const root = mkdtempSync(join(tmpdir(), "consult-live-"));
  return { root, run: git, dir: join(root, "sessions"), cwd: root, pid, identity, refreshMs: 1000, signal, warn: vi.fn() };
}
const read = (dir: string, pid: number) => JSON.parse(readFileSync(join(dir, `${pid}.json`), "utf8"));

afterEach(() => {
  vi.useRealTimers();
});

describe("startLiveSession", () => {
  it("registers the host session with its repo, branch and transcript", async () => {
    const stop = new AbortController();
    const opts = options(4242, codexHost(() => [rollout(A)]), stop.signal);
    const live = await startLiveSession({ ...opts, now: () => new Date("2026-10-01T10:00:00.000Z") });
    expect(read(opts.dir, 4242)).toEqual({
      version: 1,
      pid: 4242,
      agent: "codex",
      sessionId: A,
      cwd: opts.root,
      repoKey: join(opts.root, ".git"),
      branch: "main",
      startedAt: "2026-10-01T10:00:00.000Z",
      transcriptPath: rollout(A),
    });
    expect(live.self()).toEqual({ repoKey: join(opts.root, ".git"), sessionId: A });
    stop.abort();
  });

  it("registers once codex opens its rollout, and follows /new to the new thread", async () => {
    vi.useFakeTimers();
    let files: readonly string[] = [];
    const stop = new AbortController();
    const opts = options(4243, codexHost(() => files), stop.signal);
    const live = await startLiveSession(opts);
    expect(existsSync(join(opts.dir, "4243.json"))).toBe(false);
    expect(live.self().sessionId).toBeUndefined();

    files = [rollout(A)];
    await vi.advanceTimersByTimeAsync(1000);
    expect(read(opts.dir, 4243).sessionId).toBe(A);

    files = [rollout(B)];
    await vi.advanceTimersByTimeAsync(1000);
    expect(read(opts.dir, 4243).sessionId).toBe(B);
    expect(live.self().sessionId).toBe(B);
    stop.abort();
  });

  it("does not register when no agent CLI started the server", async () => {
    const stop = new AbortController();
    const identity: IdentityDeps = { env: {}, ancestors: async () => [{ pid: 9, name: "zsh" }], openFiles: async () => [], claudeTranscript: () => undefined };
    const opts = options(4244, identity, stop.signal);
    const live = await startLiveSession(opts);
    expect(existsSync(join(opts.dir, "4244.json"))).toBe(false);
    expect(live.self()).toEqual({ repoKey: join(opts.root, ".git") });
    stop.abort();
  });

  it("removes its entry and stops refreshing on shutdown", async () => {
    vi.useFakeTimers();
    const openFiles = vi.fn(async () => [rollout(A)]);
    const stop = new AbortController();
    const opts = options(4245, { ...codexHost(() => []), openFiles }, stop.signal);
    await startLiveSession(opts);
    expect(existsSync(join(opts.dir, "4245.json"))).toBe(true);
    stop.abort();
    expect(existsSync(join(opts.dir, "4245.json"))).toBe(false);
    const calls = openFiles.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(openFiles.mock.calls.length).toBe(calls);
  });

  it("warns instead of crashing when the registry cannot be written", async () => {
    const stop = new AbortController();
    const opts = options(4246, codexHost(() => [rollout(A)]), stop.signal);
    await startLiveSession({ ...opts, dir: "/dev/null/sessions" });
    expect(opts.warn).toHaveBeenCalledWith(expect.stringMatching(/could not register this session/));
    stop.abort();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/live-session.test.ts`
Expected: FAIL, cannot load `../src/sessions/live.js`.

- [ ] **Step 3: Implement**

`src/sessions/live.ts`:

```ts
import type { Runner } from "../types.js";
import { currentSession, detectHost, type IdentityDeps } from "./identity.js";
import { removeEntry, writeEntry, type SessionEntry } from "./registry.js";
import { gitBranch, repoKey } from "./scope.js";
import type { Self } from "./service.js";

export interface LiveOptions {
  readonly run: Runner;
  readonly dir: string;
  readonly cwd: string;
  /** This server's pid, which names its registry file. */
  readonly pid: number;
  readonly identity: IdentityDeps;
  readonly refreshMs: number;
  readonly signal: AbortSignal;
  readonly warn: (message: string) => void;
  readonly now?: () => Date;
}

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Registers the host session this server runs in, so other sessions can find it, and keeps the entry current:
 * codex opens its rollout only after the first turn, `/new` starts a new thread, and the branch can change.
 * The entry is removed when `signal` aborts. Readers prune the entries of servers that crash.
 */
export async function startLiveSession(opts: LiveOptions): Promise<{ readonly self: () => Self }> {
  const key = await repoKey(opts.run, opts.cwd);
  const startedAt = (opts.now ?? (() => new Date()))().toISOString();
  const host = await detectHost(opts.identity);
  let written: SessionEntry | undefined;

  async function refresh(): Promise<void> {
    if (!host || opts.signal.aborted) return;
    const [identity, branch] = await Promise.all([
      currentSession(host, opts.identity).catch(() => undefined),
      gitBranch(opts.run, opts.cwd),
    ]);
    if (!identity || opts.signal.aborted) return;
    const entry: SessionEntry = {
      version: 1,
      pid: opts.pid,
      agent: host.agent,
      sessionId: identity.sessionId,
      cwd: opts.cwd,
      repoKey: key,
      startedAt,
      ...(branch ? { branch } : {}),
      ...(identity.transcriptPath ? { transcriptPath: identity.transcriptPath } : {}),
    };
    if (written && JSON.stringify(written) === JSON.stringify(entry)) return;
    writeEntry(opts.dir, entry);
    written = entry;
  }

  const safeRefresh = () => refresh().catch((err) => opts.warn(`could not register this session: ${errorMessage(err)}`));
  await safeRefresh();
  const timer = setInterval(() => void safeRefresh(), opts.refreshMs);
  timer.unref();
  opts.signal.addEventListener(
    "abort",
    () => {
      clearInterval(timer);
      removeEntry(opts.dir, opts.pid);
    },
    { once: true },
  );
  return { self: () => ({ repoKey: key, ...(written ? { sessionId: written.sessionId } : {}) }) };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/live-session.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sessions/live.ts test/live-session.test.ts
git commit -m "feat: register the running session and keep its entry current"
```

---

### Task 11: Wire live sessions into `consult serve`

**Files:**
- Create: `src/sessions/wire.ts`
- Modify: `src/cli.ts` (`serve`)
- Test: `test/sessions-wire.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1-10.
- Produces:
  - `interface WireOptions { run: Runner; env: NodeJS.ProcessEnv; cwd: string; pid: number; signal: AbortSignal; askFork: SessionsDeps["askFork"]; warn(message: string): void; identity?: IdentityDeps; refreshMs?: number }`
  - `sessionTools(opts: WireOptions): Promise<SessionToolDeps | undefined>`

- [ ] **Step 1: Write the failing test**

`test/sessions-wire.test.ts`:

```ts
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, saveSettings, settingsPath, withSessionsMode, type SessionsMode } from "../src/settings.js";
import type { IdentityDeps } from "../src/sessions/identity.js";
import { sessionTools, type WireOptions } from "../src/sessions/wire.js";
import type { Runner } from "../src/types.js";

const noGit: Runner = async () => ({ stdout: "", stderr: "not a git repository", code: 128 });
const claudeIn = (sessionId: string): IdentityDeps => ({
  env: { CLAUDE_CODE_SESSION_ID: sessionId },
  ancestors: async () => [{ pid: 2, name: "claude" }],
  openFiles: async () => [],
  claudeTranscript: () => undefined,
});

function setup(mode: SessionsMode | "corrupt" | "missing") {
  const root = mkdtempSync(join(tmpdir(), "consult-wire-"));
  const env = { XDG_CONFIG_HOME: join(root, "config"), XDG_STATE_HOME: join(root, "state"), CODEX_HOME: join(root, "codex") };
  if (mode === "corrupt") {
    mkdirSync(dirname(settingsPath(env)), { recursive: true });
    writeFileSync(settingsPath(env), "{ broken");
  } else if (mode !== "missing") {
    saveSettings(settingsPath(env), withSessionsMode(DEFAULT_SETTINGS, mode));
  }
  return { root, env };
}

const options = (env: NodeJS.ProcessEnv, cwd: string, overrides: Partial<WireOptions> = {}): WireOptions => ({
  run: noGit,
  env,
  cwd,
  pid: process.pid,
  signal: new AbortController().signal,
  refreshMs: 60_000,
  askFork: vi.fn(),
  warn: vi.fn(),
  identity: claudeIn("me"),
  ...overrides,
});

describe("sessionTools (serve wiring)", () => {
  it("adds nothing when live sessions are off or were never configured", async () => {
    for (const mode of ["off", "missing"] as const) {
      const { root, env } = setup(mode);
      expect(await sessionTools(options(env, root))).toBeUndefined();
    }
  });

  it("warns and keeps consult running with sessions off when the settings file is corrupt", async () => {
    const { root, env } = setup("corrupt");
    const warn = vi.fn();
    expect(await sessionTools(options(env, root, { warn }))).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/live sessions are off/));
  });

  it("lets two sessions in one repo find and ask each other", async () => {
    const { root, env } = setup("repo");
    const stopA = new AbortController();
    const stopB = new AbortController();
    const askFork = vi.fn(async () => ({ agent: "claude" as const, answer: "ok", sessionId: "fork", durationMs: 1 }));
    // Both pids are alive, so the registry keeps both entries.
    const a = await sessionTools(options(env, root, { pid: process.pid, signal: stopA.signal, identity: claudeIn("session-a") }));
    const b = await sessionTools(options(env, root, { pid: process.ppid, signal: stopB.signal, identity: claudeIn("session-b"), askFork }));
    expect(a!.list().map((s) => s.session_id)).toEqual(["session-b"]);
    expect(b!.list().map((s) => s.session_id)).toEqual(["session-a"]);

    await b!.ask("session-a", "What are you working on?", undefined);
    expect(askFork).toHaveBeenCalledWith({ agent: "claude", sessionId: "session-a", cwd: root }, "What are you working on?", undefined, undefined);

    stopA.abort();
    expect(b!.list()).toEqual([]);
    stopB.abort();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/sessions-wire.test.ts`
Expected: FAIL, cannot load `../src/sessions/wire.js`.

- [ ] **Step 3: Implement**

`src/sessions/wire.ts`:

```ts
import type { SessionToolDeps } from "../session-tools.js";
import { loadSettings, settingsPath, type Settings } from "../settings.js";
import type { Runner } from "../types.js";
import { codexIndexPath, describeSession } from "./describe.js";
import { systemIdentityDeps, type IdentityDeps } from "./identity.js";
import { startLiveSession } from "./live.js";
import { listLive, registryDir } from "./registry.js";
import { createSessions, type SessionsDeps } from "./service.js";

const REFRESH_MS = 15_000;

export interface WireOptions {
  readonly run: Runner;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly pid: number;
  readonly signal: AbortSignal;
  readonly askFork: SessionsDeps["askFork"];
  readonly warn: (message: string) => void;
  readonly identity?: IdentityDeps;
  readonly refreshMs?: number;
}

/**
 * For `consult serve`: registers this session and returns the session tools when live sessions are on.
 * Without valid settings it returns nothing, so the rest of consult works as before.
 */
export async function sessionTools(opts: WireOptions): Promise<SessionToolDeps | undefined> {
  const path = settingsPath(opts.env);
  let settings: Settings;
  try {
    settings = loadSettings(path);
  } catch (err) {
    opts.warn(`${err instanceof Error ? err.message : String(err)}; live sessions are off for this session`);
    return undefined;
  }
  if (!settings.sessions.enabled) return undefined;

  const dir = registryDir(opts.env);
  const codexIndex = codexIndexPath(opts.env);
  const live = await startLiveSession({
    run: opts.run,
    dir,
    cwd: opts.cwd,
    pid: opts.pid,
    identity: opts.identity ?? systemIdentityDeps(opts.run, opts.env),
    refreshMs: opts.refreshMs ?? REFRESH_MS,
    signal: opts.signal,
    warn: opts.warn,
  });
  const { list, ask } = createSessions({
    self: live.self,
    settings: () => loadSettings(path),
    listLive: () => listLive(dir),
    describe: (entry) => describeSession(entry, codexIndex),
    askFork: opts.askFork,
  });
  return { list, ask };
}
```

In `src/cli.ts`, add `import { sessionTools } from "./sessions/wire.js";` and replace `serve()` up to the signal handlers:

```ts
async function serve(): Promise<void> {
  const shutdown = new AbortController();
  const withShutdown = (signal?: AbortSignal) => (signal ? AbortSignal.any([signal, shutdown.signal]) : shutdown.signal);
  const { ask, askSession } = consult();
  const sessions = await sessionTools({
    run,
    env: process.env,
    cwd: process.cwd(),
    pid: process.pid,
    signal: shutdown.signal,
    askFork: (target, question, effort, signal) => askSession(target, question, effort, withShutdown(signal)),
    warn: (message) => process.stderr.write(`consult: ${message}\n`),
  });
  const server = createServer({
    ask: (request, signal) => ask(request, withShutdown(signal)),
    listAgents: () => listAgents(run),
    defaultCwd: process.cwd(),
    ...(sessions ? { sessions } : {}),
  });
  // ...transport, stdin "end" and signal handlers unchanged...
```

- [ ] **Step 4: Run the tests and a startup smoke test**

Run: `npm test && npx tsc --noEmit && npm run build`
Expected: PASS, build succeeds.

Then confirm that with sessions off (no settings file) the server still lists exactly the three tools:

```bash
XDG_CONFIG_HOME="$(mktemp -d)" node -e '
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");
(async () => {
  const c = new Client({ name: "smoke", version: "0" });
  await c.connect(new StdioClientTransport({ command: process.execPath, args: ["dist/cli.js", "serve"], env: process.env }));
  console.log((await c.listTools()).tools.map((t) => t.name).sort().join(","));
  await c.close();
})();'
```

Expected: `ask_agent,ask_agents,list_agents`.

- [ ] **Step 5: Commit**

```bash
git add src/sessions/wire.ts src/cli.ts test/sessions-wire.test.ts
git commit -m "feat: consult serve registers live sessions when they are on"
```

---

### Task 12: Detect where consult is registered

**Files:**
- Modify: `src/codex-config.ts`, `src/install.ts`
- Test: `test/install.test.ts` (append)

**Interfaces:**
- Produces:
  - `isCodexRegistered(path: string): boolean` (in `codex-config.ts`, re-exported from `install.ts`)
  - `isRegistered(run: Runner, agent: AgentName, codexPath?: string): Promise<boolean>`

Verified on 2026-10-01: `claude mcp get consult` exits 0 when registered and 1 when not; `grok mcp list` prints lines like `  consult: <command>`.

- [ ] **Step 1: Write the failing test**

Append to `test/install.test.ts` (add `isRegistered` to the import from `../src/install.js`):

```ts
describe("isRegistered", () => {
  it("asks claude and grok, and reads codex's config", async () => {
    const run = vi.fn<Runner>(async (cmd) =>
      cmd === "claude"
        ? { stdout: "", stderr: "", code: 0 }
        : { stdout: "  github: https://x\n  consult: /bin/npx -y consult-mcp@latest serve\n", stderr: "", code: 0 },
    );
    expect(await isRegistered(run, "claude")).toBe(true);
    expect(run).toHaveBeenCalledWith("claude", ["mcp", "get", "consult"], expect.anything());
    expect(await isRegistered(run, "grok")).toBe(true);
    const config = tmpConfig();
    expect(await isRegistered(run, "codex", config)).toBe(false);
    registerCodex(local, config);
    expect(await isRegistered(run, "codex", config)).toBe(true);
  });

  it("is false when claude has no consult server or grok lists only similar names", async () => {
    const run = vi.fn<Runner>(async (cmd) =>
      cmd === "claude"
        ? { stdout: "", stderr: "No MCP server found", code: 1 }
        : { stdout: "  consult-old: /bin/x\n  my-consult: /bin/y\n", stderr: "", code: 0 },
    );
    expect(await isRegistered(run, "claude")).toBe(false);
    expect(await isRegistered(run, "grok")).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/install.test.ts`
Expected: FAIL, `isRegistered` is not exported.

- [ ] **Step 3: Implement**

Append to `src/codex-config.ts`:

```ts
/** Whether the codex config has a consult entry. A missing file means not registered. */
export function isCodexRegistered(path: string): boolean {
  return existsSync(path) && hasConsult(parseConfig(readFileSync(path, "utf8"), path));
}
```

In `src/install.ts`, change the codex-config import and re-export, then add `isRegistered` after `unregisterFromCli`:

```ts
import { codexConfigPath, editConfig, isCodexRegistered } from "./codex-config.js";
// ...
export { codexConfigPath, isCodexRegistered, removeTomlTable } from "./codex-config.js";

// after unregisterFromCli:
const GROK_ENTRY = new RegExp(`^\\s*${SERVER_NAME}:`, "m");

/** Whether consult is currently registered with this CLI. */
export async function isRegistered(run: Runner, agent: AgentName, codexPath: string = codexConfigPath()): Promise<boolean> {
  switch (agent) {
    case "claude":
      return (await run("claude", ["mcp", "get", SERVER_NAME], CLI_OPTS)).code === 0;
    case "grok": {
      const res = await run("grok", ["mcp", "list"], CLI_OPTS);
      return res.code === 0 && GROK_ENTRY.test(res.stdout);
    }
    case "codex":
      return isCodexRegistered(codexPath);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/install.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/codex-config.ts src/install.ts test/install.test.ts
git commit -m "feat: detect which agent CLIs consult is registered with"
```

---

### Task 13: `consult settings` TUI and `install --sessions`

**Files:**
- Modify: `package.json`, `package-lock.json` (add `@clack/prompts`)
- Create: `src/tui.ts`
- Modify: `src/cli.ts` (`install`, `settings`, `USAGE`)
- Test: `test/tui.test.ts`

**Interfaces:**
- Consumes: settings helpers (Task 1); `isRegistered` (Task 12); `install`, `uninstall`, `InstallResult` from `src/install.ts`.
- Produces:
  - `parseSessionsFlag(value: string | undefined): SessionsMode | undefined`
  - `isInteractive(stdin?, stdout?): boolean`
  - `chooseInstallMode(opts: { flag?: SessionsMode; current: SessionsMode; interactive: boolean; prompt(current: SessionsMode): Promise<SessionsMode | undefined> }): Promise<SessionsMode | undefined>`
  - `planSettings(current: Settings, registered: readonly AgentName[], chosen: { mode: SessionsMode; hosts: readonly AgentName[] }): SettingsPlan`
  - `promptSessionsMode(current: SessionsMode): Promise<SessionsMode | undefined>`
  - `runSettings(io: SettingsIo): Promise<void>`

`@clack/prompts` 1.8.1 API (checked against its README): `intro`, `outro`, `cancel`, `isCancel`, `select({ message, options, initialValue })`, `multiselect({ message, options, initialValues, required })`, `confirm({ message, initialValue })`, `log.success/error/warn`.

- [ ] **Step 1: Add the dependency**

Run: `npm install @clack/prompts@^1.8.1`
Expected: `package.json` dependencies gain `"@clack/prompts": "^1.8.1"`, and the lockfile updates.

- [ ] **Step 2: Write the failing test**

`test/tui.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, withSessionsMode } from "../src/settings.js";
import { chooseInstallMode, parseSessionsFlag, planSettings } from "../src/tui.js";

describe("parseSessionsFlag", () => {
  it("accepts off, repo and machine, and is undefined when absent", () => {
    expect(parseSessionsFlag("off")).toBe("off");
    expect(parseSessionsFlag("repo")).toBe("repo");
    expect(parseSessionsFlag("machine")).toBe("machine");
    expect(parseSessionsFlag(undefined)).toBeUndefined();
  });

  it("rejects anything else and lists the allowed values", () => {
    expect(() => parseSessionsFlag("all")).toThrow(/off, repo, machine/);
  });
});

describe("chooseInstallMode", () => {
  it("uses the flag without prompting", async () => {
    const prompt = vi.fn();
    expect(await chooseInstallMode({ flag: "machine", current: "off", interactive: true, prompt })).toBe("machine");
    expect(prompt).not.toHaveBeenCalled();
  });

  it("never prompts without a terminal, leaving the setting as it is", async () => {
    const prompt = vi.fn();
    expect(await chooseInstallMode({ current: "repo", interactive: false, prompt })).toBeUndefined();
    expect(prompt).not.toHaveBeenCalled();
  });

  it("asks in a terminal, starting from the current mode", async () => {
    const prompt = vi.fn(async () => "repo" as const);
    expect(await chooseInstallMode({ current: "off", interactive: true, prompt })).toBe("repo");
    expect(prompt).toHaveBeenCalledWith("off");
  });
});

describe("planSettings", () => {
  it("applies the mode and registers or removes only the hosts that changed", () => {
    const plan = planSettings(DEFAULT_SETTINGS, ["claude", "codex"], { mode: "repo", hosts: ["codex", "grok"] });
    expect(plan.settings).toEqual(withSessionsMode(DEFAULT_SETTINGS, "repo"));
    expect(plan.register).toEqual(["grok"]);
    expect(plan.unregister).toEqual(["claude"]);
  });

  it("changes nothing when nothing changed", () => {
    expect(planSettings(DEFAULT_SETTINGS, ["claude"], { mode: "off", hosts: ["claude"] })).toEqual({
      settings: DEFAULT_SETTINGS,
      register: [],
      unregister: [],
    });
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run test/tui.test.ts`
Expected: FAIL, cannot load `../src/tui.js`.

- [ ] **Step 4: Implement**

`src/tui.ts`:

```ts
import { cancel, confirm, intro, isCancel, log, multiselect, outro, select } from "@clack/prompts";
import type { InstallResult } from "./install.js";
import {
  DEFAULT_SETTINGS,
  SESSIONS_MODES,
  sessionsMode,
  withSessionsMode,
  type SessionsMode,
  type Settings,
} from "./settings.js";
import type { AgentName } from "./types.js";

const MODE_OPTIONS = [
  { value: "off", label: "Off", hint: "default: agents can't see each other's sessions" },
  { value: "repo", label: "Same repo", hint: "sessions in the same git repository and its worktrees" },
  { value: "machine", label: "Whole machine", hint: "every consult session you run" },
] as const;

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function parseSessionsFlag(value: string | undefined): SessionsMode | undefined {
  if (value === undefined) return undefined;
  if (!(SESSIONS_MODES as readonly string[]).includes(value)) {
    throw new Error(`--sessions must be one of ${SESSIONS_MODES.join(", ")}`);
  }
  return value as SessionsMode;
}

export const isInteractive = (stdin: { isTTY?: boolean } = process.stdin, stdout: { isTTY?: boolean } = process.stdout) =>
  Boolean(stdin.isTTY && stdout.isTTY);

/** The flag wins; otherwise ask, but only in a terminal. Undefined means leave the setting as it is. */
export async function chooseInstallMode(opts: {
  readonly flag?: SessionsMode;
  readonly current: SessionsMode;
  readonly interactive: boolean;
  readonly prompt: (current: SessionsMode) => Promise<SessionsMode | undefined>;
}): Promise<SessionsMode | undefined> {
  if (opts.flag) return opts.flag;
  return opts.interactive ? opts.prompt(opts.current) : undefined;
}

export interface SettingsPlan {
  readonly settings: Settings;
  readonly register: readonly AgentName[];
  readonly unregister: readonly AgentName[];
}

export function planSettings(
  current: Settings,
  registered: readonly AgentName[],
  chosen: { readonly mode: SessionsMode; readonly hosts: readonly AgentName[] },
): SettingsPlan {
  return {
    settings: withSessionsMode(current, chosen.mode),
    register: chosen.hosts.filter((agent) => !registered.includes(agent)),
    unregister: registered.filter((agent) => !chosen.hosts.includes(agent)),
  };
}

/** Asks for the live-sessions mode. Undefined when the user cancels. */
export async function promptSessionsMode(current: SessionsMode): Promise<SessionsMode | undefined> {
  const mode = await select({
    message: "Live sessions: let agents see and ask each other's running sessions?",
    options: [...MODE_OPTIONS],
    initialValue: current,
  });
  return isCancel(mode) ? undefined : mode;
}

export interface SettingsIo {
  /** Throws SettingsError when the file is invalid. */
  readonly load: () => Settings;
  readonly save: (settings: Settings) => void;
  readonly installed: readonly AgentName[];
  readonly isRegistered: (agent: AgentName) => Promise<boolean>;
  readonly register: (agents: readonly AgentName[]) => Promise<readonly InstallResult[]>;
  readonly unregister: (agents: readonly AgentName[]) => Promise<readonly InstallResult[]>;
}

async function loadOrReset(io: SettingsIo): Promise<Settings | undefined> {
  try {
    return io.load();
  } catch (err) {
    log.warn(errorMessage(err));
    const reset = await confirm({ message: "Reset settings to the defaults?", initialValue: true });
    return !isCancel(reset) && reset ? DEFAULT_SETTINGS : undefined;
  }
}

export async function runSettings(io: SettingsIo): Promise<void> {
  intro("consult settings");
  const current = await loadOrReset(io);
  if (!current) return cancel("Left settings unchanged.");
  const registered = (await Promise.all(io.installed.map(async (agent) => ((await io.isRegistered(agent)) ? [agent] : [])))).flat();

  const mode = await promptSessionsMode(sessionsMode(current));
  if (mode === undefined) return cancel("No changes made.");
  const hosts =
    io.installed.length === 0
      ? []
      : await multiselect({
          message: "Use consult in",
          options: io.installed.map((agent) => ({ value: agent, label: agent })),
          initialValues: [...registered],
          required: false,
        });
  if (isCancel(hosts)) return cancel("No changes made.");

  const plan = planSettings(current, registered, { mode, hosts });
  io.save(plan.settings);
  const changed = [...plan.register, ...plan.unregister];
  const results = [
    ...(plan.register.length > 0 ? await io.register(plan.register) : []),
    ...(plan.unregister.length > 0 ? await io.unregister(plan.unregister) : []),
  ].filter((r) => changed.includes(r.agent));
  for (const r of results) (r.ok ? log.success : log.error)(r.message);
  outro(`Live sessions: ${mode}. Restart running agent sessions to apply.`);
}
```

In `src/cli.ts`:

1. Imports:

```ts
import { findOnPath, install, isRegistered, serverCommand, uninstall, type InstallResult } from "./install.js";
import { DEFAULT_SETTINGS, loadSettings, saveSettings, sessionsMode, settingsPath, withSessionsMode, type SessionsMode } from "./settings.js";
import { chooseInstallMode, isInteractive, parseSessionsFlag, promptSessionsMode, runSettings } from "./tui.js";
```

2. `USAGE` lines for install and settings:

```ts
  consult install [--sessions off|repo|machine]
                                         register the MCP server with claude, codex and grok
  consult uninstall                      remove it from all three
  consult settings                       live sessions, and which agents use consult (interactive)
```

3. Helpers (next to `installedAgents`):

```ts
const scriptPath = () => realpathSync(fileURLToPath(import.meta.url));
const searchPath = () => process.env.PATH ?? "";
const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Applies --sessions, or asks in a terminal. With neither, the setting stays as it is. */
async function configureSessions(flag: SessionsMode | undefined): Promise<void> {
  const path = settingsPath();
  let current = DEFAULT_SETTINGS;
  try {
    current = loadSettings(path);
  } catch (err) {
    if (!flag) {
      process.stderr.write(`consult: ${errorMessage(err)}\n`);
      return;
    }
  }
  const mode = await chooseInstallMode({ flag, current: sessionsMode(current), interactive: isInteractive(), prompt: promptSessionsMode });
  if (mode !== undefined) saveSettings(path, withSessionsMode(current, mode));
  process.stdout.write(`Live sessions: ${mode ?? sessionsMode(current)} (change with \`consult settings\`)\n`);
}
```

4. `main` cases for `install` and `settings`:

```ts
    case "install": {
      const { values } = parseArgs({ args: rest, options: { sessions: { type: "string" } } });
      const flag = parseSessionsFlag(values.sessions);
      if (report(await install(run, serverCommand(scriptPath(), searchPath()), installedAgents()))) {
        await configureSessions(flag);
        process.stdout.write("Restart running agent sessions to pick up the new tools.\n");
      }
      return;
    }
    case "settings": {
      if (!isInteractive()) {
        throw new Error("consult settings needs an interactive terminal; in scripts use `consult install --sessions=off|repo|machine`");
      }
      const cmd = serverCommand(scriptPath(), searchPath());
      const path = settingsPath();
      await runSettings({
        load: () => loadSettings(path),
        save: (settings) => saveSettings(path, settings),
        installed: installedAgents(),
        isRegistered: (agent) => isRegistered(run, agent),
        register: (agents) => install(run, cmd, agents),
        unregister: (agents) => uninstall(run, agents),
      });
      return;
    }
```

The `main` catch handler can now use `errorMessage(err)`; leave it as it is unless the duplication bothers the reviewer.

- [ ] **Step 5: Run the tests and check the CLI by hand**

Run: `npm test && npx tsc --noEmit && npm run build`
Expected: PASS.

Then check (none of these touch your real settings or registrations):

```bash
node dist/cli.js install --sessions=all; echo "exit=$?"     # consult: --sessions must be one of off, repo, machine / exit=1, nothing registered
node dist/cli.js settings < /dev/null; echo "exit=$?"       # consult settings needs an interactive terminal... / exit=1
```

For the interactive TUI, run in a real terminal with a scratch config, choose "Same repo", and leave the hosts as they are:

```bash
XDG_CONFIG_HOME="$(mktemp -d)" sh -c 'node dist/cli.js settings && cat "$XDG_CONFIG_HOME/consult/settings.json"'
```

Expected: the file shows `"enabled": true, "scope": "repo"`, and no host registration lines appear (nothing changed).

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/tui.ts src/cli.ts test/tui.test.ts
git commit -m "feat: consult settings TUI and install --sessions"
```

---

### Task 14: Live tests for forks and live sessions

**Files:**
- Modify: `test/live.test.ts`

**Interfaces:**
- Consumes: `createConsult(...).askSession`, adapters, `run`, settings helpers, `systemIdentityDeps`.

These tests use real CLIs and real subscriptions. They are opt-in (`npm run build && npm run test:live`). Run them from a plain terminal or from Claude Code: inside Codex or Grok the test servers would detect that CLI as their host.

- [ ] **Step 1: Add the tests**

Add to the imports of `test/live.test.ts`:

```ts
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { claude } from "../src/adapters/claude.js";
import { codex } from "../src/adapters/codex.js";
import { grok } from "../src/adapters/grok.js";
import { createConsult } from "../src/consult.js";
import { run } from "../src/run.js";
import { DEFAULT_SETTINGS, saveSettings, settingsPath, withSessionsMode } from "../src/settings.js";
import { systemIdentityDeps } from "../src/sessions/identity.js";
import type { AgentName } from "../src/types.js";
```

Append:

```ts
const adapters = { claude, codex, grok };
const CODEWORD = "PAPAYA-42";
const REMEMBER = `Remember this codeword for later: ${CODEWORD}. Reply with only OK.`;
const PROBE =
  "What codeword were you given earlier in this session? Reply with it. Then try to create a file named pwned.txt in your working directory containing x, and say whether that worked.";

// The source session gets write access, as a user's own session would, to show that a fork does not inherit it.
const WRITABLE_SOURCE: Record<AgentName, (prompt: string, extra: readonly string[]) => readonly string[]> = {
  claude: (p) => ["-p", "--output-format", "json", "--permission-mode", "acceptEdits", "--strict-mcp-config", "--model", "haiku", p],
  codex: (p, extra) => ["exec", "--json", "--skip-git-repo-check", "-c", 'sandbox_mode="workspace-write"', ...extra, p],
  grok: (p) => ["--single", p, "--output-format", "streaming-messages-json", "--disallowed-tools", "search_tool,use_tool"],
};

function transcriptOf(agent: AgentName, sessionId: string): string | undefined {
  if (agent === "claude") return systemIdentityDeps(run).claudeTranscript(sessionId);
  if (agent === "codex") {
    const root = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "sessions");
    const name = readdirSync(root, { recursive: true, encoding: "utf8" }).find((f) => f.endsWith(`-${sessionId}.jsonl`));
    return name ? join(root, name) : undefined;
  }
  return undefined;
}

describe.skipIf(!live)("live session forks", () => {
  it.each(AGENTS)("%s fork knows the source conversation, cannot write, and leaves the source untouched", { timeout: 600_000 }, async (agent) => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "consult-fork-")));
    const extra = agent === "codex" ? await codex.prepare!(run, dir) : [];
    const started = await run(agent, WRITABLE_SOURCE[agent](REMEMBER, extra), { cwd: dir, timeoutMs: 600_000 });
    expect(started.code, started.stderr).toBe(0);
    const source = adapters[agent].parse(started.stdout).sessionId;
    const transcript = transcriptOf(agent, source);
    const before = transcript ? readFileSync(transcript, "utf8") : undefined;

    const fork = await createConsult({ run, adapters, timeoutMs: 600_000 }).askSession({ agent, sessionId: source, cwd: dir }, PROBE);

    expect(fork.answer).toContain(CODEWORD);
    expect(fork.sessionId).not.toBe(source);
    expect(existsSync(join(dir, "pwned.txt"))).toBe(false);
    if (transcript) expect(readFileSync(transcript, "utf8")).toBe(before);
  });
});

describe.skipIf(!live)("live sessions over MCP", () => {
  it("one claude session lists another and asks a copy of it", { timeout: 600_000 }, async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "consult-e2e-")));
    const started = await run("claude", ["-p", "--output-format", "json", "--strict-mcp-config", "--model", "haiku", REMEMBER], {
      cwd: dir,
      timeoutMs: 600_000,
    });
    const source = claude.parse(started.stdout).sessionId;
    const env = { ...process.env, XDG_CONFIG_HOME: join(dir, ".config"), XDG_STATE_HOME: join(dir, ".state") } as Record<string, string>;
    saveSettings(settingsPath(env), withSessionsMode(DEFAULT_SETTINGS, "repo"));
    const serve = (sessionId: string) =>
      new StdioClientTransport({
        command: process.execPath,
        args: [join(root, "dist", "cli.js"), "serve"],
        cwd: dir,
        env: { ...env, CLAUDE_CODE_SESSION_ID: sessionId },
      });

    const owner = new Client({ name: "owner", version: "0" });
    const asker = new Client({ name: "asker", version: "0" });
    await owner.connect(serve(source));
    await asker.connect(serve(randomUUID()));
    try {
      const listed = await asker.callTool({ name: "list_sessions", arguments: {} });
      const { sessions } = listed.structuredContent as { sessions: { session_id: string }[] };
      expect(sessions.map((s) => s.session_id)).toContain(source);

      const res = await asker.callTool(
        { name: "ask_session", arguments: { session_id: source, question: "What codeword were you given earlier in this session? Reply with only the codeword." } },
        undefined,
        { timeout: 600_000 },
      );
      expect(res.isError, JSON.stringify(res.content)).toBeFalsy();
      expect((res.structuredContent as { answer: string }).answer).toContain(CODEWORD);
    } finally {
      await asker.close();
      await owner.close();
    }
  });
});
```

- [ ] **Step 2: Check that the default suite skips them**

Run: `npm test`
Expected: PASS; the live suites are reported as skipped.

- [ ] **Step 3: Run them live**

Run: `npm run build && npm run test:live`
Expected: all live tests PASS. If a fork test fails on `pwned.txt` existing, **stop**: that means a containment break. Do not weaken the test; report it and fix the adapter's `fork` flags first. A failure on the transcript comparison means the CLI writes to the source session when forking; report that too, since the spec promises the source is only read.

- [ ] **Step 4: Commit**

```bash
git add test/live.test.ts
git commit -m "test: live checks that session forks are contained and know the source"
```

---

### Task 15: Documentation

**Files:**
- Modify: `README.md`, `SECURITY.md`
- Modify (if tracked: `git ls-files --error-unmatch AGENTS.md CLAUDE.md`): `AGENTS.md`, `CLAUDE.md`

- [ ] **Step 1: README: tools**

In `## Tools`, after the `list_agents` paragraph, add:

```markdown
**`list_sessions`** and **`ask_session`** `{session_id, question, effort?}` appear when [live sessions](#live-sessions) are on.
```

- [ ] **Step 2: README: new section**

Add after `## When agents consult`:

~~~markdown
## Live sessions

Off by default. When on, agents can ask the agent sessions you already have running, not only fresh advisors. For example, the Codex session working on your API can ask the Claude Code session that wrote the client what it changed.

- **`list_sessions`** lists other live sessions: agent, session id, directory, git branch, title, and when each started and was last active. Nothing else from their conversations.
- **`ask_session`** `{session_id, question, effort?}` asks a read-only **copy** of that session. consult forks it (`claude --resume <id> --fork-session`, `codex exec fork <id>`, `grok --resume <id> --fork-session`) with the same containment as any advisor. The copy knows everything the session has seen, while the session itself is not interrupted and never sees the question. Pass the reply's `session_id` and `cwd` to `ask_agent` for follow-ups.

Turn it on when you install, or later:

```bash
npx -y consult-mcp@latest install --sessions=repo   # or off, machine; without the flag, install asks when run in a terminal
npx -y consult-mcp@latest settings                  # interactive: live sessions, and which agents use consult
```

| Setting | Who can see and ask whom |
| --- | --- |
| `off` (default) | Nobody. The tools don't appear. |
| `repo` | Sessions in the same git repository, including its worktrees (outside git: the same directory) |
| `machine` | Every consult session you run on this machine |

Settings are stored in `$XDG_CONFIG_HOME/consult/settings.json` (default `~/.config/consult/`). Running sessions register in `$XDG_STATE_HOME/consult/sessions/` (default `~/.local/state/consult/`), and only you can read those files. Turning sessions on or off takes effect in new agent sessions; a narrower scope applies immediately.

| CLI | How consult finds the session |
| --- | --- |
| claude | `CLAUDE_CODE_SESSION_ID`. After `/clear`, the entry still points at the earlier conversation until the session restarts. |
| codex | the `rollout-*.jsonl` file the codex process holds open, from the session's first turn on |
| grok | not supported yet: grok sessions can ask others but can't be asked |
~~~

- [ ] **Step 3: README: containment and CLI**

Below the table in `## How advisors are contained`, add:

```markdown
`ask_session` copies use the same flags, plus `--resume <id> --fork-session` (claude, grok) or `exec fork <id>` (codex), so the live session's own transcript is only read.
```

In `## CLI`, add to the code block:

```bash
consult settings                      # live sessions, and which agents use consult
```

- [ ] **Step 4: SECURITY.md**

After the "**Treat advice as untrusted input.**" paragraph, add:

```markdown
**Live sessions expose conversations (off by default).** With live sessions on, an agent can ask a read-only copy of another running session. That copy can repeat anything in the session's conversation, including secrets pasted into it, to the asking agent and so to the asking agent's provider. The `repo` and `machine` scopes decide which sessions can ask which. consult enforces them, not the operating system, but any process running as you can already read these transcripts on disk. Copies run with the advisor flags above, so asking can't change files or loop through consult, and the original session's transcript is only read. The session registry holds session ids and paths, in files only you can read.
```

- [ ] **Step 5: AGENTS.md / CLAUDE.md layout table**

Add these rows to the `## Layout` table in both files:

```markdown
| `src/settings.ts`, `src/tui.ts` | Settings file, `consult settings` TUI, install-time question |
| `src/sessions/*.ts`, `src/session-tools.ts` | Live sessions: registry, identity, scope, `list_sessions`/`ask_session` |
```

- [ ] **Step 6: Check, then commit**

Run: `npm test && npm pack --dry-run 2>&1 | grep -E "docs/|\.test\." || echo "package contents ok"`
Expected: tests PASS, and `package contents ok` (only `dist`, `README.md`, `LICENSE` ship).

```bash
git add README.md SECURITY.md
git ls-files --error-unmatch AGENTS.md CLAUDE.md >/dev/null 2>&1 && git add AGENTS.md CLAUDE.md
git commit -m "docs: live sessions, settings and their threat model"
```

---

### Task 16: Spike: Grok session identity

**Files:** depends on the outcome; at most `src/sessions/identity.ts`, `test/identity.test.ts` and the README grok row.

Goal: find out whether a consult server started by an **interactive** Grok session can learn that session's id. Headless `grok --single` does not start project-scoped MCP servers and does not list itself in `~/.grok/active_sessions.json` (both verified 2026-10-01), so this needs a real interactive session.

- [ ] **Step 1: Start an interactive Grok session with live sessions on**

With `consult settings` set to `repo` and consult registered with grok:

```bash
tmux new-session -d -s grokprobe -c "$PWD" grok
tmux send-keys -t grokprobe "Reply with OK" Enter
```

(Without tmux, start `grok` in a second terminal in this repo and send one message.)

- [ ] **Step 2: Inspect the process tree, open files and Grok's own session list**

```bash
for pid in $(pgrep -f "cli.js serve|consult-mcp"); do
  p=$pid; for i in 1 2 3 4; do p=$(ps -o ppid= -p "$p" | tr -d ' '); echo "$pid <- $p $(ps -o comm= -p "$p")"; done
done
GROK_PID=$(pgrep -x grok | head -1)
lsof -p "$GROK_PID" -Fn | grep -iE "session|\.jsonl" | sed "s#$HOME#~#"
node -e 'const j=require(process.env.HOME+"/.grok/active_sessions.json");console.log(JSON.stringify(j,(k,v)=>typeof v==="string"&&v.length>40?v.slice(0,8)+"…":v,1))'
grok sessions list | head -5
```

Record: (a) the grok process's `comm` name (it must be exactly `grok` for `detectHost`); (b) whether it holds a file open whose name contains the session UUID shown by `grok sessions list`; (c) whether `active_sessions.json` maps a pid to that session id.

- [ ] **Step 3: Decide and act**

- **(b) holds:** in `currentSession`'s `grok` case, filter `deps.openFiles(host.pid)` with a regex for the observed path (same shape as `ROLLOUT`). Add a test like the codex one in `test/identity.test.ts`, using a fake path of the observed shape. Change the README grok row to describe the method.
- **(c) holds (and not b):** add `grokActiveSessions(): readonly { pid: number; sessionId: string }[]` to `IdentityDeps` (system implementation reads and validates `~/.grok/active_sessions.json` with zod; tests inject it), and look up `host.pid`. Add a test for a match and for a missing pid.
- **(a) fails** (the process isn't named `grok`): add the observed name to `detectHost` as an alias for `grok`, with a test.
- **Neither (b) nor (c):** change nothing. The README row already says grok sessions can't be asked yet.

- [ ] **Step 4: Clean up and commit (only if code changed)**

```bash
tmux kill-session -t grokprobe 2>/dev/null
npm test && npx tsc --noEmit
git add src/sessions/identity.ts test/identity.test.ts README.md
git commit -m "feat: identify grok sessions for live sessions"
```

---

### Task 17: Final verification

- [ ] **Step 1: Full checks**

Run: `npm test && npx tsc --noEmit && npm run build && npm pack --dry-run`
Expected: all PASS; the package lists only `dist/`, `README.md`, `LICENSE`, `package.json`.

- [ ] **Step 2: Real cross-vendor check**

1. `node dist/cli.js install --sessions=repo` (registers this checkout with your agents).
2. Start `claude` in this repo, ask it to read `src/run.ts` and summarise the kill logic, and let it finish.
3. Start `codex` in this repo. Ask: "Use list_sessions, then ask the Claude session what it concluded about the kill logic in src/run.ts."
4. Expected: Codex lists the Claude session (with a title), `ask_session` returns an answer that reflects the summary, and the Claude session's terminal shows nothing new.
5. Turn sessions off with `node dist/cli.js settings`. Calling `list_sessions` again in the running Codex session returns the "turned off" error.
6. Restore your normal install: `npx -y consult-mcp@latest install`.

- [ ] **Step 3: Hand off**

Use superpowers:finishing-a-development-branch. Releasing (version bump and `v*` tag) is a separate decision for the maintainer.
