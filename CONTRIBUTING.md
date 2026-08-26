# Contributing to AI-Implement

Thanks for your interest. This is a small project; most contributions land via PRs against `main`.

## Contributor License Agreement — required

**Before we can merge your pull request, you need to sign a Contributor License Agreement.** It's a one-time signature that covers everything you contribute to BuildDown projects in future.

| You are… | Sign this |
|---|---|
| An individual contributing your own work | [Individual CLA](legal/ICLA.md) |
| Contributing on behalf of an employer, or using employer time or equipment | Your employer signs the [Corporate CLA](legal/CCLA.md), **and** you sign the Individual CLA |

When you open your first PR, the CLA bot will comment with a link. The status check blocks merge until it's signed.

**You keep ownership of your code.** The CLA is a licence, not an assignment — you can keep using, licensing and distributing your contribution however you like, including in competing projects.

**BuildDown gets a broad licence, including the right to relicense.** Section 4 is the part worth reading. It lets us distribute your contribution under a commercial or proprietary licence, change the project's licence in future, offer the project under several licences at once, and include your contribution in paid products and hosted services — without asking again and without paying you. If that's not acceptable, please don't sign and don't contribute.

**Check your employment agreement first.** If you're employed as a developer, it may assign to your employer everything you write — including on your own time and equipment. Section 5.2 of the Individual CLA asks you to represent that you're entitled to grant the licence. If your employer owns your work, we need a Corporate CLA from them instead.

Questions: **[PLACEHOLDER: cla@builddown.ai]**

## Setting up

```bash
git clone https://github.com/BuildDownAI/AI-Implement.git
cd AI-Implement
asdf install                 # or use .nvmrc / .node-version with your Node manager
cp .env.example .env       # fill in LINEAR_CLIENT_ID + LINEAR_CLIENT_SECRET + GitHub App creds for local testing
npm install
npm run dev                # polling + HTTP server on :8080
npm run dev:local          # dev server + local Docker implementation jobs
npm test                   # vitest
npm run typecheck          # tsc --noEmit
```

Node 24 is the supported runtime (see `.tool-versions`, `.nvmrc`, and
`.node-version`). The package uses `better-sqlite3`, a native addon, so install
dependencies with the same Node major used to run the service. If you switch
Node versions after installing dependencies, run `npm ci` or
`npm rebuild better-sqlite3` before starting the app.

`npm run dev:local` first runs `npm run build:runner:local`, which builds
`Dockerfile.session` as `ai-implement-runner:local`. Docker must be running.
Local implementation jobs still create real GitHub branches and PRs.

## Before opening a PR

1. **Tests pass** — `npm test` and `npm run typecheck` are both green.
2. **New functionality has tests** — most modules in `src/` have a sibling `__tests__/` directory; follow that pattern.
3. **Workflow templates aren't broken** — if you change anything in `workflows/` or `.github/workflows/`, lint with `actionlint` if you have it installed.
4. **No secrets, no client-specific data** — the `.gitignore` covers the obvious cases (`.env`, `*.pem`, `*.sqlite`), but double-check before pushing.
5. **Disclose third-party and AI-generated material** — if your contribution includes code under a third-party licence, or was generated in substantial part by an AI system, mark it in the code and say so in the PR description. Sections 5.4 and 5.5 of the CLA. This is a disclosure requirement, not a prohibition.

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

The project is licensed under the **Apache License, Version 2.0** — see [LICENSE](LICENSE).

By contributing, you agree that your contributions are licensed under Apache 2.0, and that BuildDown AI LLC additionally receives the rights set out in the CLA you signed.
