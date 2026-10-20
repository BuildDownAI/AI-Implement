# Execution backends

How a run reaches a runner. Three backends (GitHub Actions, Fly Machines, local Docker) and six run kinds each have their own launch path. This page names every path, says what a launch must carry, and points at the test that compares the paths with each other.

A value that one backend path forgets has caused most GitHub Actions incidents (AII-1273, AII-1280, AII-1282, AII-176, AII-551). The launch parity test (below) is the guard.

## The launch paths

Every cell is a real entry point. The test drives it with fakes at the outermost call.

| Run kind | github-actions | fly-machines | local-docker |
|---|---|---|---|
| implementation | `dispatchGitHubActions` (`src/index.ts`) | `dispatchFlyMachine` (`src/index.ts`) | `dispatchLocalDocker` (`src/index.ts`) |
| gap-fill (`/ai-implement` comment) | `drainCommentGapfillQueue` (`src/comment-gapfill-drain.ts`), GitHub Actions branch | same function, Fly branch | same function, local branch, through `dispatchLocalGapfill` (`src/local-gapfill.ts`) |
| planning | `dispatchPlanning` (`src/index.ts`) then `preparePlanningLaunch` (`src/planning-launch.ts`) and `launchPlanningRun` | `dispatchPlanning` then `launchPlanningSession` (`src/planning-launch.ts`) | same as Fly |
| review-fix attempt (Restate pilot) | `GithubReviewFixWorker.launch` (`src/review-fix-worker.ts`); callback tokens from `callbackInputs` (`src/restate/review-fix-production.ts`) | none yet | none yet |
| legacy review-fix queue | `processReviewFixQueue` (`src/index.ts`), runner mode `gha` | none: the queue has no Fly branch | `processReviewFixQueue`, runner mode `local`, through `dispatchLocalGapfill` |
| kg-refresh | `createKgRefreshSenders(...)["github-actions"]` (`src/restate/kg-refresh-senders.ts`) | `["fly-machines"]`, through `launchKeptMachine` (`src/restate/kg-refresh-production.ts`) | `["local-docker"]` |

Fly and local implementation and planning launches share `dispatchSession` (`src/index.ts`), which owns admission and mints the run tokens with `mintLaunchTokens`.

## What a launch carries

### The envelope

The `RunConfigV1` envelope ([workflow-envelope.md](workflow-envelope.md)) rides in `run_config` on GitHub Actions and in `AI_IMPLEMENT_RUN_CONFIG` on Fly and local. Every launch path except kg-refresh builds it with `buildRunConfig` (`src/run-config.ts`): `buildEnvelopeDispatchInputs` (`src/github.ts`), `buildImplRunConfig` (a thin wrapper for Fly and local implementation), the Fly gap-fill branch, the planning session launch, and `buildLaunchInputs` in the review-fix worker. kg-refresh uses `buildKgRefreshRunConfig`. The field rules live in `buildRunConfig`, so a field is set the same way on every backend.

### Run tokens

A run carries up to three tokens: result (`run_token` / `RUN_TOKEN`), progress (`run_progress_token` / `RUN_PROGRESS_TOKEN`) and publication (`run_publication_token` / `RUN_PUBLICATION_TOKEN`). Today's facts:

- Implementation: every backend gets result, progress and publication, minted by `mintLaunchTokens` (`src/runner-tokens.ts`). On GitHub Actions the publication token is sent only when the target workflow supports `run_publication_token`.
- Gap-fill: every backend gets all three, minted once by `mintLaunchTokens` (phase `gap-analysis`). Fly and local send them through the carriers; GitHub Actions sends the publication token only when the target workflow supports `run_publication_token`.
- Planning gets result and progress on every backend, minted by `mintLaunchTokens`. It never pushes, and the vending route refuses a planning publication token (`src/publication-token-vending.ts`).
- Review-fix attempt (GitHub Actions) gets all three from its own attempt-scoped mint (`mintPreparedReviewFixToken`, claims carry an `attemptId`). The legacy queue mints with `mintLaunchTokens` and gets all three on GitHub Actions and local.
- kg-refresh: every backend gets all three from `mintLaunchTokens`, minted inside the `dispatch-N` step and kept in a closure, so no token enters the journal.
- On Fly and local runs the runner prefers the machine nonce for its GitHub token (`src/runner-token.ts`), so the publication token on a Fly or local run is carried but unused until AII-1365. Fly and local runs push with the nonce.

