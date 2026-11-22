# ADR 021: reviewers are parameters of one review step

**Status:** Accepted

**Date:** 2026-09-14

**References:** ADR 013, ADR 019, ADR 020, AII-361, AII-651, `src/pipeline/steps/post-push-review.ts`, `src/pipeline/resolve-module.ts`, `src/run-config.ts`

## Context

The post-push step runs exactly one reviewer with one hard-coded prompt. That prompt asks a
merge-readiness question — "check requirements coverage, changed API/data contracts, error
handling, security, regressions, edge cases, and test coverage." The intended job was narrower:
confirm that the diff implements the issue. The step therefore does two jobs with one prompt,
overlaps whatever external reviewer is installed, and offers no way to run one job without the
other. `dedupeIssuesAgainstExternalFindings` exists only because of that overlap.

Clients need their own reviewers. Some run Codex. Some will want a reviewer that knows their
domain. Adding a step module per reviewer would violate ADR 013 — each new module would
re-describe the invoke, retry, verdict-parse and report machinery the step already owns, which
is the drift that cost eight live runs and fourteen fix issues on the KG refresh.

Two homes for reviewer settings are possible, and they pull in opposite directions. Reading
everything from the repository makes a reviewer testable on the branch that writes it. It also
lets a pull request delete `gap-analysis` and `code-review` from its own config and merge
ungated — an outcome an agent told to get a PR green can reach by accident.

Selection by id alone also leaves a gap: a later PR can rewrite the prompt of an already
selected config reviewer to approve itself. Gating authority therefore needs a trusted
definition as well as a trusted selection.

## Decision

**One review step runs a list of reviewers. A reviewer is a definition, not a step.**

A reviewer definition supplies `id`, prompt, output schema, an optional `model`, and an
optional turn cap. Whether it gates belongs to project selection, never to the definition. The step keeps ownership of invocation, retry, verdict parsing, the findings
ledger, and reporting.

Two built-in reviewers replace the single prompt:

| Reviewer | Question it asks | Default |
|---|---|---|
| `gap-analysis` | Does the diff implement every acceptance criterion in the issue? | On and gating |
| `code-review` | Does the diff contain defects, security faults, or test gaps? | On and gating |

`gap-analysis` emits one kind of finding: a requirement in the issue with no implementation in
the diff. It never reports style, defects, or test gaps. A repository turns `code-review` off
only when it has a trusted external reviewer that emits the contract of ADR 020.

**Reviewer settings live in two homes, split by what a pull request may change.**

| Concern | Home | Reason |
|---|---|---|
| Which reviewers run, and which gate | Project settings, carried in `RunConfigV1` | Orchestrator-side. A pull request cannot reach it. |
| Gating config definitions — id, prompt, optional model | `.ai-implement/config.yml` from the repository's default branch, fetched through the forge API | A PR cannot rewrite the definition used to judge itself. The runner supplies the fixed output schema. |
| Advisory config definitions — id, prompt, optional model | `.ai-implement/config.yml` on the current branch | Version-controlled, reviewable in the pull request, testable on the branch that writes it. |

A reviewer defined on a branch but not selected in project settings still runs, as advisory.
A selected config reviewer with `gates: true` uses a snapshot of its default-branch definition
for the run. Missing or unreadable trusted definitions fail closed; the branch definition is
never a fallback for the gate. The snapshot is fetched independently of the workspace and
survives deletion or modification of that reviewer's branch declaration.

When a PR changes a selected gating reviewer's prompt or model, both versions run: the trusted
default-branch version gates, and the changed branch version is an advisory preview. Identical
definitions run once. Preview findings and failures remain advisory even though they share
the selected reviewer's logical id, and their reports identify which version ran. A selected
reviewer with `gates: false` uses the branch definition without an additional gating run.

After a reviewer edit merges into the default branch, subsequent runs use the updated
definition for gating. A new reviewer is testable as advisory before it is merged and selected.
A branch can neither grant gating authority nor replace or remove the definition of its gate.

A config-declared reviewer carries **data only** — no code — so it resolves after the clone
step. A `custom/reviewers/<id>.ts` module carries code and stays image-baked. Selected
reviewer code resolves through the trusted reviewer resolver, whose custom root is derived
from the runner package's `import.meta.url`, never from the checked-out repository's cwd.
`custom/steps/<id>.ts` keeps the normal workspace-first `resolveModuleImport` behavior.

## Alternatives considered

- **One step module per reviewer.** Rejected by ADR 013: siblings re-describe the step's
  machinery and drift. It also makes "define a reviewer" mean "write a `StepModule`".
- **Read reviewer selection from the branch.** Rejected: a pull request could delete its own
  gating reviewers. The failure is silent — the PR merges and the gate simply did not run.
- **Read reviewer definitions from the default branch only.** Rejected: a new reviewer could
  not be tested until it was merged. Default-branch definitions supply gating runs while
  current-branch definitions remain testable as advisory previews.
- **Use current-branch definitions after selecting their ids.** Rejected: selection protects
  the name, but a PR can replace the selected prompt with instructions to approve itself.
- **Select reviewers with Jira `run_config.profiles`.** Deferred. Profiles remain unused. Project
  settings already reach every tracker; profiles reach only Jira.
- **Replace the in-loop reviewer too.** Deferred. It is uncapped and runs inside the feedback
  loop. Changing both machineries in one change doubles the blast radius on the merge gate.

## Consequences

- The default selection runs both internal reviewers as gating reviewers. Project settings may
  select advisory reviewers with `gates: false`. An empty selection or an unresolved selected
  reviewer fails closed. The external check wait remains unchanged; the default internal
  selection supplies review coverage even when no external review workflow is present.
- Reviewer cost is now per reviewer. Each carries its own `reviewMaxTurns`; one shared cap would
  let a long code review starve a short gap analysis. Changed config definitions can add one
  advisory preview invocation per reviewer; identical definitions do not duplicate the cost.
- A fix pass addresses the whole findings ledger at once, ordered gap-analysis first, because a
  missing requirement changes the diff the code review then judges.
- The trusted/current-branch split lets authors inspect new review behavior without changing
  the gate evaluating that PR. Reports distinguish the gating run from its advisory preview.
- AII-361 asks for delegation in `custom/` rather than whole-module replacement. A reviewer
  definition is that shape, on one surface.
