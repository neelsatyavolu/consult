# Security

## Reporting a vulnerability

Please report security problems privately through [GitHub's private vulnerability reporting](https://github.com/neelsatyavolu/consult/security/advisories/new), not in a public issue. I'll reply within a few days.

## What consult does and doesn't protect against

consult starts other agent CLIs as advisors. It never handles API keys: each advisor uses the account its CLI is already signed in to.

**Advisors can't change anything.** Each advisor runs headless, gets only read-only tools and has no MCP servers. The exact flags are in the [README](README.md#how-advisors-are-contained). Without MCP servers an advisor can't call consult again, so advisors can't consult each other in a loop.

**Advisors can read, and what they read goes to their provider.** An advisor reads files in the working directory (`cwd`) and sends them to its own model provider, as it would if you ran that CLI yourself. Don't point an advisor at a directory holding secrets you wouldn't paste into that CLI. How far reads reach depends on the CLI:

| CLI | Read scope |
| --- | --- |
| claude | `--restricted` confines its file tools to `cwd` |
| codex | runs commands in its read-only sandbox (no writes, no network), which can read outside `cwd` |
| grok | only has the `read_file`, `grep` and `list_dir` tools. Grok's kernel sandbox isn't used (see the README), so reads aren't confined to `cwd` |

**Treat advice as untrusted input.** Repository content can carry prompt injection, and an advisor's answer goes straight back to the agent that asked. The server instructions tell host agents to verify advice before acting on it. Your host agent's own permission prompts still apply to anything it does next.

**Process cleanup.** Each advisor runs in its own process group. A timeout, a cancelled call, runaway output, the host closing the connection, or the server being signalled all terminate the whole group.

**Auto-update is a trust decision.** The default install launches `consult-mcp@latest` through npx, so a new release runs on your machine at the next agent session, with access to your signed-in CLIs. Releases are published from this repository's tagged commits through npm trusted publishing with provenance, and the release job runs no dependency install scripts. The first release, 0.2.0, was published by hand to set that up. If you'd rather review each version first, pin one: `npm i -g consult-mcp@<version>`, then `consult install`.

## Supported versions

Only the latest release gets fixes. With the default install, hosts are always on it.
