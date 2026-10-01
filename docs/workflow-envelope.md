# Workflow Envelope Contract (`run_config`)

Reference for the `RunConfigV1` envelope that the orchestrator sends to `claude-implement.yml` (and `claude-plan.yml`) via the `run_config` workflow_dispatch input.

---

## Background

Prior to the envelope, the orchestrator sent each field (issue ID, title, description, caps, branch prefix, …) as a separate `workflow_dispatch` input. As the feature set grew, GitHub's "unexpected inputs" rejection became a constant migration hazard: adding any new input required target repos to re-sync before the orchestrator could use it.

The envelope consolidates all YAML-safe data into a single base64-encoded JSON blob. Only fields that the GHA workflow must handle before handing off to the runner (tokens to mask, provider routing, image selection, timeout) remain as top-level inputs.

---

## 9-Input Implementation Contract

A top-level `workflow_dispatch` input is reserved for a value GitHub must evaluate before any step runs (routing, image selection, timeout) or a secret this workflow has to mask; every other per-run value rides inside `run_config` instead of growing the input list. `issue_identifier` is the one deliberate exception: it carries no data the runner needs — `run_config.issue.identifier` is authoritative — but `run-name:` is itself a value GitHub evaluates before any step runs, and a `run-name:` expression cannot decode `run_config`, so the ticket key has to duplicate onto a plain top-level input for the run list to show it. `claude-implement.yml` (post-envelope generation) exposes exactly these nine `workflow_dispatch` inputs:

| Input | Required | Type | Notes |
|-------|----------|------|-------|
| `run_config` | **Yes** | string | Base64-encoded `RunConfigV1` JSON — all issue data and per-project config |
| `issue_identifier` | No | string | Display-only duplicate of `run_config.issue.identifier`, read solely by `run-name:` to title the Actions run with the ticket key; no step reads it |
| `runner_image` | No | string | Container image override; allowlist-validated against `ghcr.io/builddownai/`, the repo owner's namespace, and `AI_IMPLEMENT_ALLOWED_RUNNER_IMAGE_PREFIXES` |
| `job_timeout_minutes` | No | string | GHA `timeout-minutes` for the implement job; empty defaults to 90 |
| `provider` | No | string | `anthropic` (default) or `bedrock` — determines auth path before the runner starts |
| `aws_region` | No | string | Required when `provider=bedrock`; passed to `configure-aws-credentials` before the container runs |
| `run_token` | No | string | HMAC bearer token for result callback to the orchestrator; empty skips callback. **Masked by the workflow before the runner starts.** |
| `run_progress_token` | No | string | HMAC bearer token for in-progress callbacks; empty skips progress posts. **Masked.** |
| `run_publication_token` | No | string | Dedicated, single-use bearer token that may be exchanged immediately before repository publication for a fresh repo-scoped GitHub credential. **Masked. Implementation and gap-analysis only.** |

The three runner tokens remain separate inputs under the current dispatch contract (a private `credentials` namespace, when present, supersedes them at the runner; see AII-1000 below); the envelope remains secret-free. The first container-job step reads the token values from GitHub's `GITHUB_EVENT_PATH` event file and registers `::add-mask::` commands before any diagnostics or credential consumers run. It has no token-valued `env:` entries or input interpolation in its script: GitHub prints both script and environment headers before executing the step, so either would expose values before masking. Later runner steps retain their token environment mappings after masks are registered. Mask command data escapes percent signs and line endings; malformed event data fails the bootstrap before consumers run. The publication token remains restricted to the pipeline process and is never forwarded to model child processes or persisted step inputs.

These are live credentials in the runner's environment; `src/__tests__/setup/clear-runner-credentials.ts` (registered as a Vitest `setupFile`) deletes all five credential variables before every test so no suite can burn a single-use token against the live orchestrator. A test that needs a credential value may set it in the test body — the global `beforeEach` ensures it is cleared again before the next test. Tests that exercise callback or fetch paths should inject a mock `fetchImpl` (or equivalent dependency-injection point) rather than letting code reach a live URL.

Headroom note: GitHub caps `workflow_dispatch` at 10 inputs; 9 of 10 used; one slot free. That ceiling is part of why the envelope exists; a new field must ride inside `run_config` unless the workflow itself has to read it before the runner starts (masking, routing), in which case an existing input has to make room. `claude-plan.yml` declares eight of these (no `run_publication_token`).

The first step of the container job prints every input (`[dispatch-inputs] …`), with the three tokens reduced to `<redacted>`/`(empty)` and `run_config` shown as the credential-free diagnostic projection (see "Workflow bootstrap and capability"). `provider` and `aws_region` are also forwarded into the entrypoint env as `PROVIDER`/`AWS_REGION`: the runner reads the provider from env, not from the envelope, so a template that drops them silently downgrades Bedrock repos to the anthropic provider.

---

## Compatibility with older templates

Every current dispatch site builds inputs through `buildEnvelopeDispatchInputs`, which never sets `runner_phase` or `runner_callback_url` — both values ride inside `run_config` instead. The one exception is the kg-refresh GHA dispatch (`dispatchKgRefreshRun` in `src/index.ts`, via `buildKgRefreshGhaDispatchBody` in `src/github.ts`), which still sends both top-level, because the AII-556-era template defaults `runner_phase` to `implementation` when the input is omitted — an omitted input on that template would run a KG refresh as an implementation.

