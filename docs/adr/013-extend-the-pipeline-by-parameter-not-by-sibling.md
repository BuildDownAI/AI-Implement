# 013. Extend the pipeline by parameter, not by sibling

**Status:** Accepted
**Date:** 2026-09-08

## Context

AII-489 designed the kg-refresh run kind as a dispatched runner job that reuses the existing
execution backends. During build-up (AII-493–521), the kg-refresh pieces were filed as **new
files next to the existing ones** instead of as **parameters of the existing ones**. Each new
file was a place where existing behaviour was re-described by hand, and each re-description was
wrong in a way that only a live run could show. Eight live runs and fourteen issues
(AII-532–534, 538, 541, 543–548, 549–554) were needed to reach the push step.

The six seams where sibling code was introduced instead of parameterising an existing module:

| Seam | Sibling introduced | Module that already existed |
|---|---|---|
| GHA workflow | `workflows/claude-kg-refresh.yml` | `workflows/claude-implement.yml` — accepts `runner_phase` input |
| Runner image on Fly | `resolveKgRefreshSessionImage` with registry round-trip | `resolveRunnerImageForDispatch`, used by implement and planning dispatch |
| Runner image on GHA | dispatch omitted `runner_image` | `resolveRunnerImageForDispatch`, already called by implement dispatch |
| Phase selection | template never set `RUNNER_PHASE` | `session/entrypoint.sh` `case "$RUNNER_PHASE"` + envelope `runnerPhase` |
| Callback URL | inline derivation doubled the path | `config.runnerCallbackBaseUrl`, bare base exported by the implement path |
| Reaper | second GHA lifecycle branch | `attachJobRunIdIfMissing` + `monitorGitHubActionsJob` in the monitor |

Two process causes drove each failure. Issue bodies described the **behaviour** the new code
should have, rather than naming the **module to reuse** — so the implementer wrote a parallel
version (second template, source-commit resolver, inline URL derivation). And the review that
would have caught the sibling pattern never posted on grouped children, because auto-merge raced
the review gate (AII-471, AII-553).

## Decision

**A new run kind extends the pipeline by adding parameters to existing modules, not by creating
sibling files that re-describe the same behaviour.**

Concrete rules:

1. A new GHA dispatch target is an additional `runner_phase` value in `claude-implement.yml`,
   not a second `.yml` template. `claude-implement.yml` is in `ALWAYS_SYNC_FILES` and is
   auto-delivered to every target repo; a second template is not.

2. Runner image resolution for any dispatch path goes through `resolveRunnerImageForDispatch`
   (`src/repo-image.ts`). Per-repo `.ai-implement/image.yml` overrides and explicit
   orchestrator-wide defaults are the only reasons to forward a specific image; the channel tag
   (`latest` / `next`) governs everything else.

3. The entrypoint (`session/entrypoint.sh`) routes new phases via a new `case` arm in the
   existing `$RUNNER_PHASE` switch. A new entrypoint script is a sibling; a new arm is a
   parameter.

4. `runnerCallbackUrl` in the `RunConfigV1` envelope is always the bare base URL
   (`https://host`). Every runner-side client appends its own path. No caller derives the base
   URL inline from another field.

5. GHA run-ID binding and job monitoring go through the existing `attachJobRunIdIfMissing` and
   `monitorGitHubActionsJob` path. A new monitor loop or a new reaper branch for a single phase
   is a sibling; a phase-keyed delegation is a parameter.

6. An issue body that implements this decision names the specific function or file to reuse, not
   the behaviour it should exhibit. This is the only change that fixes the process cause.

Extension points for the shared pipeline, in execution order:

| Extension point | How to add a new phase |
|---|---|
| Workflow dispatch | Add `runner_phase` value to the dispatch body; `claude-implement.yml` already accepts it |
| Image resolution | `resolveRunnerImageForDispatch` — no change needed |
| Entrypoint routing | New `case` arm in `session/entrypoint.sh` `$RUNNER_PHASE` switch |
| Pipeline definition | New file in `pipelines/` — this is legitimately phase-specific |
| Runner callback | Add `if (input.body.phase === "<phase>") { ... return; }` carve-out in `src/runner-callback.ts` before the tracker-write path |
| GHA monitor | Delegate from `monitorGitHubActionsJob` by phase, passing `workflowFile: "claude-implement.yml"` |
| Reaper | Add a phase-specific Fly sweep in `src/reaper.ts`; skip GHA rows (owned by the monitor) |

## Consequences

- **Easier:** each new run kind is a set of parameters on existing machinery rather than a
  parallel copy. Type-checking and the existing test suite catch omissions at the seams where
  the shared code already has coverage.
- **Harder:** the shared modules accumulate optional inputs and phase-conditional branches. A
  module that genuinely needs a different contract — not just a parameter — is legitimately
  phase-specific and belongs in its own file (the kg-refresh state machine, pipeline steps, and
  token-vending endpoints are correct as singletons).
- **Clean-up:** `claude-kg-refresh.yml` and `resolveKgRefreshSessionImage` were removed by
  AII-555. `src/workflow-sync.ts` `REMOVE_FILES` queues deletion of the manually-distributed
  `claude-kg-refresh.yml` from every KG source repo that received it.
- **Checklist for new run kinds:** see `docs/issueless-runs.md` §10.
