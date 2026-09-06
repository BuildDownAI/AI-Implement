# ADR 013: extend the pipeline by parameter, not by sibling file

**Status:** Accepted

**Date:** 2026-09-06

**References:** AII-489 (dispatched KG refresh), AII-521 (issueless-run lifecycle), AII-543 / AII-549 (live-run fix groups), AII-548 (callback-URL contract), AII-553 (merge race), AII-555 (consolidation), `docs/issueless-runs.md`, `docs/pipeline-architecture.md`

## Context

The dispatched KG refresh (AII-489) was the first run kind that is not keyed to a tracker issue. It was built as a set of files **next to** the implement pipeline's files: a second workflow template (`workflows/claude-kg-refresh.yml`), a second image resolver (`resolveKgRefreshSessionImage`), a second GitHub Actions lifecycle inside the reaper, an inline callback-URL derivation in the entrypoint, and a hand-written YAML parser in a step.

Each of those files re-described behaviour the pipeline already had, and each re-description was wrong in a way only a live run exposed. Between 2026-09-03 and 2026-09-06 the refresh needed eight live runs and fourteen fix issues to reach the snapshot-push step. The seams, in the order found, with what already existed:

| Seam | New code that failed | What already existed |
|---|---|---|
| Backend selection | hard-wired to Fly | `resolveExecutionPath` + the mapping's execution mode |
| Image on Fly | unpaired image, machine exited at boot | the channel tag every run uses; `build-runner.yml` promotion |
| Image on GHA | dispatch omitted `runner_image` | `resolveRunnerImageForDispatch` |
| Phase | template never set `RUNNER_PHASE` | the entrypoint's phase arm and the envelope's `runnerPhase` |
| Progress token | template lacked the input | `claude-implement.yml` declares and masks it |
| Callback URL | envelope carried a path; an inline derivation doubled it | `config.runnerCallbackBaseUrl`, the bare base |
| GHA lifecycle | reaper closed rows; then a second binding path in the reaper | `attachJobRunIdIfMissing` + `monitorGitHubActionsJob` |
| Review rubric | generic reviewer rejected untracked output | the template's "pipeline owns writes" contract |
| Stamp format | validator accepted only `Z` | the ingest's own `isoformat()` stamp |
| Tracker scope | empty team key, then a regex parser | the repo's YAML loader; `sources.yml` |

Two process causes stood behind every row. Issue bodies described behaviour ("read the file", "derive the URL") instead of naming the module to reuse, so the implementer wrote a parallel version. And the reviews that would have caught the parallel version never posted on grouped child PRs, because auto-merge raced the review (AII-471, fixed for initial runs by AII-553).

## Decision

**A new run kind is a parameter of the files the pipeline already has. It is never a sibling file.**

The pipeline's extension points, and the only places a new run kind may add to:

| Subsystem | Extension point | Not this |
|---|---|---|
| Dispatch backend | `resolveExecutionPath(runnerMode, mappingMode)`; the same Fly and GHA dispatch calls the implement path uses | a per-kind backend choice |
| Workflow template | `workflows/claude-implement.yml`, delivered by workflow sync to every mapping; new behaviour is an **optional `workflow_dispatch` input whose default preserves today's run** | a second template, hand-copied |
| Runner image | `resolveRunnerImageForDispatch` for both backends; the channel tag | a per-kind resolver or pinning policy |
| Entrypoint | `session/entrypoint.sh` selects the entry script from `RUNNER_PHASE`, which the template and the machine env set | inline derivation of a value the platform already provides |
| Pipeline definition | `pipelines/<kind>.yml` loaded by `src/pipeline/pipeline-loader.ts`; kind-specific behaviour is a step module under `src/pipeline/steps/` | a second executor or loader |
| Prompt template | `workflows/<KIND>.md` with the same front-matter and substitution rules as `WORKFLOW.md` | a different assembly path |
| Callbacks and tokens | `/runner/result`, progress tokens, `runner_tokens`; the envelope's `runnerCallbackUrl` is the **bare base URL** and every client appends its own path | a per-kind callback shape |
| Lifecycle | one `dispatch_log` row per run; GitHub Actions rows are bound and monitored by the poll loop's lazy bind and `monitorGitHubActionsJob`; Fly rows by the machine monitor and the Fly reaper rules | a per-kind reaper branch or binding loop |
| Deploy interlock | `dispatch_log` in-flight rows hold the deploy | a per-kind hold |
| Parsing | the repo's YAML loader (`src/issue-config.ts`, `src/pipeline/pipeline-loader.ts` pattern) | a regex over YAML |

A run kind is allowed its own **data-path** modules, because the runner never holds a tracker credential (AII-146): for the KG refresh these are the tracker-read and push-credential proxies (`/api/runner/kg-tracker-data`, `/api/runner/kg-push-token`), the `kg-tracker-data` and `kg-snapshot-push` steps, and the rail in `src/kg-refresh.ts`. Those are new capabilities, not re-descriptions.

**What counts as a violation in review.** Any of these in a PR is a finding, whatever the tests say:

1. A second workflow template, or a template that is not in `ALWAYS_SYNC_FILES`.
2. A second image resolver, or an image policy that differs by run kind.
3. A lifecycle branch keyed on the run kind inside the reaper, the monitor, or the dispatch.
4. An inline derivation, in shell or TypeScript, of a value the template, the envelope, or the machine env already provides.
5. A hand parser for a format the repo already loads with a library.
6. A callback URL that carries a path.

**Issue bodies name the anchor.** Every touch in a `## Files` block or a Fix section cites the existing module by path — "reuse `resolveRunnerImageForDispatch` as `dispatchGitHubActions` does" — not the behaviour. A body that says "read", "derive", or "resolve" without a path is not ready to file.

## Alternatives considered

- **Keep sibling files but sync them.** Adding `claude-kg-refresh.yml` to the sync set removes the manual copy and keeps two files that drift. Rejected: the drift is the defect.
- **Make the source-commit image pairing universal.** It would unify the policy at the cost of a registry round-trip on every dispatch, to compensate for a channel promotion that is now verified. Rejected.
- **A generic "run kind" plugin interface.** More surface, and every kind would still need the same ten touches. Rejected: the parameter form already exists in every subsystem above.

## Consequences

- AII-555 removes the second template, the second resolver, the entrypoint derivation, and the reaper's GHA branch, and routes the KG refresh through the shared extension points.
- Any future issueless run kind (previews, migrations, scheduled jobs) starts from the table above. The expected cost is one optional template input, one `pipelines/<kind>.yml`, one prompt template, and the kind's data-path modules.
- The acceptance clause "no implement-path test edits" is the mechanical check that a change added a parameter rather than a sibling.
- The review rail and the driver's smoke both check for the six violations; a green suite does not clear them.