GitHub rejects a `workflow_dispatch` naming an input the target workflow doesn't declare (422 `Unexpected inputs provided: [...]`). A target repo adopts a new template shape only when it merges a sync PR, so the orchestrator cannot assume every repo has re-synced. `src/github.ts` declares:

```typescript
const ENVELOPE_OPTIONAL_INPUTS = ["runner_phase", "runner_callback_url", "issue_identifier"] as const;
```

— inputs an older template declares and a newer one does not, because a newer template reads their values from `run_config` (AII-653), or a value a newer template declares but an older one predates (`issue_identifier`, AII-656). The shared poster, `postWorkflowDispatch`, strips-and-retries on a 422: when the response is HTTP 422, the body matches `/unexpected inputs/i`, and names — by exact match against the rejection's quoted input list, never by substring — at least one `ENVELOPE_OPTIONAL_INPUTS` member that is present in the dispatch's `inputs` — **and only when `inputs.run_config` is a non-empty string** — it strips exactly the named members and posts once more, logging `[dispatch] <owner>/<repo>/<file> does not declare <names> (re-sync workflows); retrying without`. Exact matching matters because a rejection naming an unrelated input that happens to contain `runner_phase` as a substring (e.g. a hypothetical `runner_phase_extra`) must not be mistaken for a match; the poster parses the rejection's quoted tokens (handling both the bare-text and GitHub's escaped-JSON error shapes) and checks set membership, not `body.includes(name)`.

The `run_config` guard matters: on the legacy (non-envelope) contract, `runner_phase`, `runner_callback_url`, and `issue_identifier` are authoritative issue data, not compatibility duplicates — the legacy `dispatchWorkflow` callers in `src/index.ts` never set `run_config`, so they are excluded from the strip without a separate flag. Stripping them there would run a gap-fill as an implementation (or drop the real ticket key). The guard requires *non-empty* — `run_config: ""` does not count as "the caller is on the envelope contract."

The retry is **capped at exactly two requests, by construction, not just by the common case where removing a name works**: the poster sends the first request, and if that 422s in a strippable way it sends exactly one more — whatever that second response says (success, a different 422, the same 422 again) is returned unconditionally, with no further request. This matters because a target repo's second 422 can legitimately name a *different* still-present optional input than the first did (e.g. reject `runner_phase` first, then `runner_callback_url`); naively recursing on "does the response still match a strippable name" would chain a third request in that case. Both `dispatchWorkflow` (the thin wrapper most dispatch sites use) and the kg-refresh dispatch path go through `postWorkflowDispatch`.

---

## Dispatch outcomes and `returnRunDetails`

`postDispatchOnce`, the function inside `postWorkflowDispatch`/`dispatchWorkflow` that actually posts one `workflow_dispatch` request, accepts an opt-in `returnRunDetails?: boolean` option (AII-778, default off). Every existing call site — `dispatchWorkflow`'s implementation, gap-analysis, and planning dispatches; the review-fix re-dispatch; the kg-refresh GHA dispatch — leaves it unset today, so nothing in this repo yet requests or reads the fields below. The option exists as wire-contract plumbing for a consumer (the Restate review-fix pilot) that has not landed.

Setting `returnRunDetails: true`:

- Adds `return_run_details: true` to the POST body sent to GitHub's `workflow_dispatch` endpoint.
- Populates a new `outcome: DispatchOutcome` field on `DispatchResult`, and — only when the response is a repo-validated `200` — `runId`/`runUrl`.

```typescript
export type DispatchOutcome = "accepted" | "rejected" | "unknown";

export interface DispatchResult {
  success: boolean;
  status: number;
  error?: string;
  outcome?: DispatchOutcome;   // only set when returnRunDetails: true
  runId?: number;              // only set for a repo-validated 200
  runUrl?: string;             // only set for a repo-validated 200
}
```

`outcome` reflects an identity-trust judgment, not just the HTTP status:

| Response | `outcome` | `runId`/`runUrl` | Why |
|---|---|---|---|
| `204` | `accepted` | absent | GitHub queued the dispatch. `workflow_dispatch` never returns a run id on a plain 204 — there is no exact identity to report, only "this plausibly started." |
| `200`, body validates against the requested repo | `accepted` | present | `extractDispatchRunIdentity` requires `html_url` to match `https://github.com/{owner}/{repo}/actions/runs/{id}` and, if the body also carries a `repository` field (string or `{full_name}`), that it names the same `owner/repo`. Either signal disagreeing — or missing/malformed entirely — is treated as unresolved, not trusted; GitHub's `return_run_details` response shape isn't documented, so parsing stays tolerant of fields it doesn't recognise and strict only about the ones that prove repo ownership. |
| `200`, unparseable or repo-mismatched body | `unknown` | absent | Same reasoning as above, on the failing side. |
| `4xx` | `rejected` | absent | A definite application-level refusal — safe to treat as "did not happen." |
| `5xx`, or any other unrecognised status | `unknown` | absent | GitHub may have started the run before failing to report it cleanly; not safe to assume either accepted or rejected. |
| transport failure (`fetch` throws) | `unknown` (only if `returnRunDetails: true`) | absent | See legacy behavior below — the identical failure is a thrown error for a caller that did not opt in. |

