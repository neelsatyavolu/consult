# consult

**Let your coding agents get a second opinion.**

consult is an MCP server that lets Claude Code, Codex and Grok ask each other for advice through the CLIs already signed in on your machine. No API keys: each advisor runs on the subscription its CLI already uses.

Claude Code on Opus can ask Codex on GPT-6 Astra to review a plan, Codex can ask Grok why a test is flaky, or any of them can put one question to all the others at once.

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

While an advisor is working, the server sends MCP progress notifications (`codex is thinking (40s)`), so hosts that show progress don't look stuck.

## When agents consult

The server's MCP instructions, which hosts add to the agent's context, tell it to ask for a second opinion when:

- it has tried two fixes for a bug and neither worked,
- it is about to make an architecture, data-model, migration or other hard-to-reverse decision,
- it wants a plan or a diff reviewed before calling the work done,
- it is unsure and being wrong is costly.

The instructions also tell it to prefer an advisor from a different vendor, to write self-contained questions (the advisor can read the repo but not the conversation), and to check advice against the code before acting on it.

## How advisors are contained

Every advisor runs headless and read-only, and has no MCP servers. So an advisor can't call consult again, which prevents loops.

| CLI | Flags |
| --- | --- |
| claude | `-p --restricted --tools Read,Grep,Glob --strict-mcp-config` |
| codex | `exec`, `sandbox_mode="read-only"`, `approval_policy="never"`, plugins off, and every enabled MCP server disabled by name (Codex runs MCP tools outside its sandbox) |
| grok | `--tools read_file,grep,list_dir --disallowed-tools Agent,search_tool,use_tool` (the MCP helper tools can reach servers that write files) |

consult doesn't use Grok's kernel sandbox (`--sandbox read-only`), because it refuses to start on machines where `/var/run/docker.sock` is a symlink, as it often is on Macs with Docker installed.

The first message of each session also tells the advisor that another agent is consulting it. It should answer directly, skip approval and brainstorming workflows, and not modify anything.

Advisors send what they read to their own provider. [SECURITY.md](SECURITY.md) covers read scope and the threat model.

## CLI

The same calls are available from the shell, which is handy for debugging:

```bash
consult ask codex --model gpt-6-astra "Is the retry logic in src/sync.ts safe under concurrent calls?"
consult ask codex --resume <session_id> "What would you change first?"
consult agents
```

Use `npx -y consult-mcp@latest <command>` if it isn't installed globally. `CONSULT_TIMEOUT_SEC` (default 900) caps each advisor call.

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
