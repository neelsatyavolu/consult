# consult

An MCP server that lets coding agents ask each other for advice through the CLIs already signed in on this machine: Claude Code (`claude`), Codex (`codex`) and Grok (`grok`). No API keys.

Claude Code on Opus can ask Codex on GPT-6 Astra for a second opinion, Codex can ask Grok, and so on.

## Install

```bash
npm install && npm run build
node dist/cli.js install   # registers the server with claude, codex and grok (user scope)
```

Restart running agent sessions afterwards. `install` is idempotent. It uses the `node` and agent CLIs on your current `PATH`, and sets Codex's `tool_timeout_sec` to 960 because Codex's 60s default is too short for an advisor call.

To remove it: `claude mcp remove consult -s user`, `grok mcp remove consult`, and delete the `[mcp_servers.consult]` table from `~/.codex/config.toml`.

## Tools

**`ask_agent`** `{agent, question, model?, effort?, session_id?, cwd?}` returns `{agent, answer, session_id, model?, duration_ms}`.

- `agent`: `claude`, `codex` or `grok`.
- `model`: passed through to that CLI (`opus`, `gpt-6-astra`, `grok-4.7`, ...). If omitted, the CLI's default is used.
- `effort`: `low`, `medium` or `high`.
- `session_id`: continues an earlier conversation with the same advisor.
- `cwd`: the directory the advisor can read. Defaults to the directory the host agent started the server in, which is normally its repo.

**`list_agents`** shows the installed CLIs, their versions and the model IDs each account can use.

## How the advisor is contained

Every advisor runs headless and read-only, and has no MCP servers. That also means an advisor can't call `consult` again, which is how loops are prevented.

| CLI | Flags |
| --- | --- |
| claude | `-p --restricted --tools Read,Grep,Glob --strict-mcp-config` |
| codex | `exec`, `sandbox_mode="read-only"`, `approval_policy="never"`, plugins off, every enabled MCP server disabled by name (Codex runs MCP tools outside its sandbox) |
| grok | `--tools read_file,grep,list_dir --disallowed-tools Agent,search_tool,use_tool` (the MCP helper tools can reach servers that write files) |

Grok's kernel sandbox (`--sandbox read-only`) isn't used because it refuses to start when `/var/run/docker.sock` is a symlink, which is the case on this Mac.

The first message of each session also tells the advisor it's being consulted by another agent: answer directly, don't run approval or brainstorming workflows, and don't modify anything.

## CLI (for debugging)

```bash
node dist/cli.js ask codex --model gpt-6-astra "Is the retry logic in src/sync.ts safe under concurrent calls?"
node dist/cli.js ask codex --resume <session_id> "What would you change first?"
node dist/cli.js agents
```

`CONSULT_TIMEOUT_SEC` (default 900) caps each advisor call.

## Tests

```bash
npm test                              # unit tests, no CLIs needed
npm run build && npm run test:live    # real calls to all three CLIs through the MCP server
```
