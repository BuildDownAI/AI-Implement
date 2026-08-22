# Workflow Envelope Contract (`run_config`)

Reference for the `RunConfigV1` envelope that the orchestrator sends to `claude-implement.yml` (and `claude-plan.yml`) via the `run_config` workflow_dispatch input.

---

## Background

Prior to the envelope, the orchestrator sent each field (issue ID, title, description, caps, branch prefix, …) as a separate `workflow_dispatch` input. As the feature set grew, GitHub's "unexpected inputs" rejection became a constant migration hazard: adding any new input required target repos to re-sync before the orchestrator could use it.

The envelope consolidates all YAML-safe data into a single base64-encoded JSON blob. Only fields that the GHA workflow must handle before handing off to the runner (tokens to mask, provider routing, image selection, timeout) remain as top-level inputs.

---

## 8-Input Implementation Contract

`claude-implement.yml` (post-envelope generation) exposes exactly these eight `workflow_dispatch` inputs:

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

The three runner tokens stay outside the envelope specifically so the workflow can `::add-mask::` them before the runner container starts — secret values inside base64 blobs cannot be masked by GHA. The publication token is exposed only to the pipeline process, never to model child processes or persisted step inputs.

---

## `RunConfigV1` Schema

The envelope is decoded by `src/run-config.ts` (`decodeRunConfig`). Unknown fields are stripped on decode. The `v: 1` discriminant is validated; any other value throws immediately.

```typescript
interface RunConfigV1 {
  v: 1;
  issue: { id: string; identifier: string; title: string; description: string };
  prNumber?: string;
  baseBranch?: string;
  runnerPhase?: "implementation" | "gap-analysis" | "planning";
  branchPrefix?: string;
  skillsRepo?: string;
  runnerCallbackUrl?: string;
  maxTurns?: number;
  maxIterations?: number;
  commentInstruction?: string;
  sensitiveFiles?: { add?: string[]; allow?: string[] };
  profiles?: string[];
  planningContext?: { parent?: string; siblings?: string; dependencies?: string };
  dependencyTokenScope?: "installation";
}
```

Field notes:

| Field | Notes |
|-------|-------|
| `issue.description` | Capped at 40,000 characters on encode; truncation is appended as a marker string |
| `prNumber` | Set for gap-analysis and review-feedback re-dispatches; absent on initial implementation |
| `baseBranch` | Feature-branch parent for child issues; repo default branch otherwise |
| `runnerPhase` | `"implementation"` (default), `"gap-analysis"`, or `"planning"` |
| `sensitiveFiles.add` | Glob patterns extending the built-in sensitive-file blocklist |
| `sensitiveFiles.allow` | Glob patterns that override the blocklist; allow wins over both built-in and add patterns |
| `profiles` | Jira AI-Implement Profiles field values (comma-split strings) |
| `planningContext` | Populated for child issues in a feature tree; carries parent and sibling summaries |
| `dependencyTokenScope` | `"installation"` enables the dependency token step in the runner; absent or null disables it. The runner fetches a read-only token covering all App-installation repos and injects it as a git credential helper and `COMPOSER_AUTH`. Requires a publicly reachable orchestrator (`RUNNER_CALLBACK_BASE_URL` + `RUNNER_TOKEN_SECRET`). |

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
