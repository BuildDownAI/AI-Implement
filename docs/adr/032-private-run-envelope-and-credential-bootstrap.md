# 032. Private run envelope and credential bootstrap

**Status:** Accepted — contract slice only (AII-981); no writer or workflow reader switches in this change.
**Date:** 2026-10-01
**References:** AII-680, AII-854, AII-944; ADR 025; [workflow envelope](../workflow-envelope.md)

## Context

GitHub Actions prints `workflow_dispatch` inputs and the first-step diagnostics dump decodes `run_config`. Credentials that ride as top-level inputs (`run_token`, `run_progress_token`, `run_publication_token`, and later model-auth grants) are exposed to anything that logs the dispatch. Diagnostic persistence and credential-bearing transport must therefore be separate paths.

## Decision

- `RunConfigV1` gains an optional, versioned `credentials` namespace: `{ version: 1, resultToken?, progressToken?, publicationToken?, attemptToken?, modelAuthGrant? }`. `modelAuthGrant` is either the plain grant or the sealed Fly form, parsed by `parseModelAuthGrantBootstrap` / `parseSealedModelAuthBootstrap` from `src/model-auth-contract.ts`; there are no parallel wire types. It is validated independently of `agentConfig` and never appears inside it.
- Validation rejects unknown fields, wrong types, oversized or whitespace-bearing tokens and bad grants. Errors are path-only and bounded; they never echo values or key names.
- Only `encodeTrustedRunConfig` / `decodeTrustedRunConfig` carry credentials. `encodeRunConfig` drops the namespace, `decodeRunConfig` validates it but does not return it, and `pickKnownKeys` and `diagnosticProjection` are allowlist-built (never spreads), so unknown keys and encoded private envelopes cannot reach a log or the database. Projections report credential presence by field name only.
- Child environments: `repoProcessEnv`, `modelProcessEnv` and `gitProcessEnv` remove `AI_IMPLEMENT_RUN_CONFIG` and the `AI_IMPLEMENT_MODEL_AUTH_*` bootstrap handles. `repoProcessEnv` also removes model session handles (`CODEX_HOME`, `CLAUDE_CONFIG_DIR`) and explicit OpenAI/Codex/Bedrock credentials. Approved forwarded repository secrets stay in the hook environment and never reach the model. The selected credential in the authorized invocation built by `ModelAuthClient` is untouched.

## Workflow input allowlists

Inputs a runner could not otherwise read before bootstrap, or that GitHub evaluates before any step runs, stay plain. Everything else moves into the private envelope when writers migrate.

| Input | Legacy allowlist | Private allowlist | Reason |
|---|---|---|---|
| `run_config` | yes | yes (private form) | Transport for the envelope |
| `issue_identifier` | yes | **yes** | `run-name:` is evaluated before any step; carries no credential |
| `run_attempt_token` | yes | yes | `run-name:` attempt marker and correlation; an identifier, not an authorization (the credential `attemptToken` is separate) |
| `runner_image` | yes | yes | Resolved before bootstrap by `validate-runner-image` |
| `job_timeout_minutes` | yes | yes | `timeout-minutes` is evaluated before bootstrap |
| `provider` | yes | no (moves to envelope) | Usable after bootstrap; decided separately from image/timeout |
| `aws_region` | yes | no (moves to envelope) | Same as `provider`; credential configuration runs after bootstrap |
| `run_token` | yes | no | Becomes `credentials.resultToken` |
| `run_progress_token` | yes | no | Becomes `credentials.progressToken` |
| `run_publication_token` | yes | no | Becomes `credentials.publicationToken` |

Legacy inputs stay optional and supported for repos that have not re-synced; they are not removed fleet-wide. Whether `provider`/`aws_region` actually move is evaluated at the reader slice, independently of image/timeout.

## Rollout order

1. Readers first: runners and workflow templates that understand `credentials` ship and are probed before any writer uses it.
2. Writers are capability-gated per project; a project whose workflow lacks the capability keeps the legacy inputs.
3. Mixed versions: an old runner drops `credentials` silently (`pickKnownKeys`), so a writer must not omit the legacy token inputs unless the capability probe passed. Absent namespace always decodes as the legacy envelope.

## Rollback

Disable the writer capability per project to return to the legacy inputs. Rollback must never re-enable credential dumps: the diagnostic dump keeps redacting tokens and decodes only the credential-free projection, and generic encode/decode keep excluding `credentials` regardless of writer state.
