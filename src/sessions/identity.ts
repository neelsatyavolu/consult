import { existsSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { AGENTS, SESSION_ID_PATTERN, type AgentName, type Runner } from "../types.js";

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
  /** The session a running claude process is on now, from Claude Code's own per-process record. */
  readonly claudeSessionOf: (pid: number) => string | undefined;
  readonly claudeTranscript: (sessionId: string) => string | undefined;
}

const MAX_DEPTH = 6;
const PROC_OPTS = { cwd: "/", timeoutMs: 5_000 } as const;
const PS_LINE = /^\s*(\d+)\s+(\S.*?)\s*$/;
const SAFE_ID = SESSION_ID_PATTERN;
const ROLLOUT = /\/sessions\/(?:.*\/)?rollout-[^/]*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/;

const GROK_EVENTS = /\/\.grok\/sessions\/[^/]+\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/events\.jsonl$/;

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
      // CLAUDE_CODE_SESSION_ID is fixed when this server starts, so it goes stale after /resume or /clear.
      // Claude Code's per-process record follows the conversation, so it wins when there is one.
      const sessionId = (host.pid === undefined ? undefined : deps.claudeSessionOf(host.pid)) ?? deps.env.CLAUDE_CODE_SESSION_ID;
      if (!sessionId || !SAFE_ID.test(sessionId)) return undefined;
      // A fork resumes the saved conversation, so the session can only be asked once its transcript exists.
      const transcriptPath = deps.claudeTranscript(sessionId);
      return transcriptPath ? { sessionId, transcriptPath } : undefined;
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
    case "grok": {
      if (host.pid === undefined) return undefined;
      // An interactive grok holds ~/.grok/sessions/<encoded cwd>/<session id>/events.jsonl open.
      // Several distinct ids (subagent, /new) are ambiguous, so refuse rather than risk advertising the wrong one.
      const matches = (await deps.openFiles(host.pid)).flatMap((f) => {
        const id = GROK_EVENTS.exec(f)?.[1];
        return id ? [{ sessionId: id, transcriptPath: f }] : [];
      });
      const ids = new Set(matches.map((m) => m.sessionId));
      return ids.size === 1 ? matches[0] : undefined;
    }
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
  const claudeDir = env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
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
    claudeSessionOf(pid) {
      try {
        const record = JSON.parse(readFileSync(join(claudeDir, "sessions", `${pid}.json`), "utf8")) as {
          pid?: unknown;
          sessionId?: unknown;
        };
        return record.pid === pid && typeof record.sessionId === "string" && SAFE_ID.test(record.sessionId)
          ? record.sessionId
          : undefined;
      } catch {
        // No record (older Claude Code, or not a claude process) or one being rewritten: use the env var.
        return undefined;
      }
    },
    claudeTranscript(sessionId) {
      const projects = join(claudeDir, "projects");
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