The three-way split matters to a caller trying to avoid a duplicate dispatch: `rejected` is safe to retry (GitHub is certain nothing started), `accepted` needs no retry, and `unknown` is neither — a transport failure or 5xx must not be blindly retried, because GitHub may have already started the run.

**Legacy callers are unchanged, byte-for-byte.** A caller that does not pass `returnRunDetails` gets exactly the pre-AII-778 `DispatchResult` shape (`success`/`status`/`error`, no `outcome`/`runId`/`runUrl`) and the pre-AII-778 throw-on-transport-failure behavior: `postDispatchOnce` only catches and converts a `fetch` rejection into `{ outcome: "unknown", ... }` when `returnRunDetails` is set; otherwise the rejection propagates exactly as it always did. This is deliberate (AII-778's compatibility constraint) — opting in to run-detail reporting must never change behavior for a caller that didn't ask for it.

**`findWorkflowRunId` stays, but only as legacy identity — the pilot must not treat it as exact.** The existing post-dispatch heuristic (`src/github.ts`) scans the workflow's recent-runs list for a run created at or after the dispatch time, on the expected branch, optionally disambiguated by `display_title` against `issueIdentifier` — because `workflow_dispatch` alone never returns a run id, this scan is how every legacy (non-pilot) caller resolves one today, and `returnRunDetails` changes nothing there: a legacy caller doesn't pass it and keeps using the heuristic exactly as before.

The Restate review-fix pilot is held to a stricter rule: a title/time-window match is never exact execution identity, so the pilot must not fall back to `findWorkflowRunId` to manufacture one. A `200` with a validated body (`runId`/`runUrl`) *is* exact identity, and needs no heuristic. A `204` — the common case — is accepted but carries no identity at all; that is not a signal to guess via the heuristic, and it is not a signal to blindly repeat the POST (GitHub may have already started the run, and a second dispatch would duplicate it). Instead the pilot holds the attempt's occupancy and reconciles by exact attempt/execution identity — correlating the run that reports back against `run_config.reviewFix.attemptId` — until that resolves or the attempt's `deadlineAt` passes. This constraint is specific to the pilot; every other dispatch/monitor path (gap-analysis, planning, `src/monitor-gha.ts`, the GHA polling in `src/index.ts`) is unaffected and keeps resolving run identity via the heuristic as before.

---

## `RunConfigV1` Schema

The envelope is decoded by `src/run-config.ts` (`decodeRunConfig`). Unknown fields are stripped on decode. The `v: 1` discriminant is validated; any other value throws immediately.

```typescript
interface RunConfigV1 {
  v: 1;
  issue: { id: string; identifier: string; title: string; description: string };
  prNumber?: string;
  baseBranch?: string;
  runnerPhase?: "implementation" | "gap-analysis" | "planning" | "kg-refresh";
  branchPrefix?: string;
  skillsRepo?: string;
  runnerCallbackUrl?: string;
  maxTurns?: number;
  maxIterations?: number;
  commentInstruction?: string;
  sensitiveFiles?: { add?: string[]; allow?: string[] };
  profiles?: string[];
  assigneeName?: string;
  planningContext?: { parent?: string; siblings?: string; dependencies?: string };
  groupingParent?: boolean;
  dependencyTokenScope?: "installation";
  referenceRepos?: Array<{ repo: string; path: string; ref?: string }>;
  reviewers?: Array<{ id: string; gates: boolean }>;
  retryPolicy?: {
    requestRetries: number;
    stageRetries: number;
    pushRetries: number;
    backoffInitialMs: number;
    backoffMaxMs: number;
    backoffJitter: number;
    reviewMaxTurns: number;
  };
  reviewFix?: {
    version: 1;
    attemptId: string;
    installationId: number;
    repository: string;
    prNumber: number;
    deadlineAt: number;
  };
  agentConfig?: ResolvedAgentSnapshotV1; // AII-944, see "Resolved agent snapshot"
}
```

Field notes:

| Field | Notes |
|-------|-------|
| `issue.description` | Capped at 40,000 characters on encode; truncation is appended as a marker string |
| `prNumber` | Set for gap-analysis and review-feedback re-dispatches; absent on initial implementation |
| `baseBranch` | Feature-branch parent for child issues; repo default branch otherwise |
| `runnerPhase` | `"implementation"` (default), `"gap-analysis"`, `"planning"`, or `"kg-refresh"` |
| `sensitiveFiles.add` | Glob patterns extending the built-in sensitive-file blocklist |
| `sensitiveFiles.allow` | Glob patterns that override the blocklist; allow wins over both built-in and add patterns |
| `profiles` | Jira AI-Implement Profiles field values (comma-split strings) |
| `assigneeName` | Jira issue assignee display name; absent for Linear or unassigned Jira issues. `push.ts` appends it as `(Name)` to the opened PR's title. Fly/local mirror it as `AI_IMPLEMENT_ASSIGNEE_NAME`. Envelope-only — unlike `profiles`, `assignee` was never a legacy workflow_dispatch input, so it is not forwarded on the legacy GHA contract. |
| `planningContext` | Populated for child issues in a feature tree; carries parent and sibling summaries |
| `groupingParent` | True when this dispatch is a grouping parent's own closing-work run |
| `dependencyTokenScope` | `"installation"` enables the dependency token step in the runner; absent or null disables it. The runner fetches a read-only token covering all App-installation repos and injects it as a git credential helper and `COMPOSER_AUTH`. Requires a publicly reachable orchestrator (`RUNNER_CALLBACK_BASE_URL` + `RUNNER_TOKEN_SECRET`). |
| `referenceRepos` | Repositories to clone read-only into the workspace before the implement loop. Each entry carries `repo` (normalized `https://github.com/owner/repo`), `path` (workspace-relative directory), and an optional `ref` (branch, tag, or commit hash; absent means the default branch). **Absent on planning dispatches** — the planning runner reads no such field. **Absent on kg-refresh dispatches** — the kg-refresh pipeline clones a knowledge-graph source repository as its workspace and has no pipeline step that would consume reference repos. Envelope-only: no dispatch input and no environment variable carry this field, so a target repo on the legacy workflow contract does not receive it. |
| `reviewers` | Project reviewer selection copied from the mapping when non-null. Each entry carries a reviewer `id` and whether that reviewer `gates` merge readiness. Absent means the runner uses `DEFAULT_REVIEWER_SELECTION` (`gap-analysis` and `code-review`, both gating), not an empty list; this keeps older orchestrators and already-dispatched runs from silently losing their review gate. Malformed values are dropped during decode with one warning and then resolve to the same default. The runner forwards the selection to the post-push review step, which runs selected internal reviewers, applies their gating policy, and fails closed for an empty selection. The external `claude-review-summary` id controls prose gating rather than resolving executable reviewer code. |
| `retryPolicy` | Global retry/backoff policy and reviewer turn cap, edited on the admin Settings page and stored in the orchestrator's `settings` table (never an env var). Absent means the runner uses `DEFAULT_RETRY_POLICY` (`src/pipeline/retry-backoff.ts`). Populated by `getRetryPolicy()` on every implementation-phase and gap-analysis-phase dispatch across all three execution modes — the initial dispatch, the `/ai-implement` comment gap-fill drain, the PR-comment gap-fill trigger, and the review-fix re-dispatch — because `pushRetries` and `reviewMaxTurns` apply to those re-dispatches exactly as to initial runs. Never sent on planning or kg-refresh dispatches, which have no retry loop. On the GHA path, `buildEnvelopeDispatchInputs`'s `retryPolicy` option is required (nullable), not optional — a caller can no longer omit it silently, it must state intent: planning passes `null` explicitly, implementation/gap-analysis pass the real policy from `getRetryPolicy()`. The function itself only stamps the field into `run_config` when `runnerPhase` is neither `planning` nor `kg-refresh`, substituting `DEFAULT_RETRY_POLICY` only if the passed value is `null`, so all three backends agree that every implementation/gap-analysis dispatch carries this field. The runner runs the decoded value through `normalizeRetryPolicy` (an out-of-range or malformed field degrades to the default for that field alone; an unknown key is dropped). The `push` step consumes `pushRetries` and the backoff fields (see [pipeline-architecture.md](pipeline-architecture.md), "Push retry and remote reconciliation"); the remaining fields are stored and transported so the retry rails built on top of them read one source of truth. |
| `reviewFix` | The Restate review-fix pilot's explicit attempt-identity marker (AII-776), shaped by the canonical AII-770 contract (`src/review-fix-contract.ts`'s `ReviewFixMetadataV1`): `attemptId` identifies one Restate attempt, `installationId`/`repository`/`prNumber` scope it to one PR under one GitHub App installation, and `deadlineAt` is an epoch-ms timestamp (not ISO) so it compares with plain `<`/`>`. Absent means Legacy (non-pilot) dispatch, the only path the legacy flat-env contract can produce — there is no environment-variable equivalent. Unlike every other optional field on this envelope, a **present but malformed or unsupported** `reviewFix` fails closed: `decodeRunConfig` throws rather than dropping the field and falling back to Legacy, because a bad pilot marker must never be silently treated as a non-pilot dispatch. Carries no credential or token — repository/PR/execution authority is verified downstream against stored state, never trusted from this field alone. This slice only carries the field through `RunConfigV1` and `ResolvedRunnerInputs`; no pipeline step reads it yet. |

