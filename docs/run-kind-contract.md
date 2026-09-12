# Run-kind contract

Status: **proposed**, 2026-09-08. This page defines one registration per run kind so that adding a kind is one file, not seven seams. It maps the two kinds that exist today onto the contract and lists what the contract deletes. It informs the planning parent that files the change; it does not describe landed code. The current seams are in [run-lifecycle.md](run-lifecycle.md).

## The four parts of a registration

| Part | Question it answers | Today's location |
|---|---|---|
| Pipeline | Which steps run inside the runner | `pipelines/autonomous.yml`, `pipelines/kg-refresh.yml`; wiring in `src/pipeline/pipeline-loader.ts` |
| Dispatch inputs | Which envelope fields the kind needs and which backend runs it | `RunConfigV1.runnerPhase` plus kind-specific fields in `src/run-config.ts`; the dispatch functions in `src/index.ts` |
| Report | What the terminal report carries and what "reported" means | The phase branches of `handleRunnerResult` in `src/runner-callback.ts` |
| Tracker effect | What each terminal outcome does to the issue or to settings | `markPlanComplete`, `markPrReady`, `markImplementationFailed` through `src/providers/`; the kg-refresh branch writes no tracker state |

A registration is one object per kind, in one module, read by the dispatch, callback, reaper, and admin paths. The lifecycle code never branches on the kind's name. It calls the registration.

```typescript
// Shape, not code. The names are illustrative.
interface RunKind {
  name: "implementation" | "planning" | "gap-analysis" | "kg-refresh";
  pipeline: string;                       // pipelines/<file>.yml
  envelope: (input) => RunConfigV1;       // kind-specific fields
  backends: ReadonlyArray<"github-actions" | "fly-machines" | "local-docker">;
  reported: (body) => Terminal;           // outcome, pr, summary, approved
  onTerminal: (terminal, job) => Promise<void>;   // tracker effect
  lossRule?: ReaperRule;                  // only when the default does not apply
}
```

## Today's kinds, expressed in the contract

| Part | implementation (with planning and gap-fill phases) | kg-refresh |
|---|---|---|
| Pipeline | `pipelines/autonomous.yml` | `pipelines/kg-refresh.yml` |
| Dispatch inputs | `issue`, `baseBranch`, `prNumber` for gap-fill, `maxTurns`, `maxIterations`, `sensitiveFiles`, `profiles`, `planningContext`, `groupingParent`, `dependencyTokenScope`, `referenceRepos` | `kgSourceRepo`, a synthetic `issue.id = "kg-refresh"`, `runnerPhase = "kg-refresh"` |
| Backends | all three; Bedrock mappings are GHA-only | default GHA; Fly and local by runner mode; `shadow` collapses to GHA |
| Reported | outcome, `prUrl`, summary, `failureCode`; success with a PR writes `runner_approved` (ADR 014) | outcome and the snapshot commit; the KG refresh rail stages it |
| Tracker effect | planning: `markPlanComplete`; success: `markPrReady`; coded failure: `markImplementationFailed` and bounded cleanup; Done on merge by reconciliation | none; settings stamp and the served snapshot |
| Loss rule | default: monitor conclusion, stuck watchdog, reaper | `kg-refresh-gha-dispatch-lost` in `src/reaper.ts` (AII-545); the deploy hold interlock (AII-518) |

## What the contract deletes

Once kg-refresh is a registration, these leave the lifecycle code:

- The `phase === "kg-refresh"` branch in `src/runner-callback.ts` and the phase switch around it.
- The kg-push token vending (`src/kg-push-token-vending.ts`, `session/git-credential-helper-kg-push.sh`), the one authentication path that differs from a standard run. Staged as AII-583 under AII-555.
- The GHA-specific kg-refresh rule in `src/reaper.ts`, replaced by the kind's `lossRule`, or by the default when the deadline model in ADR 017 lands.
- The `dispatchKgRefreshRun` special cases that exist because the kind has no issue: the synthetic row values in [issueless-runs.md](issueless-runs.md) become the kind's `envelope`.

## Appending an AI task, both ways

Example: a "security review" pass after the implement loop.

| | Today | Under the contract |
|---|---|---|
| Runner side | A step module under `src/pipeline/steps/`, a YAML entry, and an `applyWiring` case in `src/pipeline/pipeline-loader.ts` | The same three; the runner side does not change |
| Lifecycle side | Any seam that learns a new step output: the callback branch if the report shape changes, the admin page if the step is shown | Nothing. The lifecycle reads the registration, and the registration's `reported` already defines the report shape |
| Tests | Step tests plus a live run to see the report flow | Step tests plus the registration's own report test |

The contract does not make the step cheaper. It makes the step's existence invisible to the lifecycle, which is the cost ADR 013 exists to stop growing.

## Relation to ADR 017

A registration is what a workflow engine calls a workflow definition. Writing the registrations first, in our own words, is the prerequisite for moving the lifecycle onto an engine, because the workflow functions then already exist. See [adr/017-move-the-run-lifecycle-onto-a-durable-execution-engine.md](adr/017-move-the-run-lifecycle-onto-a-durable-execution-engine.md).
