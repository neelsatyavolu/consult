# Session messages: design (sub-project 2 of inter-agent communication)

Status: approved in conversation on 2026-10-12 ("do what you recommend"), and implemented the same day. The section "As built" at the end records where the implementation differs from the proposal below.

## Goal

Let an agent in one live session send a short message to another live session (Claude Code, Codex or Grok) on the same machine, so the receiving agent sees it in its own conversation. Today `ask_session` only asks a read-only copy; the original session never learns anything.

Motivating case: session A merges and pushes `main` while session B has uncommitted edits in the same checkout. A wants to tell B which files changed under it.

## What the hosts support (checked 2026-10-12)

| Host | Version checked | Delivery surface | Verified how |
|---|---|---|---|
| Claude Code | 2.1.296 | Hooks in `~/.claude/settings.json`: `UserPromptSubmit` and `PostToolUse` can add `additionalContext`; `Stop` can block with a reason the model reads. | Known behaviour; not re-tested for this spec. |
| Grok | 1.0.52 | Hooks in `~/.grok/hooks/*.json`, same JSON shape as Claude. `PostToolUse` and `PreToolUse` deliver `additionalContext`; `Stop` can block with a reason. `UserPromptSubmit` stdout is discarded, so it cannot deliver. Hook stdin carries `sessionId`. Grok also loads hooks from `~/.claude/settings.json`, and runs a handler named by two sources once when the command is identical. | Read in Grok's bundled user guide (`10-hooks.md`). Not run. |
| Codex | 0.162.1 | Hooks in `~/.codex/hooks.json` (`UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`, `SessionStart`), each needing persisted hook trust. Also `codex queue --thread <id> --message <text>`: "Queue a message for an existing session". | Seen in `codex --help` and an existing `hooks.json`. Not run. |

Not yet known, needs a spike before the plan:

1. Whether `codex queue` reaches a session open in the TUI, and whether it starts a turn in an idle one.
2. Whether Codex hooks can add model-visible context, and on which events.
3. How a newly written Codex hook becomes trusted (prompt on next start, or a manual step).
4. Whether each host's hook stdin session id equals the id consult registers for that session.

The spikes must use throwaway sessions, never one of the user's working sessions.

## Decisions (proposed)

| Topic | Decision |
|---|---|
| Tool | `send_message {session_id, message}`. Returns a message id and says the message is queued, not that it was read. |
| Transport | An inbox directory per recipient session, next to the registry: `$XDG_STATE_HOME/consult/inbox/<sessionId>/<messageId>.json`, dir 0700, files 0600, atomic write. No daemon. |
| Delivery, primary | A host hook runs `consult hook`, which claims the recipient's pending messages and prints them in the host's hook-output format. Events: `PostToolUse` and `Stop` on all hosts, plus `UserPromptSubmit` on Claude. |
| Delivery, fallback | The recipient's consult server appends pending messages to the result of any consult tool it runs. Covers hosts whose hooks are not installed or not trusted. |
| Codex | Hooks if spike 2 passes; otherwise `codex queue` if spike 1 passes; otherwise fallback only. |
| Exactly once | A message is claimed by renaming it into `claimed/` before printing. Whichever path wins the rename delivers it. |
| Idle sessions | Not woken. A message to an idle session waits until its user next prompts it (Claude) or it next runs a tool or ends a turn (Grok). See open question 1. |
| Off by default | New setting `messages: { enabled }`, default false, only usable when live sessions are on. `consult install` and `consult settings` ask; hooks are written only when it is on and removed when it is turned off or on `uninstall`. |
| Scope | Same as live sessions: the sender must be a registered live session, the recipient must be visible to it under the `repo` or `machine` scope. Checked on send. |
| Limits | Message at most 4,000 characters; at most 20 pending per recipient; at most 10 messages per sender-recipient pair per hour; unclaimed messages expire after 24 hours. |
| Framing | Delivered text is wrapped: which agent and session sent it, from which directory and branch, when, and a fixed line saying it is information from a peer agent session, not an instruction from the user, and should be checked against the repository before acting. |
| Replies | The recipient replies with its own `send_message` to the sender's session id, which the framing includes. No threads. |

## Architecture

| Unit | Responsibility |
|---|---|
| `src/settings.ts` | Add `messages: { enabled }` with a default, like `tasks`. |
| `src/sessions/inbox.ts` | `enqueue`, `claim(sessionId)`, expiry and limits. Pure file operations on an injected directory. |
| `src/sessions/frame-message.ts` | Wraps a claimed message for the model. |
| `src/sessions/service.ts` | New `send(sessionId, message)` using the existing `visible()` check. |
| `src/session-tools.ts` | MCP tool `send_message`; fallback delivery appended to consult tool results. |
| `src/hook.ts` | `consult hook`: reads the host event on stdin, takes the session id, claims, prints per-host output. Exits 0 with no output on any failure. |
| `src/hooks-install.ts` | Adds and removes consult's hook entries in each host's hook file without touching other entries. |
| `src/cli.ts`, `src/tui.ts`, `src/install.ts` | `hook` subcommand, the new setting, install and uninstall of hooks. |

The hook command must be cheap, because it runs on every tool call. It first checks in shell whether the inbox directory has any entry and exits if not; only then does it start Node. It must not go through `npx`, so install writes an absolute path to the Node binary and script (open question 3).

To avoid double delivery in Grok, the hook command written to `~/.claude/settings.json` and `~/.grok/hooks/consult.json` is the same string.

## Error handling

