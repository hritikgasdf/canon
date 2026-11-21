# Canon — rules for Claude Code

Canon is an Atlassian Forge app (Jira required, Confluence optional) that blocks Jira Done when the bound Confluence procedure gets a newer approved version. Full plan lives outside the repo; you get one narrow item per run.

## Hard rules
- Never read, print, or write secrets. Do not read `/home/box/secrets`, `.env*`, `~/.config`, or env vars holding tokens. Never run `forge` (the supervisor deploys/installs). No network calls except `npm install`.
- No git commits, pushes, branch changes, or remotes. The supervisor commits.
- Stay inside the files the prompt names. Keep diffs small. Do not delete AGENTS.md.
- UI uses Forge UI Kit (`@forge/react` components only, no HTML tags).
- TypeScript strict. Pure domain logic goes in `src/domain/` with **no** `@forge/*` imports; Forge adapters/handlers in `src/forge/`.
- Tests: Vitest (`npm test`). Typecheck: `npm run typecheck`. Lint: `npm run lint`. All three must pass before you finish.
- Safety logic (the gate) must fail CLOSED: any error/timeout → block with a clear message.
- Finish with a 5-line summary: files changed, commands run, results, open gaps.

## Frontend bundle rule
src/frontend/** may import only types, or dependency-free modules (e.g. src/domain/limits.ts), from src/domain. Never import a module that pulls in node:* (audit.ts uses node:crypto); the Forge UI bundle fails with UnhandledSchemeError.
