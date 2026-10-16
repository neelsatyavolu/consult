# Agent Instructions

## This repo is open source
- Public on GitHub and published to npm as `consult-mcp`: anything committed or packaged is public.
- Never commit secrets, API keys, tokens, or credentials, including in tests, fixtures, or examples.
- Never commit personal data: absolute local paths (`/Users/...`), emails, machine names, session transcripts.
- Check package contents with `npm pack --dry-run` before any publish.

## Package Manager
- Use **npm** (`package-lock.json`); Node >= 22, ESM only.

## Commands
| Task | Command |
|------|---------|
| Test file | `npx vitest run test/adapters.test.ts` |
| All unit tests (no CLIs needed) | `npm test` |
| Typecheck | `npx tsc --noEmit` |
| Build to `dist/` | `npm run build` |
| Live tests (real claude/codex/grok CLIs) | `npm run build && npm run test:live` |
| Run local server | `node dist/cli.js serve` |

## Layout
| Path | Purpose |
|------|---------|
| `src/server.ts` | MCP tools: `ask_agent`, `ask_agents`, `review_changes`, `list_agents` |
| `src/consult.ts` | Request flow: frame prompt, run adapter, parse reply |
| `src/adapters/*.ts` | One `Adapter` per CLI (see `src/types.ts`) |
| `src/run.ts` | Child process runner: timeout, abort, output cap |
| `src/platform.ts` | Windows: spawn `.cmd` shims without cmd.exe, command-line limits, sessions gate |
| `src/review.ts` | `review_changes` / `consult review`: collect the git diff, build the review question |
| `src/doctor.ts` | `consult doctor` checks |
| `src/install.ts`, `src/codex-config.ts` | `consult install`/`uninstall` into host configs |
| `src/prompt.ts` | Advisor briefing prepended to each new session |
| `src/settings.ts`, `src/tui.ts` | Settings file, `consult settings` TUI, install-time question |
| `src/sessions/*.ts`, `src/session-tools.ts` | Live sessions: registry, identity, scope, `list_sessions`/`ask_session` |
| `src/sessions/inbox.ts`, `src/hook.ts`, `src/hooks-install.ts` | Session messages: inbox files, `consult hook` delivery, hook entries in each host's hook file |
| `test/fixtures/` | Recorded CLI output that adapter tests parse |
| `site/` | Static landing page, deployed to getconsult.dev on Vercel (consult.n3el.dev redirects there) |

## Key Conventions
- Import local modules with a `.js` suffix (`NodeNext` resolution).
- Keep data `readonly`; return new objects rather than mutating.
- Throw `AdvisorError` for advisor failures that should reach the MCP caller.
- Inject `Runner` in tests instead of spawning real CLIs; only `test/live.test.ts` spawns them.
- Adding an agent: extend `AGENTS` in `src/types.ts`, add `src/adapters/<name>.ts`, a fixture, and adapter tests.
- `dist/` is generated and gitignored; never edit it.
- `site/` is plain HTML/CSS/JS with a strict CSP in `site/vercel.json`; no inline scripts or new external origins.

## Security Invariants
- Advisors must stay headless, read-only, and without MCP servers (prevents writes and consult loops).
- Any change to an adapter's flags must keep these guarantees and update the table in `README.md` ("How advisors are contained") and `SECURITY.md`.

## Releasing
- Bump `version` in `package.json`, then push a matching `v*` tag; `.github/workflows/release.yml` publishes via npm trusted publishing.
- Never run `npm publish` locally or add an npm token to the repo.

## External References
| Need | File |
|------|------|
| User docs, tools, CLI | `README.md` |
| Threat model, reporting | `SECURITY.md` |
| CI matrix | `.github/workflows/ci.yml` |
| Release pipeline | `.github/workflows/release.yml` |
