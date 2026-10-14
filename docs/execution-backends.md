# Execution backends

How a run reaches a runner. Three backends (GitHub Actions, Fly Machines, local Docker) and six run kinds each have their own launch path. This page names every path, says what a launch must carry, and points at the test that compares the paths with each other.

A value that one backend path forgets has caused most GitHub Actions incidents (AII-1273, AII-1280, AII-1282, AII-176, AII-551). The launch parity test (below) is the guard.

## The launch paths

Every cell is a real entry point. The test drives it with fakes at the outermost call.

| Run kind | github-actions | fly-machines | local-docker |
|---|---|---|---|
| implementation | `dispatchGitHubActions` (`src/index.ts:1112`) | `dispatchFlyMachine` (`src/index.ts:1795`) | `dispatchLocalDocker` (`src/index.ts:1930`) |
| gap-fill (`/ai-implement` comment) | `drainCommentGapfillQueue` (`src/comment-gapfill-drain.ts:185`), GitHub Actions branch | same function, Fly branch | same function, local branch, through `dispatchLocalGapfill` (`src/local-gapfill.ts:41`) |
| planning | `dispatchPlanning` (`src/index.ts:1456`) then `preparePlanningLaunch` (`src/planning-launch.ts:47`) and `launchPlanningRun` | `dispatchPlanning` then `launchPlanningSession` (`src/planning-launch.ts:303`) | same as Fly |
| review-fix attempt (Restate pilot) | `GithubReviewFixWorker.launch` (`src/review-fix-worker.ts:485`); callback tokens from `callbackInputs` (`src/restate/review-fix-production.ts:177`) | none yet | none yet |
| legacy review-fix queue | `processReviewFixQueue` (`src/index.ts:3500`), runner mode `gha` | none: the queue has no Fly branch | `processReviewFixQueue`, runner mode `local`, through `dispatchLocalGapfill` |
| kg-refresh | `createKgRefreshSenders(...)["github-actions"]` (`src/restate/kg-refresh-senders.ts:51`) | `["fly-machines"]`, through `launchKeptMachine` (`src/restate/kg-refresh-production.ts:128`) | `["local-docker"]` |

Fly and local implementation and planning launches share `dispatchSession` (`src/index.ts:1616`), which owns admission and mints the result token.

## What a launch carries

### The envelope

The `RunConfigV1` envelope ([workflow-envelope.md](workflow-envelope.md)) rides in `run_config` on GitHub Actions and in `AI_IMPLEMENT_RUN_CONFIG` on Fly and local. Three builders make it today: `buildEnvelopeDispatchInputs` (`src/github.ts:433`), `buildImplRunConfig` (`src/run-config.ts:147`) and `buildKgRefreshRunConfig` (`src/run-config.ts:190`). Three paths write the literal by hand: the Fly gap-fill branch, the planning session launch, and `buildLaunchInputs` in the review-fix worker. A field that one builder sets and another forgets is a parity gap.

### Run tokens

A run carries up to three tokens: result (`run_token` / `RUN_TOKEN`), progress (`run_progress_token` / `RUN_PROGRESS_TOKEN`) and publication (`run_publication_token` / `RUN_PUBLICATION_TOKEN`). Today's facts:

- Implementation: GitHub Actions gets result, progress and publication. Fly and local get only the result token.
- Gap-fill: GitHub Actions gets all three. Local gets result and progress. Fly gets only the result token, so a Fly gap-fill run has no progress token.
- Planning gets only the result token on every backend. It never pushes, and the vending route refuses a planning publication token (`src/publication-token-vending.ts:62`).
- Review-fix attempt (GitHub Actions) and the legacy queue on GitHub Actions get all three. The legacy queue on local gets result and progress.
- kg-refresh: GitHub Actions gets all three. Fly and local get result and progress.
- Fly and local runs get no publication token. They push with the machine nonce: the runner prefers the nonce for its GitHub token (`src/runner-token.ts:81`).

**The rule this branch makes true: the run kind sets the token set, and the backend never does.** Implementation, gap-fill, review-fix and kg-refresh runs carry result, progress and publication. Planning carries result and progress. Each row in the gap list below that names a `token:` check is a place where today's code breaks this rule.

### The runner image

When the image is fixed: every path uses a moving tag, and in-flight runs keep their image. For the time on each backend and how to confirm it, see [runner-images.md § When a change reaches a run](runner-images.md#when-a-change-reaches-a-run).

The local image is the operator's `LOCAL_RUNNER_IMAGE` (`config.localRunnerImage`, `src/index.ts:329`). No repository input reaches it, so local Docker has no image check. The kept Fly machine re-resolves its image at every claim (`launchKeptMachine`, `src/restate/kg-refresh-production.ts:183-201`), so a check on the kg-refresh Fly path must cover the claim, not only the create.

## Launch parity test

`src/__tests__/launch-contract-parity.test.ts` runs one cell for each row and column of the table above. Each cell calls the real launch path with fakes at the outermost call and captures the launch payload: the `inputs` given to `postWorkflowDispatch` or `dispatchWorkflow` on GitHub Actions, the machine config given to `createMachine` on Fly, and the input given to `startLocalRunnerContainer` on local Docker. No cell makes a network call: the global `fetch` is a fake that records any call the test did not plan, and the test fails on one.

Every cell runs three checks:

| Check | Passes when |
|---|---|
| `envelope:<key>` | The decoded envelope has the same value for `<key>` as the GitHub Actions cell of the same run kind. The review-fix attempt has no peer on another backend: it is compared with the legacy review-fix GitHub Actions cell, except `issue`, `commentInstruction` and `reviewFix`. |
| `token:<audience>` | The set of tokens that reach the carrier as non-empty strings equals the set the run kind expects. |
| `image` | With `.ai-implement/image.yml` naming an image that is not allowed, the path makes no launch call. Local Docker cells are out of scope. |

### The known-gaps rule

Today's gaps are data. `KNOWN_GAPS` in the test lists one row for each check that fails today, with the run kind and the backend. For each cell, the set of failing checks must equal the set of rows for that cell. A check that fails and has no row fails the test. A row whose check passes fails the test too, so the list cannot go stale.

A change that closes a gap deletes its rows in the same pull request. Do not add a row to make a new failure pass: the failure is the bug.

Cells that are not run (review-fix attempt on Fly and local, the legacy queue on Fly) are listed in the test as data, each with its reason, and a test checks that every run kind and backend pair is a cell or is listed.
