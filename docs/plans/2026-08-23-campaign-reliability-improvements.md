# Campaign Reliability Improvements

**Date:** 2026-08-23
**Status:** Proposed
**Related:** Answer9 ANS-899 through ANS-910 field-link build-up/build-down

## Context

The Answer9 field-link campaign exposed reliability problems that sit in
AI-Implement's orchestration layer, not in the field-link product design alone.
The product decisions were well explored, but implementation runs were hard to
observe, hard to recover exactly, and too willing to create or continue work
after useful warning signs appeared.

This document lists AI-Implement changes that would make the next multi-issue
campaign easier to run down. It does not propose replacing the publication
token model. The push step already refreshes runner GitHub credentials for
Fly/local runs. The remaining work is to audit every external write path and
make point-of-use credential refresh, failure classification, and reporting
consistent across GitHub Actions, ticket callbacks, comments, and PR publication.

## Evidence

- `docs/pipeline-architecture.md` says `preflight` records verification but
  does not gate `push`. It also says `verify` is skipped when there is no
  repo-provided hook.
- `docs/pipeline-architecture.md` says adding a pipeline step without an
  `applyWiring()` case gives that step empty inputs with no hard failure.
- `WORKFLOW.md` for AI-Implement warns that the pipeline records validation
  after review but does not block PR creation on failures.
- `WORKFLOW.md` also warns that normal `typecheck` excludes test files under
  `src/__tests__`, so a green pair of repo commands can still miss new test-file
  type errors.
- `docs/feature-branch-grouping.md` documents fail-open branch resolution: a
  GitHub error while creating a feature branch falls back to the repo base
  branch.
- `src/step-log.ts`, `src/dedup.ts`, and the existing dispatch, step, and runner
  token tables already persist useful operational state. The gap is that these
  records do not yet provide one inspectable recovery identity and branch map.
- `src/pipeline/steps/push.ts` already refreshes runner GitHub credentials before
  remote lookup, push, and PR creation, while `src/linear-app-auth.ts` renews
  cached Linear app tokens early and retries one unauthorized response. The
  campaign failures therefore point to inconsistent coverage and reporting
  across publication paths, not an absent token-refresh mechanism.
- The Answer9 campaign had repeated timeout/retry cycles, duplicate or
  abandoned attempts, feature-branch conflicts after sibling PRs merged, and
  late preview failures that were easier for a human to see than for the
  orchestrator to diagnose from the run state.

## Proposed Changes

### 1. Promote existing logs into durable run checkpoints

Build on `dispatch_log`, `step_log`, and `runner_tokens` so long implementation
runs expose useful state before the final PR step. At minimum, each run should
make these fields durable and available through the admin UI or MCP surface:

- the exact repo, base branch, target branch, and commit it started from;
- the issue identifier, run id, phase, and attempt number;
- the current implementation summary or partial summary;
- the declared files from the issue and the files actually changed so far;
- the last known model result, including turn count and termination reason.

Checkpoint enrichment should be best-effort and must not erase the records that
already exist. If final publication fails, operators should still be able to see
what branch and diff the run reached without reconstructing it from Actions logs.

### 2. Make branch recovery exact

Recovery paths should act on a concrete run record, not only an issue key.
Retrying ANS-902-style work should require the orchestrator to know:

- whether an existing PR branch belongs to this run, a prior attempt, or a
  superseded sibling;
- whether the branch base was the repo default branch or a feature branch;
- whether the attempted PR was opened, closed, merged, or never created;
- which dedup row, dispatch log row, and provider state transition belong
  together.

Duplicate prevention should keep one active attempt per issue and phase unless
the operator explicitly forks a recovery attempt. Removing a dedup row should
unblock dispatch, but it should not erase the last-run recovery context.

### 3. Capture operational context for sibling work

For a grouped campaign, the orchestrator should store a branch map that is easy
to inspect:

| Field | Purpose |
|---|---|
| Issue | The tracker issue that owns the branch or PR |
| Parent | The feature-node or multi-issue parent, if any |
| Base SHA | The commit the run started from |
| Target branch | Where the PR is intended to merge |
| Owned files | Parsed `## Files` entries from the issue or planning output |
| Actual files | Diff files captured at checkpoint or push time |
| State | active, superseded, open PR, merged, failed, parked |

This map should be visible in the admin UI and available through an API so a
build-down can answer "what is this branch based on?" without reading multiple
GitHub Actions logs by hand.

### 4. Make verification repo-aware and fail closed on zero checks