## Resolved agent snapshot (`agentConfig`, AII-944)

`agentConfig` is an optional, frozen, already-resolved stage configuration: `{ version: 1, snapshotId, configRevisions: { orchestratorDefault: { configRevisionId, revision }, project: { configRevisionId, revision } }, stages, sources, profiles }`. `stages`, `sources` and `profiles` each hold exactly `planning`, `implementation` and `review`. Each stage carries `agent`, `provider`, `model`, `accountProfileId` and `invocationTimeoutMs` (the actual limit; `maxTurns`/`maxIterations` stay separate envelope fields and turns are never converted to time). `sources` holds a `FieldSource` per field; `profiles` holds the safe projection `id/identity/revision/agent/provider/authMode`. All five `AccountAuthMode` values are valid, including `claude-subscription`. Each `configRevisions` layer is a keyed reference holding the exact immutable `configRevisionId` (a non-empty bounded string, the `stage_agent_config_revisions` row id) and its positive integer `revision`. `resolveProjectStageConfig` returns these as `configReferences` (`configRevisionIds` stays as a compatibility projection derived from them). **Prerelease tightening:** version 1 has no production writer yet, so the earlier numeric-only `configRevisions` shape is rejected rather than supported; row ids are never synthesized from numbers. Decoding is pure — it checks shape only and cannot verify that an id belongs to its revision; that consistency comes from building the snapshot from store resolution. The snapshot `version` is independent of envelope `v`. The types come from `src/agent-config.ts`, which is unchanged.