**The rule: the run kind sets the token set, and the backend never does.** `LAUNCH_TOKEN_AUDIENCES` in `src/runner-tokens.ts` is the table, and `mintLaunchTokens` mints a launch's tokens from it after it deletes the unconsumed rows of the dispatch id, so a retried launch step can mint again. A consumed row is kept. Implementation, gap-fill, review-fix and kg-refresh runs carry result, progress and publication. Planning carries result and progress. Every dispatch-scoped mint goes through `mintLaunchTokens`; `mintRunToken` is called only inside `src/runner-tokens.ts`. Each Restate workflow that launches a runner (PlanningRun, KgRefresh, ReviewFixAttempt) has a test that reads the journal while the launch entry still exists and finds no token string in it. Extra Env cannot set `RUN_TOKEN`, `RUN_PROGRESS_TOKEN`, `RUN_PUBLICATION_TOKEN`, `SESSION_TOKEN` or `MACHINE_NONCE` (any case); the project save and the Fly and local launch both refuse them (`isRunCredentialEnvName`).

### The runner image

When the image is fixed: every path uses a moving tag, and in-flight runs keep their image. For the time on each backend and how to confirm it, see [runner-images.md § When a change reaches a run](runner-images.md#when-a-change-reaches-a-run).

The local image is the operator's `LOCAL_RUNNER_IMAGE` (`config.localRunnerImage`, `src/index.ts`). No repository input reaches it, so local Docker has no image check. GitHub Actions and Fly launches are checked against the built-in prefixes plus the Settings row before the launch call ([runner-images.md § Allowlisting](runner-images.md#allowlisting)). The kept Fly machine re-resolves its image at every claim and sends it with the claim's Fly update, except where the update is skipped (already `started` for the same dispatch, or adopting a machine an earlier step attempt created; the image was checked at that earlier attempt) (`launchKeptMachine`, `src/restate/kg-refresh-production.ts`: `updateMachine`, then `startMachine`), and the kg-refresh Fly sender (`src/restate/kg-refresh-senders.ts`) resolves and checks the image on every dispatch, before `launchKeptMachine`, so the check covers both the create and the claim.

## Launch parity test

`src/__tests__/launch-contract-parity.test.ts` checks that every launch path builds its envelope with `buildRunConfig` (kg-refresh: `buildKgRefreshRunConfig`) and runs one cell for each row and column of the table above. Each cell calls the real launch path with fakes at the outermost call and captures the launch payload: the `inputs` given to `postWorkflowDispatch` or `dispatchWorkflow` on GitHub Actions, the machine config given to `createMachine` on Fly, and the input given to `startLocalRunnerContainer` on local Docker. No cell makes a network call: the global `fetch` is a fake that records any call the test did not plan, and the test fails on one.

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

## Ephemeral full access for Codex implementation (AII-1437)

Configured Codex implementation defaults to the pinned CLI's `--dangerously-bypass-approvals-and-sandbox` on eligible ephemeral GitHub-hosted Actions jobs. The default applies to fresh exec, token-expiry resume, initial implementation, manual gap-fill and automatic review-fix (including Restate). No per-project Extra Env flag is required. Planning and review retain their restricted transports. Fly/local and unconfigured runs retain their existing behavior. This is an explicit product policy, never an error-triggered fallback.

| Piece | Where |
|---|---|
| Eligibility | The frozen implementation stage selects Codex on a managed GHA launch. The v2 implementation workflow validates GitHub's actual [`runner.environment`](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts#runner-context) equals `github-hosted` before projecting a full-access policy. Self-hosted, missing and unknown runner classes are refused before model execution, including jobs retargeted through `AI_IMPLEMENT_RUNNER_LABEL`. |
| Legacy opt-in | Existing `AI_IMPLEMENT_EPHEMERAL_FULL_ACCESS=ephemeral-runner-asserted-v1` mapping entries remain accepted for compatibility, but are unnecessary and do not authorize self-hosted execution. No DB migration or mapping rewrite. |
| Transport | `credentials.executionPolicy` in the protected envelope (`{version: 1, implementationSandbox: "ephemeral-full-access", dispatchId, projectKey, backend: "gha", ephemeralRunnerAsserted: true}`), built by `ghaManagedCredentials` only when an implementation-phase writer supplies its marker and the frozen snapshot selects Codex. Planning omits the marker. `validateRunCredentials` requires identity agreement with `modelAuthContext`; only the trusted encoder emits it. Generic encoding, decoding and diagnostics drop it. |
| Capability | The workflow header `# ai-implement-capability: github-hosted-execution-policy-v2` (canonical implementation workflow and mirror) proves support for the hosted-job gate. The old `ephemeral-execution-policy-v1` marker is insufficient. Policy dispatches fail closed with re-sync guidance until the target workflow is updated; planning lacks the capability and rejects the policy. |
| Launch variable | The bootstrap `jq` validates the policy (same dispatch and project as the model-auth context) and exports `AI_IMPLEMENT_EXECUTION_POLICY=v1:ephemeral-full-access:gha:<dispatchId>:<projectKey>` to the Run step only. `prepareConfiguredRun` requires that value, the envelope policy and the trusted grant context to agree on a GHA grant; a present but mismatched variable rejects the run (`execution_policy_invalid`), and so does a blank or absent variable beside an envelope policy (a broken handoff never downgrades to the sandbox the operator replaced). Only the absence of both the policy and the variable keeps the default sandbox. `GITHUB_ACTIONS`, `.ai-implement/config.yml`, the generic `run_config`, a diagnostic `stage` string and any ambient flag are never consulted. The name is in `PROTECTED_BOOTSTRAP_KEYS`, so hook and model children never see it. |
| Executor | `createStageExecutor({ implementationFullAccess })` passes a typed `CodexExecutorOptions.implementationFullAccess` to the `exec` executor only. `CodexExecutor.sandboxArgs` / `resumeSandboxArgs` emit the flag for `agentStage === "implementation"` and nothing else (including the implementation fix passes in the same job). Planning (app-server) and review keep their restrictions. The argv derives from the constructor-held option, so no retry, resume or config rejection can widen or narrow it; a rejected flag surfaces `CODEX_CONFIG_REJECTED`. |
| Admission | Before any auth checkout or spawn, `checkFullAccessAdmission` (`src/pipeline/full-access-admission.ts`) refuses (`CODEX_FULL_ACCESS_REFUSED`) when the model user is root (or the uid is unknown), or can read or write the host Docker socket (`/var/run/docker.sock`, `/run/docker.sock`). The socket merely existing is normal in a GHA container job. Only five fixed booleans (`nonRoot`, `socketPresent`, `socketReadable`, `socketWritable`, `admitted`) are reported, logged on admission as well as on refusal, so the first controlled run leaves inspectable evidence. |
| Fly / local | `buildSessionMachineConfig` and `buildLocalRunnerEnv` throw on the opt-in or launch variable. Fly/durable and local runs have no ephemerality guarantee. |

**Docker socket.** GitHub mounts the host `/var/run/docker.sock` into `container:` jobs. The runner image runs as non-root `coder`; whether `coder` has group access depends on the hosted runner, which this repository cannot prove by inspection. The template does not add privileges (no `chmod`, `sudo` or `--group-add`); the admission check is the control, and the first controlled run records its booleans. If `coder` can reach the socket the run is refused rather than the socket being removed.

**Init requirement.** The implementation job's `container.options` is `--init` (Docker's built-in init; GitHub forwards create flags other than network and entrypoint). Without a reaper as PID 1 the outer container keeps an orphaned grandchild as a zombie, and the executor's unchanged process-group stop check correctly throws `CODEX_RECOVERY_REQUIRED` (`child_not_terminated`). Offline native proof with the actual compiled `CodexExecutor`, Codex 0.159.2 and a synthetic Responses provider (network none, cap-drop ALL, no-new-privileges, read-only root): without `--init` one zombie remained and recovery was required; with `--init` the executor exited 0 with the exact file edit, and termination was confirmed. The earlier GHA TEST-3 run created its container with `--entrypoint tail` and no `--init`, matching the failing configuration; this is offline evidence, not a new live GHA failure. The termination guard is not relaxed.

