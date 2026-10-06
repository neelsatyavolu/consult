# consult

**Let your coding agents get a second opinion.**

consult is an MCP server that lets Claude Code, Codex and Grok ask each other for advice through the CLIs already signed in on your machine. No API keys: each advisor runs on the subscription its CLI already uses.

Claude Code on Opus can ask Codex on GPT-6 Astra to review a plan, Codex can ask Grok why a test is flaky, or any of them can put one question to all the others at once. With [task dispatch](#task-dispatch) on, an agent can also hand a coding task to a Codex or Grok worker and follow its progress.

[consult.n3el.dev](https://consult.n3el.dev) · [npm](https://www.npmjs.com/package/consult-mcp)

## Install

```bash
npx -y consult-mcp@latest install
```

This registers consult with every agent CLI it finds on your `PATH` (`claude`, `codex`, `grok`), at user scope. Restart running agent sessions afterwards.

**It stays up to date.** Hosts launch the server with `npx -y consult-mcp@latest serve`, so each new agent session runs the latest release. Re-running `install` is safe: it replaces an existing registration, including ones written by older versions.

To remove it:

```bash
npx -y consult-mcp@latest uninstall
```

Requirements: Node 22 or later, macOS or Linux, and at least one of the `claude`, `codex` or `grok` CLIs, signed in.

<details>
<summary>What install changes</summary>

- **claude**: `claude mcp add consult --scope user …`
- **grok**: `grok mcp add consult …`
- **codex**: a `[mcp_servers.consult]` table in `$CODEX_HOME/config.toml` (default `~/.codex/config.toml`). It sets `tool_timeout_sec = 960` because Codex's 60s default is too short for an advisor call, and `startup_timeout_sec = 60` because a cold `npx` start can take longer than the default 10s. The previous file is kept as `config.toml.bak`. consult only writes the file if the result parses and every other setting is unchanged. Otherwise it stops and asks you to edit the file by hand.

Each entry sets `PATH` to the directories holding the launcher (`npx` or `node`) and the agent CLIs, because some hosts start MCP servers with a minimal environment.

To pin to a specific build instead of following `@latest`, install globally with `npm i -g consult-mcp` and run `consult install`, or run `node dist/cli.js install` from a checkout. Hosts then launch that exact script.
</details>

## Tools

**`ask_agent`** `{agent, question, model?, effort?, session_id?, cwd?}` returns `{agent, answer, session_id, model?, duration_ms}`.

- `agent`: `claude`, `codex` or `grok`.
- `model`: passed through to that CLI (`opus`, `gpt-6-astra`, `grok-4.7`, …). Omit it to use the CLI's default.
- `effort`: `low`, `medium` or `high`.
- `session_id`: continues an earlier conversation with the same advisor.
- `cwd`: the directory the advisor can read. Defaults to the directory the host agent started the server in, which is normally its repo.

**`ask_agents`** `{agents, question, effort?, cwd?}` asks several advisors the same question in parallel and returns `{results: [...]}`, one entry per advisor. Each entry is either an answer with its own `session_id` or an `error`. One advisor failing doesn't fail the others.

**`list_agents`** shows the installed CLIs, their versions and the model IDs each account can use.

**`list_sessions`** and **`ask_session`** `{session_id, question, effort?}` appear when [live sessions](#live-sessions) are on.

**`dispatch_task`**, **`task_status`** and **`cancel_task`** appear when [task dispatch](#task-dispatch) is on.

While an advisor is working, the server sends MCP progress notifications (`codex is thinking (40s)`), so hosts that show progress don't look stuck.

## When agents consult

The server's MCP instructions, which hosts add to the agent's context, tell it to ask for a second opinion when:

- it has tried two fixes for a bug and neither worked,
- it is about to make an architecture, data-model, migration or other hard-to-reverse decision,
- it wants a plan or a diff reviewed before calling the work done,
- it is unsure and being wrong is costly.

The instructions also tell it to prefer an advisor from a different vendor, to write self-contained questions (the advisor can read the repo but not the conversation), and to check advice against the code before acting on it.

## Live sessions

Off by default. When on, agents can ask the agent sessions you already have running, not only fresh advisors. For example, the Codex session working on your API can ask the Claude Code session that wrote the client what it changed.

- **`list_sessions`** lists other live sessions: agent, session id, directory, git branch, title, and when each started and was last active. Nothing else from their conversations.
- **`ask_session`** `{session_id, question, effort?}` asks a read-only **copy** of that session. consult forks it (`claude --resume <id> --fork-session`, `codex exec fork <id>`, `grok --resume <id> --fork-session`) with the same containment as any advisor. The copy knows everything the session has seen, while the session itself is not interrupted and never sees the question. Pass the reply's `session_id` and `cwd` to `ask_agent` for follow-ups.

Turn it on when you install, or later:

```bash
npx -y consult-mcp@latest install --sessions=repo   # or off, machine; without the flag, install asks when run in a terminal
npx -y consult-mcp@latest settings                  # interactive: live sessions, task dispatch, and which agents use consult
```

| Setting | Who can see and ask whom |
| --- | --- |
| `off` (default) | Nobody. The tools don't appear. |
| `repo` | Sessions in the same git repository, including its worktrees (outside git: the same directory) |
| `machine` | Every consult session you run on this machine |

Settings are stored in `$XDG_CONFIG_HOME/consult/settings.json` (default `~/.config/consult/`). Running sessions register in `$XDG_STATE_HOME/consult/sessions/` (default `~/.local/state/consult/`), and only you can read those files. Turning sessions on takes effect in new agent sessions; turning them off, or changing the scope, applies immediately.

| CLI | How consult finds the session |
| --- | --- |
| claude | the record Claude Code keeps for each running process (`~/.claude/sessions/<pid>.json`), so it follows `/resume` and `/clear`; `CLAUDE_CODE_SESSION_ID` as a fallback. Listed once the conversation is saved, after its first message |
| codex | the `rollout-*.jsonl` file the codex process holds open, from the session's first turn on |
| grok | the `~/.grok/sessions/<cwd>/<session id>/events.jsonl` file the interactive grok process holds open, from the session's first turn on; not identified if several sessions are open |

## Task dispatch

Off by default. When on, an agent can hand a well-defined coding task to a Codex or Grok worker, keep working, and check in on it. For example, Claude Code can have Codex write the tests for a module while it builds the next one.

- **`dispatch_task`** `{agent, task, model?, effort?, cwd?}` starts the worker in the background and returns a `task_id` at once. `agent` is `codex` or `grok`. The worker runs headless in `cwd` (default: the host's directory) and can edit files and run commands there. It can't see the host's conversation or ask questions, so the task must be self-contained.
- **`task_status`** `{task_id?, wait_sec?, since?}` returns the task's state (`running`, `succeeded`, `failed`, `cancelled`), its latest updates (commands run, files edited, messages), and the worker's final report once it finishes. `wait_sec` (up to 600) waits for the task to finish, sending each update as an MCP progress notification as it happens. `since` returns only updates after the `last_seq` of an earlier call (the server keeps the last 200; `earlier_updates_dropped` says when you missed some). Without `task_id` it lists all tasks.
- **`cancel_task`** `{task_id}` stops the worker. Files it already changed stay changed.

Tasks live in the consult server's memory: they end with the agent session that started them, and the server stops any still running when it exits. `CONSULT_TASK_TIMEOUT_SEC` (default 3600) caps each task. The report includes the worker's `session_id`; pass it to `ask_agent` with the same agent to ask a read-only follow-up about the work.

Turn it on with `npx -y consult-mcp@latest settings`; it applies to agent sessions started afterwards. Workers change files, so review their diff before building on it, and don't point two workers at the same files.

## How advisors are contained

Every advisor runs headless and read-only, and has no MCP servers. So an advisor can't call consult again, which prevents loops.

| CLI | Flags |
| --- | --- |
| claude | `-p --restricted --tools Read,Grep,Glob --strict-mcp-config` |
| codex | `exec`, `sandbox_mode="read-only"`, `approval_policy="never"`, plugins off, and every enabled MCP server disabled by name (Codex runs MCP tools outside its sandbox) |
| grok | `--tools read_file,grep,list_dir --disallowed-tools Agent,search_tool,use_tool` (the MCP helper tools can reach servers that write files) |

`ask_session` copies use the same flags, plus `--resume <id> --fork-session` (claude, grok) or `exec fork <id>` (codex), so the live session's own transcript is only read.

consult doesn't use Grok's kernel sandbox (`--sandbox read-only`), because it refuses to start on machines where `/var/run/docker.sock` is a symlink, as it often is on Macs with Docker installed.

The first message of each session also tells the advisor that another agent is consulting it. It should answer directly, skip approval and brainstorming workflows, and not modify anything.

[Task dispatch](#task-dispatch) workers are the one exception to read-only, and only when you turn it on. They stay headless and have no MCP servers, so they can't call consult either:

| CLI | Worker flags |
| --- | --- |
| codex | `exec`, `sandbox_mode="workspace-write"` with `network_access=false` and `writable_roots=[]` (writes confined to the cwd and temp dirs, no network), `approval_policy="never"`, plugins off, and every enabled MCP server disabled by name |
| grok | `--tools read_file,grep,list_dir,search_replace,write_file,run_terminal_cmd --always-approve --disallowed-tools Agent,search_tool,use_tool`. Without Grok's kernel sandbox (see above), its shell commands run unconfined as your user, with network access. Its shell could even start another agent CLI, so for grok "no MCP servers" stops loops through consult but is not a hard boundary |

Their first message tells them another agent dispatched them, to finish the task without asking questions, to stay within the task and the directory, and not to commit or push unless the task says so.

Advisors send what they read to their own provider. [SECURITY.md](SECURITY.md) covers read scope and the threat model.

## CLI

The same calls are available from the shell, which is handy for debugging:

```bash
consult ask codex --model gpt-6-astra "Is the retry logic in src/sync.ts safe under concurrent calls?"
consult ask codex --resume <session_id> "What would you change first?"
consult ask grok - < question.md      # long questions from a file or pipe
consult agents
consult settings                      # live sessions, task dispatch, and which agents use consult
```

Use `npx -y consult-mcp@latest <command>` if it isn't installed globally. Advisors are read-only here too: the same containment flags apply, so there is no need to tell them not to edit files. While one works, `consult ask` prints timestamped progress to stderr (commands run and messages for codex and grok, a heartbeat after 30 quiet seconds for any agent) and only the answer to stdout.

`CONSULT_TIMEOUT_SEC` (default 900) caps each advisor call; raise it for long grok runs on large questions. `CONSULT_TASK_TIMEOUT_SEC` (default 3600) caps each dispatched task.

## Development

```bash
npm install
npm run build
npm test                              # unit tests, no CLIs needed
npm run test:live                     # real calls to all three CLIs through the MCP server
node dist/cli.js install              # register this checkout with your agents
```

Releases: bump `version` in `package.json`, then push a matching tag (`git tag v0.3.0 && git push --tags`). The [release workflow](.github/workflows/release.yml) publishes to npm with provenance through npm trusted publishing, then creates the GitHub release. Everyone using `@latest` picks it up on their next agent session. Tags with a pre-release suffix (`v0.3.0-rc.1`) publish to the `next` dist-tag instead of `latest`.

The landing page is in [`site/`](site) and deploys to [consult.n3el.dev](https://consult.n3el.dev) on Vercel.

## License

[MIT](LICENSE)