- **Validation** is `validateResolvedAgentSnapshot` in `src/run-config.ts` (pure, no SQLite). It runs on `encodeRunConfig`, `decodeRunConfig`, `pickKnownKeys` and `buildImplRunConfig`. It checks structure, version, required stages, positive integer revisions/timeouts, allowed sources, stage/profile consistency (id, agent, provider) and the supported agent/provider/authMode combinations, and rejects unknown fields at every level (including credential-shaped ones). Diagnostics name the path only and never echo values.
- **Fail closed.** A present-but-invalid `agentConfig` throws, like `reviewFix`; it never falls back to legacy. Absent means legacy behavior, byte-for-byte unchanged.
- **Data, not authorization.** Decoding does not re-resolve defaults or check profile permissions. Trusted preparation and dispatch authorization come later. Credential grant values belong only to the protected bootstrap namespace (AII-680), never this field.
- **Builder.** `buildImplRunConfig` accepts an optional `agentConfig`, validates it and copies it; it never resolves settings.
- **Not to be confused with** `profiles` (workflow profiles) or `InvokeParams.stage` (a diagnostic label). `InvokeParams.agentStage` (`StageName`) and `invocationTimeoutMs` are new optional fields; `LLMExecutor` and `PlanningExecutor` are unchanged. `RunPlanningLocalOptions` and `LocalFullLoopOptions` gain optional `agentConfig` and async `stageExecutor` inputs, not yet consumed.

### Writer census (no writer sets the field in this wave)

Verified by grep: the only `src/` files mentioning `agentConfig`, `agentStage` or `invocationTimeoutMs` are `run-config.ts`, `pipeline/types.ts`, `run-planning.ts`, `local/full-loop.ts` and `agent-config.ts` (definitions only). No caller below is edited.

| File | Role | Status |
|---|---|---|
| `src/run-config.ts` | `encodeRunConfig` / `decodeRunConfig` / `pickKnownKeys` / `buildImplRunConfig` | Validates and passes through when present; absent stays absent |
| `src/github.ts` (dispatch builders, `RunConfigV1` literal, `encodeRunConfig`) | GHA writer | Does not set `agentConfig` |
| `src/index.ts` (planning `RunConfigV1` literal, `buildImplRunConfig` call, KG writers) | Orchestrator writers | Do not set `agentConfig`; builder call omits the new input |
| `src/local-gapfill.ts` | `decodeRunConfig` then `encodeRunConfig` | Passes through a present snapshot (re-validated); does not set it |
| `src/dev-harness/index.ts` | `encodeRunConfig` of a literal | Does not set `agentConfig` |
| `src/run-autonomous.ts` | `decodeRunConfig` (reader of the envelope) | Does not set it |
| `src/run-planning.ts` | `decodeRunConfig`; `RunPlanningLocalOptions` gains optional `agentConfig` / `stageExecutor` | Does not set it; new options unconsumed |
| `src/run-local-planning.ts`, `src/run-local-full-loop.ts` | `decodeRunConfig` of the encoded envelope | Do not set it |
| `src/local/full-loop.ts` | `LocalFullLoopOptions` gains optional `agentConfig` / `stageExecutor` | Does not set it; new options unconsumed |
| `src/pipeline/kg-refresh-run.ts` | `decodeRunConfig` | Does not set it |

### Reader census

`InvokeParams` readers (none reads `agentStage` or `invocationTimeoutMs`; all ignore them today):

| File | Use |
|---|---|
| `src/pipeline/executor.ts` | `ClaudeCliExecutor.invoke` / `spawnOnce` consume existing params only |
| `src/run-planning.ts` | `PlanningStageExecutor` type takes `InvokeParams`; fields not read |
| `src/pipeline/steps/implement.ts`, `feedback-loop.ts`, `review.ts`, `post-push-review.ts` | Build `InvokeParams` for `llmExecutor.invoke`; do not set the new fields |
| `src/pipeline/context.ts` | No-op default executor; ignores params |
| `src/run-autonomous.ts`, `src/pipeline/kg-refresh-run.ts`, `src/local/full-loop.ts` | Accept an optional custom `LLMExecutor`; do not inspect params |

`PipelineContextData` readers (none reads `agentConfig`): `src/pipeline/context.ts` (holds `data`), `src/pipeline/pipeline-loader.ts`, `src/pipeline/steps/kg-ingest.ts`, `src/pipeline/kg-refresh-run.ts`, `src/run-autonomous.ts` (constructs it from the decoded envelope without copying the snapshot). The `PipelineContextData.agentConfig` field is new and unread.

`decodeRunConfig` consumers are the files listed in the writer census that import it.

### Mixed-version matrix

| Orchestrator | Runner | Result |
|---|---|---|
| old (no field) | new | Field absent, legacy behavior |
| new, legacy project | old or new | Field absent, legacy behavior |
| new, opted-in project | new | Snapshot validated; consumed once dispatch wiring lands |
| new, opted-in project | old | **Unsafe:** `pickKnownKeys` silently drops the field and the run executes legacy |

