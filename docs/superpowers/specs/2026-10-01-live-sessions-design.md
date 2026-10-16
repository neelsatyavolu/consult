# Live sessions: design (sub-project 1 of inter-agent communication)

Status: approved in conversation on 2026-10-01 (sections 2-4 below were not reviewed separately; the owner asked to go straight to the plan, so they record the recommended defaults).

## Goal

Let an agent in one running session (Claude Code, Codex or Grok) find other agent sessions running live on the same machine and ask them a question, across vendors. Today consult only starts fresh headless advisors; it cannot reach a session that is already running.

Sub-project 2 (async messages between live sessions, native delivery through `codex queue`, hooks) is out of scope here and gets its own spec.

## Decisions (from the conversation)

| Topic | Decision |
|---|---|
| Use case | Both "ask a live session" and "coordinate live sessions"; this spec covers asking. |
| How asking works | consult makes a headless, read-only **fork** of the target session (`claude --resume <id> --fork-session`, `codex exec fork <id>`, `grok --resume <id> --fork-session`) with the adapter's existing containment flags. The fork knows the target's conversation; the target is not interrupted and its transcript is never written. |
| Off by default | Live sessions are off until the user turns them on: `consult install` asks (only on a TTY; `--sessions=off\|repo\|machine` for scripts) and `consult settings` changes it later. |
| Scope | `repo` (default when enabled): sessions sharing a git common dir, so worktrees match; outside git, the same directory. `machine`: every consult session of this user. |
| What the listing shows | Metadata only: agent, session id, cwd, git branch, title, started, last active. No transcript content beyond the host's own session title. |
| Settings TUI | `consult settings`: live-sessions mode plus which hosts consult is registered with (reusing install/uninstall). Built with `@clack/prompts`. |
| Registry | Approach A: one JSON file per running consult server, no daemon. |

## Architecture

| Unit | Responsibility |
|---|---|
| `src/settings.ts` | `{ version: 1, sessions: { enabled, scope } }` in `$XDG_CONFIG_HOME/consult/settings.json` (default `~/.config/...`). Missing file: defaults. Invalid file: `SettingsError`. Atomic write, mode 0600. |
| `src/sessions/scope.ts` | `repoKey(cwd)` (realpath of `git rev-parse --git-common-dir`, else the cwd), `gitBranch(cwd)`, `inScope(self, other, scope)`. |
| `src/sessions/registry.ts` | `$XDG_STATE_HOME/consult/sessions/<pid>.json` (default `~/.local/state/...`), dir 0700, files 0600. `listLive()` prunes files of dead PIDs, skips unreadable ones, dedupes by session id. |
| `src/sessions/identity.ts` | Which host started this server (nearest `claude`/`codex`/`grok` ancestor process; `CLAUDE_CODE_SESSION_ID` as fallback) and its session id: claude from `CLAUDE_CODE_SESSION_ID`; codex from the `rollout-*-<uuid>.jsonl` the codex process holds open (`lsof`, or `/proc/<pid>/fd` on Linux); grok: unknown until the spike. |
| `src/sessions/describe.ts` | Title and last-active for an entry: claude's last `ai-title` record (tail of transcript), codex's `session_index.jsonl` `thread_name`; last active = transcript mtime. |
| `src/sessions/live.ts` | Registers this server's host session, refreshes every 15 s (codex opens its rollout lazily; `/new` changes the id), removes the entry on shutdown. |
| `src/sessions/service.ts` | `list()` and `ask()` with settings and scope checked on every call. |
| `src/sessions/wire.ts` | Composes the above for `consult serve`. |
| `src/session-tools.ts` | MCP tools `list_sessions` and `ask_session`. |
| `src/tui.ts` | `consult settings` and the install-time question. |
| Adapters | New `fork(sourceSessionId, request, prompt, extraArgs)`. |
| `src/consult.ts` | New `askSession(target, question, effort, signal)`, running in the **target's** cwd. |

## Data flow

1. **Startup** (`consult serve`): load settings. Invalid: warn on stderr, sessions off, everything else unchanged. Disabled: no registration and no session tools (no extra tool descriptions in the host's context). Enabled: register, add `list_sessions` and `ask_session`, append a paragraph to the server instructions.
2. **list_sessions**: re-read settings (off: error pointing to `consult settings`), list live entries, drop self and out-of-scope ones, attach title and last-active.
3. **ask_session `{session_id, question, effort?}`**: same visibility check; refuse self; fork the target with `frameForkPrompt` in the target's cwd; return the fork's `session_id`, `cwd`, `source_session_id`. Follow-ups go through `ask_agent {agent, session_id, cwd}`, which resumes the fork, never the source.
4. Settings changes apply to new sessions for registration and tool lists; scope and on/off are re-checked per call.

## Error handling

- Corrupt settings: `serve` warns and runs with sessions off; `consult settings` offers a reset; `install --sessions=...` overwrites.
- Corrupt or foreign registry files are skipped; files of dead PIDs are deleted by any reader.
- Unknown, out-of-scope or own session: `AdvisorError` with the next step.
- Fork failures use the existing advisor error path (`<agent> exited with code ...`, timeouts, cancellation).
- `consult settings` without a TTY: error that names `install --sessions=...`.

## Security

- Forks run with exactly the advisor containment flags (read-only, no MCP servers), so asking cannot write files or loop through consult. A live test checks that a fork of a write-capable source session cannot create files.
- New exposure, documented in `SECURITY.md`: an asking agent can extract anything in the target session's conversation (including secrets pasted there) and send it to the asking agent's vendor. Scope limits who can ask; it is enforced by consult, not by the OS: any process running as the user can already read these transcripts.
- Registry files hold session ids and paths only, readable only by the user.
- Known limitation: after Claude's `/clear`, its MCP server keeps the old `CLAUDE_CODE_SESSION_ID`, so the entry points at the earlier conversation until the session restarts.

## Testing

Unit tests for every module with injected `Runner`, identity and file paths (temp dirs); MCP tool tests over `InMemoryTransport`; a wiring test with two registered "servers" in one temp state dir; live tests for fork containment on all three CLIs and an end-to-end `list_sessions` → `ask_session` over the built server for Claude.
