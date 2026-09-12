# 016. Run credentials stop at the process boundary

**Status:** Proposed
**Date:** 2026-09-08
**References:** AII-567, AII-588, AII-396 (`src/pipeline/process-env.ts`), AII-458 and AII-462 (forwarded secrets), ADR 009, ADR 015, `docs/runner-callbacks.md`

## Context

The runner container receives `RUN_TOKEN`, `RUN_PROGRESS_TOKEN`, `RUN_PUBLICATION_TOKEN`, and the callback URL in its environment. `src/pipeline/process-env.ts` builds two child environments. `modelProcessEnv()` strips the run tokens, so the model process and everything it spawns cannot reach them (AII-396, 2026-09-02). `repoProcessEnv()` strips only the model credentials, so every repository-owned process keeps the run tokens: `install`, the `setup`, `verify`, and `teardown` hooks, and `preflight`, which runs the repository's `typecheck`, `lint`, and `test` scripts.

The AII-567 test suite ran under `preflight`. It held the run's result token because the process that ran it was allowed to. The forwarded-secrets work (AII-458, AII-462) already established the pattern: a value that only the pipeline needs is removed from every child environment, and the pipeline reads it from its own `process.env`.

One repository-side process does read a run credential today. The dependency credential helper (`session/git-credential-helper.sh`, installed by `src/pipeline/steps/dependency-auth.ts`) reads its GitHub token from a mode-0600 cache file the pipeline writes, and reads `RUN_PROGRESS_TOKEN` from the environment only to re-mint that token when it has under ten minutes left.

## Decision

The pipeline reads the run credentials once, at start, into memory. No repository-owned process receives them.

- `repoProcessEnv()` strips `RUNNER_CREDENTIAL_KEYS` (`RUN_TOKEN`, `RUN_PROGRESS_TOKEN`, `RUN_PUBLICATION_TOKEN`), exactly as `modelProcessEnv()` does today.
- Pipeline steps that need a credential keep reading it from `process.env` in the pipeline process, the pattern `dependency-auth` already documents in `docs/pipeline-architecture.md`.
- The dependency credential helper keeps reading the GitHub token from the cache file. Its re-mint path moves into the pipeline: the pipeline refreshes the cache file on a timer for the life of the run, and the helper never sees `RUN_PROGRESS_TOKEN`.
- The kg-push helper (`session/git-credential-helper-kg-push.sh`) is unaffected: it runs inside the kg-refresh pipeline's own git commands, and AII-583 deletes it.
- The test-suite disarm (AII-588) stays. It protects a run against a repository that is not this one and has not adopted this boundary yet.

## Alternatives considered

- **Disarm tests only.** Necessary, not sufficient. It protects one suite in one repository. Any hook, script, or tool a target repository runs under `preflight` still holds the run's authority.
- **A runner-side "am I in a test" guard.** Rejected in PR #467: a test-only branch in production code, and the throwing variant lands in the same `catch` that posts again.
- **Keep `RUN_PROGRESS_TOKEN` in repository processes for the credential helper.** Rejected. It keeps a live bearer credential in every hook and test process to serve one re-mint path that the pipeline can serve itself.
- **A separate, narrowly scoped token for repository processes.** Not needed today: no hook or test has a legitimate reason to call the orchestrator. Revisit if one appears.

## Consequences

Easier: a repository process cannot report, cannot mint tokens, and cannot burn anything, whatever code it runs. With ADR 015 the stray call is harmless; with this ADR it is impossible from repository code.

Harder: a hook that wanted to call the orchestrator has no credential. None does today. The dependency helper's re-mint moves into the pipeline, which is a small change in `dependency-auth` and the helper script. A target repository that depends on the old behavior would fail its private dependency install after ten minutes; the cache-file refresh is what prevents that, and it ships in the same change.

Follow-on: the test for this boundary is a listener counting `POST /runner/result` during a full `preflight` run of a suite that tries to post. Expected count: zero.