The last row must never happen. No production writer sets `agentConfig` in this wave. The readiness gate that rejects configured work on runners lacking snapshot support ships with dispatch wiring and must land before any writer enables the field; it must reject, not silently run legacy. Rollback: keep project opt-in disabled for new attempts; the schema addition is harmless to mixed versions.

Below the TS runner layer, `session/entrypoint.sh` picks the phase (and, for kg-refresh, the callback URL it re-exports) via `resolve_envelope_field` in `session/lib.sh`: when `RUNNER_PHASE` (or `RUNNER_CALLBACK_URL`) is already set in the container env, that value wins and the envelope is not consulted; only when the env var is empty does the shell decode `AI_IMPLEMENT_RUN_CONFIG` and fill it from `runnerPhase` / `runnerCallbackUrl`, falling back to the `implementation` default (no fallback for the callback URL) if the envelope is absent, malformed, or lacks the field. Env-wins matters because Fly Machines and local Docker set `RUNNER_PHASE`/`RUNNER_CALLBACK_URL` directly in the container env, and the local dev harness (`npm run dev:run`) sets `RUNNER_PHASE=full` or `local-planning` while its envelope still carries `runnerPhase: implementation` — if the envelope won, a local dev run would silently switch to the autonomous loop instead of the local full loop it asked for.

---

## Private credentials namespace (`credentials`, AII-981)

`RunConfigV1.credentials` is an optional, versioned `{ version: 1, resultToken?, progressToken?, publicationToken?, attemptToken?, modelAuthGrant? }` for trusted transport. `modelAuthGrant` is the plain grant or sealed Fly form from `src/model-auth-contract.ts` and is never part of `agentConfig`. `validateRunCredentials` rejects unknown fields, bad types, oversized tokens and invalid grants with path-only errors that never echo values or key names.

| Function | Credentials |
|---|---|
| `encodeRunConfig` | Dropped |
| `decodeRunConfig` | Validated (fail closed), not returned |
| `encodeTrustedRunConfig` / `decodeTrustedRunConfig` | Carried |
| `diagnosticProjection` | Field names only |

### Workflow bootstrap and capability (AII-982)

The first container-job step of `claude-implement.yml` and `claude-plan.yml` (identical in `workflows/` and `.github/workflows/`) reads `GITHUB_EVENT_PATH` and registers `::add-mask::` for the legacy token inputs, then for the **entire encoded `run_config`**, then for each extracted secret, one per line with `%`, CR and LF escaped: every `credentials.*` token, the plain grant's `bearer`, and a sealed grant's `nonce`, `ciphertext` and `tag` (8+ characters). Masks are emitted only after the namespace and any `agentConfig` validated; recursive masking is never a substitute for validation. The bootstrap re-implements `validateRunCredentials` (including the plain and sealed `modelAuthGrant` variants of `src/model-auth-contract.ts`, discriminated by an `algorithm` key) and `validateResolvedAgentSnapshot` in jq, and `workflow-token-masking.test.ts` checks it against the TypeScript validators on valid and malformed fixtures. Base64 is not protection; masking is a log layer verified against real logs in AII-984. Present-but-invalid private data (a `null` namespace, token or grant counts as present; also bad base64/JSON, wrong types, unknown keys, version, whitespace in a token, an invalid grant or snapshot) exits non-zero with a fixed message — jq stderr is discarded because it can echo input — before any consumer runs. After validation the same step delivers the credentials (AII-1000): the private namespace is the **single authority**, so `RUN_TOKEN`, `RUN_PROGRESS_TOKEN` and (implementation only) `RUN_PUBLICATION_TOKEN` are written as step outputs (`$GITHUB_OUTPUT`, step id `bootstrap`) from `credentials.resultToken` / `progressToken` / `publicationToken`, using a random heredoc delimiter, with no value in command text or output. They are mapped into the env of the `Run pipeline` / `Run planning` step only via `${{ steps.bootstrap.outputs.* }}` — never `$GITHUB_ENV`, which every later step (including third-party actions such as AWS credential configuration) would inherit, so the publication token stays restricted to the pipeline process. A field the namespace omits is exported empty and is **never** backfilled from the public `run_*` inputs, and conflicting public values are ignored. Planning exports result and progress only; a `publicationToken` in a planning envelope is dropped, not rejected, so planning never gains publication authority. When no `credentials` namespace exists, the legacy `run_token` / `run_progress_token` / `run_publication_token` inputs are exported unchanged through the same path. The `Run pipeline` / `Run planning` steps therefore read `RUN_*TOKEN` solely from those outputs. `attemptToken` stays the public `run_attempt_token` marker and `modelAuthGrant` is never exported (AII-958); `decodeRunConfig` still strips credentials. `workflow-token-masking.test.ts` runs the real bootstrap and Run step against a stub entrypoint to prove delivery, the planning audience, metacharacter safety and fail-before-entrypoint.

"Print dispatch inputs" no longer dumps the decoded envelope. It prints the diagnostic projection: known envelope keys only, `credentials` replaced by `credentialFields` (names only), and `agentConfig` replaced by the fixed marker `"<omitted>"` — the nested snapshot is validated by the bootstrap but never copied raw into logs.

