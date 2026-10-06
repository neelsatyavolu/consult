# Security

## Reporting a vulnerability

Please report security problems privately through [GitHub's private vulnerability reporting](https://github.com/neelsatyavolu/consult/security/advisories/new), not in a public issue. I'll reply within a few days.

## What consult does and doesn't protect against

consult starts other agent CLIs as advisors and, if you turn task dispatch on, as workers. It never handles API keys: each advisor uses the account its CLI is already signed in to.

**Advisors can't change anything.** Each advisor runs headless, gets only read-only tools and has no MCP servers. The exact flags are in the [README](README.md#how-advisors-are-contained). Without MCP servers an advisor can't call consult again, so advisors can't consult each other in a loop.

**Advisors can read, and what they read goes to their provider.** An advisor reads files in the working directory (`cwd`) and sends them to its own model provider, as it would if you ran that CLI yourself. Don't point an advisor at a directory holding secrets you wouldn't paste into that CLI. How far reads reach depends on the CLI:

| CLI | Read scope |
| --- | --- |
| claude | `--restricted` confines its file tools to `cwd` |
| codex | runs commands in its read-only sandbox (no writes, no network), which can read outside `cwd` |
| grok | only has the `read_file`, `grep` and `list_dir` tools. Grok's kernel sandbox isn't used (see the README), so reads aren't confined to `cwd` |

**Treat advice as untrusted input.** Repository content can carry prompt injection, and an advisor's answer goes straight back to the agent that asked. The server instructions tell host agents to verify advice before acting on it. Your host agent's own permission prompts still apply to anything it does next.

**Live sessions expose conversations (off by default).** With live sessions on, an agent can ask a read-only copy of another running session. That copy can repeat anything in the session's conversation, including secrets pasted into it, to the asking agent and so to the asking agent's provider. The `repo` and `machine` scopes decide which sessions can ask which. consult enforces them, not the operating system, but any process running as you can already read these transcripts on disk. Copies run with the advisor flags above, so asking can't change files or loop through consult, and the original session's transcript is only read. The session registry holds session ids and paths, in files only you can read.

**Task dispatch lets workers change files (off by default).** With task dispatch on, an agent can start a Codex or Grok worker that edits files and runs commands without asking for approval. Codex workers run in Codex's `workspace-write` sandbox: writes are confined to the working directory and temp dirs (extra writable roots from your Codex config are dropped), and network access is off. Grok workers have no sandbox (see the README for why), so their shell commands can do anything your user can, including using the network or starting another agent CLI. Workers have no MCP servers, so they can't dispatch more workers or consult anyone. A task is only as trustworthy as its instructions and the repository it reads: prompt injection in repository content can steer a worker, and with Grok that means arbitrary commands. Your host agent's permission prompt for `dispatch_task` is the gate, so leave task dispatch off unless you want agents to delegate writes, and review a worker's changes before relying on them.

**Process cleanup.** Each advisor and worker runs in its own process group. A timeout, a cancelled call, runaway output, the host closing the connection, or the server being signalled all terminate the whole group.

**Auto-update is a trust decision.** The default install launches `consult-mcp@latest` through npx, so a new release runs on your machine at the next agent session, with access to your signed-in CLIs. Releases are published from this repository's tagged commits through npm trusted publishing with provenance, and the release job runs no dependency install scripts. The first release, 0.2.0, was published by hand to set that up. If you'd rather review each version first, pin one: `npm i -g consult-mcp@<version>`, then `consult install`.

## Supported versions

Only the latest release gets fixes. With the default install, hosts are always on it.