The runner should not infer "no checks configured" from the repository root
alone. The target repo should be able to publish a small verification manifest
or hook that says how to validate the changed surface. For Answer9, the relevant
commands live under `frontend-poc/`, `mcp-server/`, and `packages/mcp-bridge/`.

If a repository declares a verification manifest or hook contract, a run that
changes non-doc files and discovers zero applicable checks should fail closed
with a clear message. AI-Implement may apply the same rule without a repo hook
only when it can confidently classify the changed surface as code. A docs-only
run can declare that explicitly; an unknown surface should be reported as
unknown rather than silently treated as verified.

### 5. Add feature-branch observability and governance

Feature-branch grouping should surface its fail-open cases as first-class
warnings. If branch creation, branch comparison, or ancestor resolution falls
back to the repo base branch, the run should:

- mark the issue with a visible warning;
- include the intended and actual base branch in the run log;
- avoid dispatching siblings that depend on the missing branch until an
  operator decides whether to continue.

This keeps "fail open" available for single issues while making grouped
campaigns less likely to lose their branch topology silently.

### 6. Add stop-the-line signals

The orchestrator should park a campaign or issue after repeated evidence that
the implementation loop is not making useful progress. Good stop signals:

- two consecutive timeout or max-turn exits for the same issue;
- a second recovery attempt that edits the same files without producing a PR;
- a branch-base mismatch inside a feature-node tree;
- zero verification checks for a code-changing run;
- repeated publication failures after useful local work exists.

The stop action should preserve context and tell the operator what to inspect:
last run link, target branch, current diff status, relevant logs, and the
recommended recovery choices.

### 7. Make point-of-use credential handling consistent

Audit every GitHub and Linear external-write path. Preserve the push step's
existing point-of-use refresh behavior and extend the same discipline, where
needed, to GitHub Actions publication, ticket callbacks, comments, and any path
that still uses credentials captured earlier in a long run.

Report credential vending and external-write failures separately from
implementation success. "Code was produced but publication failed" is a
different state from "the agent failed to implement the issue."

## Implementation Anchors

- `src/pipeline/steps/preflight.ts` — root-only command discovery and zero-check
  behavior.
- `src/pipeline/pipeline-loader.ts` — pipeline wiring and hard failure for
  unsupported or unwired steps.
- `src/pipeline/steps/push.ts` — current GitHub credential refresh, push, and PR
  publication behavior.
- `src/feature-branch.ts` — feature-branch selection and fallback behavior.
- `src/dedup.ts` — dispatch, deduplication, recovery, and runner-token state.
- `src/step-log.ts` and `src/runner-result.ts` — durable phase evidence and run
  termination reporting.
- `src/linear-app-auth.ts` — Linear app-token caching, renewal, and retry.
- `src/admin-ui/pages/audit.ts` and `src/admin-ui/pages/pipelines.ts` — operator
  surfaces for checkpoints, topology warnings, and recovery state.

## Sequencing

1. Add run checkpoints and exact branch recovery metadata.
2. Add repo-aware verification manifests or hooks, then fail closed on zero
   applicable checks for code changes.
3. Add feature-branch observability for fallback-to-base and sibling branch
   drift.
4. Add stop-the-line parking for repeated timeouts, duplicate attempts, and
   publication failures.
5. Audit external-write credential paths and make their refresh and failure
   reporting consistent.

This order gives operators better evidence before changing dispatch behavior.

## Acceptance Criteria

- A timed-out run leaves a durable checkpoint that names the issue, attempt,
  base branch, target branch, base SHA, changed files, and termination reason.
- An operator can distinguish active, superseded, failed, and merged attempts
  for the same issue without deleting dedup state.
- A non-doc run covered by a declared verification contract cannot succeed with
  zero applicable checks; an unclassified surface is reported explicitly.
- A feature-node run that falls back to the repo base branch records a visible
  warning before sibling dispatch continues.
- Publication failure after implementation is reported as a publication state,
  not as an implementation failure.
- Existing tests for push-step token vending and Linear app-token caching keep
  passing, and new tests cover every publication path whose credential behavior
  changes.

## Non-Goals

- Do not replace the publication token model.
- Do not block documentation-only runs on application test suites.
- Do not require every target repo to use the same package manager or root
  layout.
- Do not remove feature-branch fail-open behavior for simple leaf issues.
- Do not make AI-Implement decide product decomposition. It should expose
  campaign health and enforce operational safety rails.