A workflow advertises private-envelope support with the static comment `# ai-implement-capability: private-run-config-v1` — not a `workflow_dispatch` input. `resolveWorkflowCapabilities` sets `supportsPrivateRunConfig` only for an envelope workflow carrying it; missing or unprobed means `false`. It is unrelated to the `stage-agent-config-v1` capability, which a later slice installs.

`buildEnvelopeDispatchInputs` takes `privateTransport` (AII-983) and an optional extra `credentials`; see below. The two-request optional-input retry never strips `run_config` or the tokens, and resends `run_config` byte-identical.

### Private writers and the compatibility matrix (AII-983)

Every GHA writer (implementation, planning, the legacy index.ts review-fix writer, comment-triggered gap-fill and `dispatchKgRefreshRun`) probes the **exact workflow file at the exact ref it dispatches** (planning: `planningWorkflowFile`; KG: `claude-implement.yml` at `kgSourceRef` or the default branch, using the control token) and selects private transport only when `supportsPrivateRunConfig === true`. `contract === "envelope"` alone is never sufficient. The Restate-owned review-fix writer (`src/review-fix-worker.ts`, AII-999) follows the same rule.

| Writer | Reader | Transport |
|---|---|---|
| new | new (`supportsPrivateRunConfig === true`) | Bearers in `run_config.credentials` (`encodeTrustedRunConfig`); `run_token` is `""`; no `run_progress_token` / `run_publication_token` inputs |
| new | old (envelope without the marker, or probe `false`/failed) | Generic `encodeRunConfig` envelope plus masked top-level tokens |
| new | legacy contract | Legacy per-field inputs plus top-level tokens |
| old | new | Reader falls back to the top-level `run_*` inputs when no `credentials` namespace exists |

