# Workflow Envelope Contract (`run_config`)

Reference for the `RunConfigV1` envelope that the orchestrator sends to `claude-implement.yml` (and `claude-plan.yml`) via the `run_config` workflow_dispatch input.

---

## Background

Prior to the envelope, the orchestrator sent each field (issue ID, title, description, caps, branch prefix, …) as a separate `workflow_dispatch` input. As the feature set grew, GitHub's "unexpected inputs" rejection became a constant migration hazard: adding any new input required target repos to re-sync before the orchestrator could use it.

The envelope consolidates all YAML-safe data into a single base64-encoded JSON blob. Only fields that the GHA workflow must handle before handing off to the runner (tokens to mask, provider routing, image selection, timeout) remain as top-level inputs.

---

## 10-Input Implementation Contract

`claude-implement.yml` (post-envelope generation) exposes exactly these ten `workflow_dispatch` inputs:

| Input | Required | Type | Notes |
|-------|----------|------|-------|
| `run_config` | **Yes** | string | Base64-encoded `RunConfigV1` JSON — all issue data and per-project config |
| `runner_image` | No | string | Container image override; allowlist-validated against `ghcr.io/builddownai/`, the repo owner's namespace, and `AI_IMPLEMENT_ALLOWED_RUNNER_IMAGE_PREFIXES` |
| `job_timeout_minutes` | No | string | GHA `timeout-minutes` for the implement job; empty defaults to 90 |
| `provider` | No | string | `anthropic` (default) or `bedrock` — determines auth path before the runner starts |
| `aws_region` | No | string | Required when `provider=bedrock`; passed to `configure-aws-credentials` before the container runs |
| `run_token` | No | string | HMAC bearer token for result callback to the orchestrator; empty skips callback. **Masked by the workflow before the runner starts.** |
| `run_progress_token` | No | string | HMAC bearer token for in-progress callbacks; empty skips progress posts. **Masked.** |
| `run_publication_token` | No | string | Dedicated, single-use bearer token that may be exchanged immediately before repository publication for a fresh repo-scoped GitHub credential. **Masked. Implementation and gap-analysis only.** |
| `runner_callback_url` | No | string | Base URL the runner posts results to; empty = not passed (Fly sets it in the machine env) |
| `runner_phase` | No | string | Pipeline phase; default `implementation`, `kg-refresh` for KG ingest dispatches |

The three runner tokens stay outside the envelope specifically so the workflow can `::add-mask::` them before the runner container starts — secret values inside base64 blobs cannot be masked by GHA. The publication token is exposed only to the pipeline process, never to model child processes or persisted step inputs. Token inputs are wired through `env:` on the mask step and never interpolated directly into script text, because GHA prints a step's script in the `##[group]Run …` header before the step executes.

These are live credentials in the runner's environment; `src/__tests__/setup/clear-runner-credentials.ts` (registered as a Vitest `setupFile`) deletes all five credential variables before every test so no suite can burn a single-use token against the live orchestrator. A test that needs a credential value may set it in the test body — the global `beforeEach` ensures it is cleared again before the next test. Tests that exercise callback or fetch paths should inject a mock `fetchImpl` (or equivalent dependency-injection point) rather than letting code reach a live URL.

Headroom note: GitHub caps `workflow_dispatch` at 10 inputs, and this contract uses all 10. That ceiling is part of why the envelope exists; a new field must ride inside `run_config` unless the workflow itself has to read it before the runner starts (masking, routing), in which case an existing input has to make room. `claude-plan.yml` declares seven of these (no `run_publication_token`, `runner_callback_url`, or `runner_phase`).

The first step of the container job prints every input (`[dispatch-inputs] …`), with the three tokens reduced to `<redacted>`/`(empty)` and `run_config` base64-decoded through `jq`, so a run's log opens with the exact envelope it was dispatched with. `provider` and `aws_region` are also forwarded into the entrypoint env as `PROVIDER`/`AWS_REGION`: the runner reads the provider from env, not from the envelope, so a template that drops them silently downgrades Bedrock repos to the anthropic provider.

---

## Compatibility with older templates

Every current dispatch site builds inputs through `buildEnvelopeDispatchInputs`, which never sets `runner_phase` or `runner_callback_url` — both values ride inside `run_config` instead. The one exception is the kg-refresh GHA dispatch (`dispatchKgRefreshRun` in `src/index.ts`, via `buildKgRefreshGhaDispatchBody` in `src/github.ts`), which still sends both top-level, because the AII-556-era template defaults `runner_phase` to `implementation` when the input is omitted — an omitted input on that template would run a KG refresh as an implementation.

