# 032. Private run envelope and credential bootstrap

**Status:** Accepted — contract (AII-981), private bootstrap (AII-982), capability-gated writers (AII-983), synthetic log verification (AII-984) and the closing input guards (AII-680) have landed. The private transport is opt-in per project and inactive until a target re-syncs.
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
| `provider` | yes | **yes (retained)** | Provider setup and the Bedrock steps run after bootstrap, but deployed readers and `providerDispatchFields` still consume the input, and no model credential accompanies it |
| `aws_region` | yes | **yes (retained)** | Same as `provider`; a nonsecret region, validated by the Bedrock step after bootstrap |
| `run_token` | yes | no | Becomes `credentials.resultToken` |
| `run_progress_token` | yes | no | Becomes `credentials.progressToken` |
| `run_publication_token` | yes | no | Becomes `credentials.publicationToken` |

Legacy inputs stay optional and supported for repos that have not re-synced; they are not removed fleet-wide. The earlier plan to move `provider`/`aws_region` into the envelope is **withdrawn**: they remain nonsecret top-level compatibility inputs for the reasons above. Moving them would need another reader and writer migration and is not part of AII-680.

### Exact contract per workflow

Enforced by `src/__tests__/workflow-input-allowlist.test.ts` (`INPUT_CONTRACT`, exact keys in order, with a reason for each) and `workflow-shim-structure.test.ts`. KG refresh and gap-analysis dispatch through the implementation template; there is no separate workflow.

| Workflow | Inputs, in order |
|---|---|
| `claude-implement.yml` | `run_config`, `issue_identifier`, `run_attempt_token`, `runner_image`, `job_timeout_minutes`, `provider`, `aws_region`, `run_token`, `run_progress_token`, `run_publication_token` |
| `claude-plan.yml` | `run_config`, `issue_identifier`, `runner_image`, `job_timeout_minutes`, `provider`, `aws_region`, `run_token`, `run_progress_token` |

The three token inputs are kept only so templates still serve legacy writers; on the private transport they are blank or absent. Planning has no publication-token input.

### CI guards

- Exact input list per workflow (an extra, missing or reordered input fails; a count check would not catch a swap).
- Canonical `workflows/*.yml` and `.github/workflows/*.yml` byte identity.
- Diagnostic/forwarding scan: no raw envelope echo, unfiltered `jq .`, shell tracing, `toJSON(inputs)`, raw token input forwarded to an env var, or the envelope forwarded under any name other than `RUN_CONFIG` / `AI_IMPLEMENT_RUN_CONFIG`.
- Negative fixtures in the same test file prove each guard fails on a representative violation.

## Rollout order

1. Readers first: runners and workflow templates that understand `credentials` ship and are probed before any writer uses it.
2. Writers are capability-gated per project; a project whose workflow lacks the capability keeps the legacy inputs.
3. Mixed versions: an old runner drops `credentials` silently (`pickKnownKeys`), so a writer must not omit the legacy token inputs unless the capability probe passed. Absent namespace always decodes as the legacy envelope.

## Rollback

Disable the writer capability per project to return to the legacy inputs. Rollback must never re-enable credential dumps: the diagnostic dump keeps redacting tokens and decodes only the credential-free projection, and generic encode/decode keep excluding `credentials` regardless of writer state.

Limits of rollback: capability probe results are cached for 5 minutes (`CACHE_TTL_MS`), so a template re-synced backwards stays marked private-capable for up to that window. The dispatch writer refuses (`assertPrivateTransportForCredentials`) rather than downgrading when the probe reports no capability, but within the cache window it can still send a private envelope to a reverted template. Rolling a template back to a dump-capable version is therefore not supported; disable the per-project writer capability first and let the cache expire. No rollback restores envelope dumps.

## Compatibility matrix

| Orchestrator | Template | Result |
|---|---|---|
| Old (legacy inputs) | Old | Legacy inputs; unchanged |
| Old | New | Legacy inputs; the new template still reads them |
| New | Old (no `private-run-config-v1`) | Legacy inputs; supplied private credentials make the dispatch fail, never a silent downgrade |
| New | New | Private envelope; bearers in `credentials`, no top-level token inputs |

The optional-input 422 retry (`ENVELOPE_OPTIONAL_INPUTS`) makes at most two requests and never strips `run_config` or token inputs.

## Evidence

Run [36867304479](https://github.com/BuildDownAI/AI-Implement/actions/runs/36867304479) (AII-984, `private-envelope-smoke`, head `e3bc264`): three consumer jobs plus a separate verifier, all concluding `success`. Complete logs of 236, 237 and 248 lines contained 9, 10 and 9 synthetic sentinels respectively, none leaked, and each trusted consumer received exact values.

| Job | ID | Conclusion |
|---|---|---|
| `private-envelope-plan` | 110385907270 | success |
| `private-envelope-failure` | 110385907431 | success |
| `private-envelope-implement` | 110385907461 | success |
| `private-envelope-verifier` | 110386053579 | success |

The input guard (`workflow-input-allowlist.test.ts`) self-tests with negative fixtures: a dummy extra input, an unsafe diagnostic, raw token forwarding and copy drift each fail the matching check; the targeted allowlist and shim-structure tests pass. Any new or changed template must repeat the smoke run on its PR.

## Future rollout gate

No fleet sync, activation, testing promotion or deployment happens under AII-680. Before enabling the private transport for a project: sync its workflow files, confirm the probe reports `supportsPrivateRunConfig`, re-run the smoke workflow, and only then allow credential-bearing writers.
