# Contributing to AI-Implement

Thanks for your interest. This is a small project; most contributions land via PRs against `main`.

## Setting up

```bash
git clone https://github.com/BuildDownAI/AI-Implement.git
cd AI-Implement
cp .env.example .env       # fill in LINEAR_API_KEY + GitHub App creds for local testing
npm install
npm run dev                # polling + HTTP server on :8080
npm run dev:local          # dev server + local Docker implementation jobs
npm test                   # vitest
npm run typecheck          # tsc --noEmit
```

Node 24 is the supported runtime (see `.tool-versions`). Earlier versions may work but aren't tested.

`npm run dev:local` first runs `npm run build:runner:local`, which builds
`Dockerfile.session` as `ai-implement-runner:local`. Docker must be running.
Local implementation jobs still create real GitHub branches and PRs.

If a target repo uses [agentica](https://docs.symbolica.ai/), set
`AGENTICA_API_KEY` in `.env`; the runner image ships with Python 3.12 and
`symbolica-agentica` preinstalled, and the orchestrator passes the key through
as a secret. See [docs/AGENTICA.md](docs/AGENTICA.md).

## Before opening a PR

1. **Tests pass** — `npm test` and `npm run typecheck` are both green.
2. **New functionality has tests** — most modules in `src/` have a sibling `__tests__/` directory; follow that pattern.
3. **Workflow templates aren't broken** — if you change anything in `workflows/` or `.github/workflows/`, lint with `actionlint` if you have it installed.
4. **No secrets, no client-specific data** — the `.gitignore` covers the obvious cases (`.env`, `*.pem`, `*.sqlite`), but double-check before pushing.

## The `custom/` extension model

This codebase is designed to be forked. The `custom/` directory is reserved for fork-local overrides — see `custom/README.md` and `docs/adr/001-custom-path-precedence.md` for the design.

If you're adding a feature, prefer making it configurable rather than hardcoding it. Operator-specific behavior (a particular notification format, a custom step, a non-default provider) belongs in `custom/` in the operator's fork — not in upstream.

The `protect-custom.yml` workflow rejects upstream PRs that touch any file under `custom/` other than `custom/README.md`. This is intentional.

## Commit messages

Conventional commits aren't required but appreciated. Concise subject line, optional body explaining the *why*.

## Bugs and feature requests

Open an issue. Include enough context to reproduce — for bugs, that means the Linear issue label + workflow dispatch behavior you saw, and what you expected.

## Security

See [SECURITY.md](SECURITY.md). Do not file public issues for security reports.

## License

By contributing, you agree that your contributions will be licensed under the Apache License, Version 2.0 (the project's license). No CLA is required.
