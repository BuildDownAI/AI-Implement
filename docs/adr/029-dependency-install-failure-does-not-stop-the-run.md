# 029. Dependency install failure does not stop the run

**Status:** Accepted
**Date:** 2026-09-25
**References:** AII-823 (feature parent), AII-825, AII-826, AII-827, AII-828

## Context

Before this project, a failed `npm ci` / `yarn install --frozen-lockfile` / `pnpm install --frozen-lockfile`
threw inside the `install` step and ended the run immediately — before the agent ever saw the issue. A
lockfile drift, a transient registry outage, or a private-registry credential that only a `setup` hook can
supply all produced the identical outcome: no implementation attempt, no PR, and a ticket comment that gave
the operator nothing to act on beyond "install failed."

A repository could sit broken this way for weeks with nobody noticing, because a failed run before this
looked the same on the ticket as any other early-exit failure.

## Decision

1. **Install failure is non-fatal.** `installStep` (`src/pipeline/steps/install.ts`) never throws on a
   failed command or a spawn error; it resolves `installFailed: true` and a redacted, capped
   `installError` tail instead, and the pipeline continues into `setup` and the feedback loop without
   `node_modules`.
2. **One retry, after the agent.** `install-retry` (`pipelines/autonomous.yml`, wired in
   `src/pipeline/pipeline-loader.ts`) reruns the same `install` module with `retry: true`, skipped unless
   the first attempt's `installFailed` output was `true`. It reuses the first attempt's `packageManager`
   and runs after `setup` and `feedback-loop`, so a `setup` hook that supplies a missing credential (a
   private-registry `NPM_TOKEN`, for example) can fix the second attempt even though it could not fix the
   first.
3. **`INSTALL_FAILED` withholds the approval mark.** `dependenciesMissing` (`src/pipeline/pipeline-loader.ts`)
   is `true` only when both the first `install` and `install-retry` report `installFailed: true`. When it
   is, `preflight`, `verify`, and `post-push-review` skip — their checks would fail for a reason unrelated
   to the change — and `push` still opens or updates the PR, but as a draft. The run reports the coded
   failure `INSTALL_FAILED` instead of success, which withholds the `runner_approved` mark a feature-branch
   child PR needs to auto-merge, and the GHA job exits 0 with a `::warning::` so the ticket updates without
   failing the workflow.
4. **Visibility travels with the result, not just the log.** The PR body built for an initial run
   (`buildPullRequestBody`, `src/pipeline/steps/push.ts`) leads with a `## ⚠️ Dependencies did not install`
   section when both attempts failed — naming the `installMethod` and the retry's `installError` — or a
   one-line `Test plan` note when the retry recovered. `install-retry` also writes
   `ai-output/comments/70-dependency-install.md`, which `collectRunnerComments` posts to the issue for
   both outcomes, so a gap-fill run (which never rebuilds the PR body) still reports the result where the
   operator is already looking.

## Alternatives considered

- **An `installArgs` config key**, to let a repo pass extra flags (`--legacy-peer-deps`) to the built-in
  install. Rejected: `.ai-implement/config.yml` is read from the checked-out workspace, which on a
  gap-fill run is the PR head — a key that changes how the install command executes would have to come
  from the default branch instead, to keep a PR from picking its own install behavior. It would also hide
  the escape hatch for good: a repo that needs unusual flags already has one (see below).
- **A pre-install hook**, run before the built-in `install` step so a repo could prepare the environment
  first. Rejected: the only thing that must exist before install is credentials, and `dependency-auth`
  already covers that. Flags and alternate invocations can be applied by disabling the built-in install
  (`packageManager: none`) and installing again from `setup`. Reconsider if a third need for
  before-install customization shows up that neither rail covers.
- **A new `FailureRecord` category** for install failures, to fit `INSTALL_FAILED` into the same taxonomy
  as `classifyGitFailure`'s output. Rejected: `FailureCategory` (`src/pipeline/failure-classification.ts`)
  is closed on purpose because the retry rails switch on it, and a successful run carries no
  `FailureRecord` at all. `INSTALL_FAILED` is a guardrail/policy outcome reported directly as a
  `failureCode` — the same family as `REVIEW_UNAPPROVED`, `MAX_TURNS_EXHAUSTED`, and
  `SENSITIVE_FILES_BLOCKED` — not a classified failure, so it does not belong in that list.

## Consequences

- Easier: a broken install no longer burns an implementation attempt for nothing, and a fixable cause
  (missing registry credential, a lockfile a `setup` hook can regenerate) gets a real second chance before
  the run gives up on verification.
- Easier: the PR body, the issue comment, and the `INSTALL_FAILED` ticket update all say the same thing,
  so an operator does not have to open the run log to learn why a PR shipped unverified.
- Harder: a run that reports `INSTALL_FAILED` is unverified by construction — build, lint, typecheck, and
  tests never ran — so a human must review it by hand, and it cannot auto-merge as part of a feature-branch
  cascade.
- Follow-on: an admin-UI badge surfacing runs with failed installs (beyond the PR and the issue comment)
  is out of scope here; file it separately if those two surfaces prove insufficient.