GitHub rejects a `workflow_dispatch` naming an input the target workflow doesn't declare (422 `Unexpected inputs provided: [...]`). A target repo adopts a new template shape only when it merges a sync PR, so the orchestrator cannot assume every repo has re-synced. `src/github.ts` declares:

```typescript
const ENVELOPE_OPTIONAL_INPUTS = ["runner_phase", "runner_callback_url"] as const;
```

— inputs an older template declares and a newer one does not, because a newer template reads their values from `run_config` (AII-653). The shared poster, `postWorkflowDispatch`, strips-and-retries on a 422: when the response is HTTP 422, the body matches `/unexpected inputs/i`, and names — by exact match against the rejection's quoted input list, never by substring — at least one `ENVELOPE_OPTIONAL_INPUTS` member that is present in the dispatch's `inputs` — **and only when `inputs.run_config` is a non-empty string** — it strips exactly the named members and posts once more, logging `[dispatch] <owner>/<repo>/<file> does not declare <names> (re-sync workflows); retrying without`. Exact matching matters because a rejection naming an unrelated input that happens to contain `runner_phase` as a substring (e.g. a hypothetical `runner_phase_extra`) must not be mistaken for a match; the poster parses the rejection's quoted tokens (handling both the bare-text and GitHub's escaped-JSON error shapes) and checks set membership, not `body.includes(name)`.

The `run_config` guard matters: on the legacy (non-envelope) contract, `runner_phase` and `runner_callback_url` are authoritative issue data, not compatibility duplicates — the legacy `dispatchWorkflow` callers in `src/index.ts` never set `run_config`, so they are excluded from the strip without a separate flag. Stripping them there would run a gap-fill as an implementation. The guard requires *non-empty* — `run_config: ""` does not count as "the caller is on the envelope contract."

The retry is **capped at exactly two requests, by construction, not just by the common case where removing a name works**: the poster sends the first request, and if that 422s in a strippable way it sends exactly one more — whatever that second response says (success, a different 422, the same 422 again) is returned unconditionally, with no further request. This matters because a target repo's second 422 can legitimately name a *different* still-present optional input than the first did (e.g. reject `runner_phase` first, then `runner_callback_url`); naively recursing on "does the response still match a strippable name" would chain a third request in that case. Both `dispatchWorkflow` (the thin wrapper most dispatch sites use) and the kg-refresh dispatch path go through `postWorkflowDispatch`.

A future issue in this chain appends `issue_identifier` to `ENVELOPE_OPTIONAL_INPUTS` (run titles carry the ticket key from the envelope instead).

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

Below the TS runner layer, `session/entrypoint.sh` picks the phase (and, for kg-refresh, the callback URL it re-exports) via `resolve_envelope_field` in `session/lib.sh`: when `RUNNER_PHASE` (or `RUNNER_CALLBACK_URL`) is already set in the container env, that value wins and the envelope is not consulted; only when the env var is empty does the shell decode `AI_IMPLEMENT_RUN_CONFIG` and fill it from `runnerPhase` / `runnerCallbackUrl`, falling back to the `implementation` default (no fallback for the callback URL) if the envelope is absent, malformed, or lacks the field. Env-wins matters because Fly Machines and local Docker set `RUNNER_PHASE`/`RUNNER_CALLBACK_URL` directly in the container env, and the local dev harness (`npm run dev:run`) sets `RUNNER_PHASE=full` or `local-planning` while its envelope still carries `runnerPhase: implementation` — if the envelope won, a local dev run would silently switch to the autonomous loop instead of the local full loop it asked for.

---

## Probe Semantics and TTL

Before every dispatch the orchestrator calls `resolveWorkflowCapabilities` (`src/workflow-probe.ts`; `resolveWorkflowContract` remains the backward-compatible contract-only wrapper). The probe:

1. Fetches `https://api.github.com/repos/{owner}/{repo}/contents/.github/workflows/{workflowFile}` from the **default branch**.
2. Base64-decodes the YAML and detects the required `run_config` input plus optional capability inputs such as `run_publication_token`.
3. Returns the envelope/legacy contract and optional capability bits. Publication credentials are minted and dispatched only when the target explicitly advertises support.
4. On any fetch error (network failure, 404, non-200, malformed JSON) returns `"legacy"` and logs a warning — fail-safe.

Results are cached in-process per `owner/repo/workflowFile` key for **5 minutes** (`CACHE_TTL_MS = 300_000 ms`). A re-sync that merges the envelope template will be picked up at most one poll cycle (60 s) after the cache expires.

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
   - The PR replaces the existing `claude-implement.yml` with the 8-input envelope version.
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