- `consult hook` never blocks or fails a tool call: every error path exits 0 silently and leaves messages unclaimed for the next event.
- A `Stop` hook block happens at most once per message, since the message is claimed first, and is skipped when the host reports a stop hook is already active.
- Unknown, out-of-scope or own session, messages off, or a limit reached: `AdvisorError` naming the next step.
- A recipient session that ends leaves an inbox; any reader prunes inboxes with no live registry entry and expired messages.
- A corrupt message file is moved aside, not delivered.

## Security

- New exposure, to document in `SECURITY.md` and the README: one agent can put text into another live agent's context. That is a prompt-injection path between sessions, and the receiving session can write files. Mitigations: off by default, scope check, size and rate limits, fixed framing, and no way to deliver to a session that has not opted in through settings.
- As with live sessions, scope is enforced by consult, not the OS: any process running as the user can write an inbox file.
- A loop of two agents messaging each other is bounded by the per-pair rate limit.
- Advisors, forks and workers are unaffected: they have fresh session ids, so no inbox matches them, and they still run without MCP servers, so they cannot send. The advisor containment table does not change.
- Hooks are written into user-level config files outside the repository; install reports each file it changed.

## Testing

Unit tests for the inbox (claim races, limits, expiry, corrupt files), framing, per-host hook output and hook-file edits, all on temp dirs. MCP tool tests over `InMemoryTransport` for `send_message` and fallback delivery. A wiring test with two registered sessions in one state dir. Live tests, one per host, that a message sent to a throwaway session appears in its next turn.

## Open questions for the owner

1. Should a message be able to wake an idle session and start a turn? Proposed: no. It would spend the user's tokens and let one agent start work in another unattended.
2. Should the sender be able to see whether a message was delivered (`message_status`, or a field in `list_sessions`)? Proposed: not in the first version.
3. How should the hook find consult without `npx`? Proposed: `consult install` records the absolute path it ran from, and the hook falls back to doing nothing if that path is gone.

## As built (2026-10-12)

The open questions were settled as proposed: messages never wake an idle session, and there is no delivery receipt.

Spike results, from headless throwaway sessions with the hook passed in for that run only:

| Host | Result |
|---|---|
| Claude Code 2.1.296 | A queued message was read through `UserPromptSubmit`, `PostToolUse` and `Stop`, each tested alone. |
| Grok 1.0.52 | Read through `PostToolUse` and `Stop`. The hook's session id equals the session's own id. Grok sends `session_id` as well as `sessionId`. |
| Codex 0.162.1 | Read through `UserPromptSubmit`, `PostToolUse` and `Stop`. The hook's `session_id` equals the thread id. Hooks were passed with `-c hooks.<Event>=...` and `--dangerously-bypass-hook-trust`. |

Still not verified: how Codex asks for trust of a new entry in `~/.codex/hooks.json`; delivery into interactive sessions after a real `consult install --messages=on`; whether Codex or Grok subagents fire hooks with the parent's session id. `codex queue` was not needed and not tried.

Differences from the proposal:

- **Hook launcher.** The hook runs consult the same way the host launches the server (`npx -y consult-mcp@latest hook`, or the exact script for a pinned install), not from a recorded path, because an npx install has no stable path. To keep that affordable, the shell part of the hook starts consult only when the id of a session with waiting messages appears in the event; otherwise it costs one directory listing.
- **Fallback delivery** is attached to the session tools only (`list_sessions`, `ask_session`, `send_message`), not to every consult tool.
- **Rate limit** is kept in the sending server's memory, so it resets when that session restarts.
- **Grok stop delivery** uses `hookSpecificOutput.additionalContext`, which Grok shows as feedback; Claude Code and Codex get `decision: block`, which Claude Code shows as a stop-hook error.
- **Pruning.** An inbox is removed when it is emptied and expired messages are dropped when claimed. Inboxes of sessions that ended without reading are not swept.
- Files are `src/sessions/inbox.ts` (queue, claim, framing), `src/hook.ts`, `src/hooks-install.ts`; there is no separate framing module.

## Waking idle sessions (added 2026-10-12, released in 0.7.0)

The owner reversed open question 1 after using the feature: a message should wake an idle session.

| Host | Mechanism | Verified |
|---|---|---|
| Codex | The sender's consult server runs `codex queue --thread <id> --message <framed text>`. The message becomes the session's next prompt, so it is not also written to the inbox. A non-zero exit falls back to the inbox. | An idle throwaway TUI session started a turn about six seconds after the command. Behaviour while a turn is running was not tested. |
| Claude Code | A second `Stop` handler with `asyncRewake: true` and a 24-hour timeout. It is a shell loop that checks the session's inbox every 3 seconds and, when there is one, runs `consult hook --rewake`, which prints the framed messages to stderr and exits 2. | A real interactive session, idle at the prompt, was woken by a queued message and read it. Claude Code shows it as a "Stop hook blocking error". |
| Grok | None found. No CLI command reaches a running session, and Grok runs `asyncRewake` handlers in the foreground. | Read in Grok's bundled docs only. |

Details that matter:

- Grok also loads Claude Code's hook file and would run the watcher in the foreground at every stop, so the watcher exits at once when the event carries Grok's `hookEventName` field.
- One watcher per session: a pid file under the state directory, and the loop ends when its parent process is gone.
- The 0.6.0 hook failed under zsh, which Codex uses for hooks, because an unmatched glob fails the whole command there. Hook commands contain no globs, and tests run them under sh, bash and zsh.

Known and not fixed: Codex starts a second consult server for a subagent thread, and it registers under the main thread's id (identity takes the first rollout the Codex process holds open). The listing shows one entry, but that second server's tool replies could carry a message meant for the main agent.