Audiences are unchanged: result for every kind, progress for implementation/gap-fill/KG, publication only for implementation/gap-fill where the reader advertises it. Planning and KG never receive publication authority. `credentials.attemptToken` is never filled from the public `run_attempt_token`. The orchestrator-minted result/progress/publication bearers are authoritative and phase-scoped: of the caller-supplied `credentials` (planning `trustedCredentials`, the KG config's own namespace, `buildEnvelopeDispatchInputs` `credentials`) only `modelAuthGrant` and `attemptToken` are carried, and any supplied result/progress/publication token is discarded, so a supplied `publicationToken` can never reach a planning or KG envelope.

Protected transport fails closed: explicitly supplied private `credentials` (e.g. a `modelAuthGrant`) passed to `buildEnvelopeDispatchInputs` without capability throw, and `dispatchKgRefreshRun` throws when the trusted KG config carries `credentials` or `agentConfig` and the reader lacks capability or the probe fails. The implementation (`dispatchGitHubActions`), planning (`PlanningDispatchContext.trustedCredentials`) and GHA gap-fill (`DrainCommentGapfillsInput.getTrustedCredentials`) writers expose the same typed trusted-preparation seam and call `assertPrivateTransportForCredentials` right after the probe, so an unsupported reader, a legacy-contract reader or a failed probe throws inside the pre-launch block: no `postWorkflowDispatch`, no fetch, admission released. Both happen before any dispatch request; nothing is stripped or downgraded and there is no provider/account fallback. An unprotected KG config whose probe fails uses the legacy masked path. Wiring real stage-snapshot/model-auth preparation into these builders remains AII-958.

**Fleet sync requirement:** a repo receives private transport only after its synced `claude-implement.yml` / `claude-plan.yml` carry the AII-982/AII-1000 bootstrap. This change performs no sync, deploy or project activation. **Rollback:** private writers stay capability-gated; an older workflow reports no capability and the writers revert to the masked top-level path. Never re-enable credential dumps into generic envelopes or logs.

An absent namespace decodes as the legacy envelope. No writer sets it in this slice; the exact input allowlists, rollout order and rollback are in [ADR 032](adr/032-private-run-envelope-and-credential-bootstrap.md). Statements above that the envelope is "secret-free" describe the generic envelope. `repoProcessEnv`, `modelProcessEnv` and `gitProcessEnv` strip `AI_IMPLEMENT_RUN_CONFIG` and `AI_IMPLEMENT_MODEL_AUTH_*` bootstrap handles.

---

## Probe Semantics and TTL

Before every dispatch the orchestrator calls `resolveWorkflowCapabilities` (`src/workflow-probe.ts`; `resolveWorkflowContract` remains the backward-compatible contract-only wrapper). The probe:

1. Fetches `https://api.github.com/repos/{owner}/{repo}/contents/.github/workflows/{workflowFile}` from `ref` — the branch the actual `workflow_dispatch` will target, so the contract check agrees with the dispatch it gates. Every current call site passes `mapping.defaultBranch` for both the probe's `ref` and the dispatch's own `ref` (`dispatchWorkflow` always dispatches against `mapping.defaultBranch`, even for a feature-branch child whose run then checks out a different branch via `run_config.baseBranch`), so in practice this reads as "the default branch" — but the parameter, not a hardcoded branch, is what the probe and the dispatch actually agree on.
2. Base64-decodes the YAML and detects the required `run_config` input plus optional capability inputs: `run_publication_token` (`RUN_PUBLICATION_TOKEN_RE`) and, identically, `run_attempt_token` (`RUN_ATTEMPT_TOKEN_RE`) — see "Attempt correlation" below.
3. Returns the envelope/legacy contract plus both capability bits, `supportsRunPublicationToken` and `supportsAttemptCorrelation`. Publication credentials are minted and dispatched only when the target explicitly advertises support; the same principle applies to attempt correlation once a consumer sends it.
4. On any fetch error (network failure, 404, non-200, malformed JSON) returns `"legacy"` with both capability bits `false`, and logs a warning — fail-safe.

Results are cached in-process per `owner/repo/workflowFile/ref` key for **5 minutes** (`CACHE_TTL_MS = 300_000 ms`) — `WorkflowCapabilities` as a whole is the cached value, so `supportsAttemptCorrelation` shares the same cache entry, key, and TTL as the contract and `supportsRunPublicationToken`; there is no separate probe or cache for it. A re-sync that merges the envelope template will be picked up at most one poll cycle (60 s) after the cache expires.

---

## Attempt correlation: `supportsAttemptCorrelation` and `run_attempt_token`

`WorkflowCapabilities` carries a `supportsAttemptCorrelation` bit, detected the same way as `supportsRunPublicationToken`: the probe regex-matches a `run_attempt_token:` input declaration in the fetched YAML; it does not parse the YAML structure. The bit is `true` only when the contract itself resolved to `"envelope"` and the regex matched; a `"legacy"` result (or any probe failure) forces it `false` regardless of what the YAML contains.

The implementation template now declares the optional, secret-free `run_attempt_token` input (AII-782), and its synced `.github/workflows/claude-implement.yml` copy is identical. A target repo must re-sync the template before its probe can advertise support; until then that target still reports `supportsAttemptCorrelation: false`. Re-sync is part of the later manual pilot, not this source change. The five-minute probe cache applies after re-sync.

**The probe bit is a template capability marker, not an attempt identity.** It answers "does this target's declared workflow support attempt correlation." For an individual pilot run, the top-level `run_attempt_token` value is the exact `attemptId` shown in the GitHub run name; the authoritative scoped identity travels in `run_config.reviewFix` (`ReviewFixMetadataV1`, AII-776; shape in the `RunConfigV1` schema above: `attemptId`, `installationId`, `repository`, `prNumber`, `deadlineAt`). The workflow validates that both values match before printing the envelope or running the pipeline. An explicit pilot marker with a missing, malformed, or mismatched top-level input fails closed; a Legacy run omits `reviewFix` and leaves the optional input empty.

The capability bit and a run's metadata remain separate: a repo may support the input while a Legacy dispatch uses neither field. AII-793 will use the capability probe when wiring pilot dispatch; `decodeRunConfig` still validates `reviewFix` on its own terms, while this workflow checks the display input against it.

---

## Migration Runbook

**Audience:** a target-repo owner who wants to migrate from the legacy contract to the envelope. No orchestrator access required.

### Prerequisites

- The GitHub App is installed and has write access to the repo.
- The orchestrator is running a version that includes the envelope dispatcher (AII-233 and later).

### Steps

1. **Open the orchestrator admin UI** at `/admin` → Projects.
2. Find the repo row and click **Sync workflows**.
3. The sync opens a PR in the target repo titled something like `chore: sync AI-Implement workflow templates`. Review and **merge it**.
   - The PR replaces the existing `claude-implement.yml` with the 9-input envelope version.
   - It **removes** `.github/workflows/comment-trigger.yml` (if present) — `/ai-implement` comments are now handled by the orchestrator webhook.
   - `claude-plan.yml` is updated alongside.
   - `WORKFLOW.md` and `PLANNING.md` are left untouched if they already exist.
4. **Done.** The next time the orchestrator dispatches for this repo, the probe detects the envelope contract and sends `run_config` instead of the legacy per-field inputs. No orchestrator restart needed.

### Rollback

To revert to the legacy contract, revert the sync PR. The probe detects the absence of `run_config:` and falls back to legacy inputs automatically. Note that any configuration fields that are envelope-only (`sensitiveFiles`, etc.) will stop being delivered until the repo is migrated again.

### Verification

After the sync PR merges, trigger a test dispatch (add the `AI-Implement` label to a test issue). In the GitHub Actions run, the "Run pipeline" step should show `AI_IMPLEMENT_RUN_CONFIG` in the environment rather than the legacy `ISSUE_ID`, `ISSUE_TITLE`, etc. variables.

---

## Dual-Mode Retirement Criteria

The orchestrator will continue to support both contracts indefinitely until all mapped repos have migrated. Retirement of the legacy path (removing the probe + fallback) will only be considered when:

- All repos in every active orchestrator deployment probe as `"envelope"`.
- The legacy `comment-trigger.yml` file has been removed from every target repo by sync.
- No operator has pinned to a pre-envelope runner image (`:latest` or `:next` channels are both post-envelope).

---

## Version-Bump Policy

The `v` field in `RunConfigV1` is a version discriminant. The current version is `1`. Rules:

- **New optional fields** can be added to `v: 1` without bumping — the decoder ignores unknown fields on the encode path (via `pickKnownKeys`) and the runner treats absent optional fields as unset. Adding a field is backward-compatible.
- **Removing or renaming a field** that existing runners read requires a new version (`v: 2`) and a dual-decode path until all runners are updated.
- **Changing the semantics** of an existing field in a breaking way requires a version bump.
- The version is validated on decode; any unsupported version throws immediately with a clear error (`"unsupported run_config version: N"`).