**Credentials.** The model child gets only the `ModelAuthClient` allowlisted env (selected credential plus exact-name context keys), so the publication token, `GITHUB_TOKEN`/`GH_TOKEN`, callback tokens, the run envelope, `AI_IMPLEMENT_MODEL_AUTH_*`, `AI_IMPLEMENT_EXECUTION_POLICY` and forwarded hook secrets are not inherited (canary tests in `codex-ephemeral-policy.test.ts`). `suspendOriginWriteCredential` strips the tokenized `origin` URL while the child runs; repository publication stays in pipeline steps.

**Residual risk.** Full access trusts all code that runs inside this disposable job. Env filtering is not an isolation boundary: the model runs as the same UID as the runner, so it can read any file or process state that UID can read (including the run's Git and credential files on disk and other processes' environments) and can reach the network. Credentials available to the job can be exposed to it. The policy is justified only by the job being ephemeral, single-tenant and holding no long-lived secret. The default does not apply to self-hosted runners. Keep auto-merge off for the controlled TEST validation.

**Proof levels.** Unit and composition tests (`codex-executor.test.ts`, `codex-ephemeral-policy.test.ts`, `full-access-admission.test.ts`) use the real `createStageExecutor` → `CodexExecutor` → `ModelAuthClient` with only the `codex` child process faked. The native check (pinned Codex 0.159.2 against the synthetic local provider in a disposable workspace, no account) is not a live smoke: with the flag the implementation edit applied; with the default sandbox in that container it did not. A live GHA smoke is a separate step.
