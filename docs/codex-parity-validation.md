# Codex parity validation (provisional)

This page records the evidence for Codex support and what is still unproven. It does not claim complete Codex parity.
AII-1289 owns the final Codex + Restate acceptance and stays open; closing it must replace each pending row below with
accepted evidence. This page does not waive them.

Operator procedures: [model-account-operations.md](model-account-operations.md). Template markers:
[workflow-envelope.md](workflow-envelope.md). Planning isolation: [pipeline-architecture.md](pipeline-architecture.md).

## Verified: code, synthetic and native-CLI evidence

None of these used live credentials or paid model calls.

| Area | Evidence | Source |
|---|---|---|
| Local administration preview | Operator-approved synthetic preview on 2026-10-16 (AII-967/968). Real browser saves persisted defaults and the project opt-in/override, restored the inherited preview, and left the OTHER project unchanged. Local SQLite only; no dispatcher, no external fetch. | AII-967, AII-968 |
| Managed GHA workflow capability | Final head `2014a251`: 513 focused template/dispatch tests passed, then 322 after a move-only docblock correction; typecheck and build passed; CI/review current. Canonical and mirrored template pairs are byte-identical. | AII-970 |
| Trusted planning skills policy | Final head `d248884ac5f4476ed5c69ff4b80f50c6aa54250b`: 109 focused tests passed (4 unrelated skips); typecheck and build passed, independently. | AII-1169 / AI-Implement#1175 |
| Native CLI run | Claude 2.1.284, Codex 0.159.2, image `sha256:d8a31b74e210140540300c5a5141b215c2aebe6bcbe55a9b77548be9cc3cf323`, private `BuildDownAI/codex-sandbox-repo` commit `49f12b97884f3507b26ab63daab1e99931bf15f9`. Network none, loopback synthetic protocol provider. Production `setupPlanningWritePolicy` generated all CLI args and plugin paths. | AI-Implement#1175 |
| Claude planning, normal case | Skill loaded; Bash and Edit unavailable; a Markdown Write outside the comments directory denied by the production hook; an allowed comments Write succeeded. | AI-Implement#1175 |
| Source exclusion | A skill with only a quoted hook was excluded (`sourceHookExecuted=false`). Canonical normal and `..selected-home` workspace sources excluded; symlink and ancestor tests pass. | AI-Implement#1175 |
| Repository content | With hooks-bearing `.claude/skills` and `.claude/commands` inside the private checkout, `system/init` advertised the trusted plugin but neither repository entry. Explicit Skill calls returned Unknown skill; `repoSkillLoaded`, `repoCommandLoaded` and `repoHookExecuted` were all false. | AI-Implement#1175 |
| Codex planning view | Real production view/argv: `skills/list` found the synthetic proof skill with mode 444, strict config, and no thread or turn started. | AI-Implement#1175 |

Caveat: both pinned CLIs also advertise their own bundled vendor/system skills. The exclusion guarantee covers unselected
external user, project and repository content, not the absence of the trusted CLI's built-ins.

Exact commands and output are in the AI-Implement#1175 body and the latest verification comment on AII-1169. Evidence for
the other feature children is recorded on their own PRs; only claims verified there belong here. The feature PRs
(GitHub PR numbers, not Linear identifiers) map to issues as follows:

| PR | Issue |
|---|---|
| [#1169](https://github.com/BuildDownAI/AI-Implement/pull/1169) | AII-1419 |
| [#1170](https://github.com/BuildDownAI/AI-Implement/pull/1170) | AII-1421 |
| [#1171](https://github.com/BuildDownAI/AI-Implement/pull/1171) | AII-1163 |
| [#1172](https://github.com/BuildDownAI/AI-Implement/pull/1172) | AII-962 |
| [#1173](https://github.com/BuildDownAI/AI-Implement/pull/1173) | AII-1411 |
| [#1174](https://github.com/BuildDownAI/AI-Implement/pull/1174) | AII-1206 |
| [#1175](https://github.com/BuildDownAI/AI-Implement/pull/1175) | AII-1169 |
| [#1176](https://github.com/BuildDownAI/AI-Implement/pull/1176) | AII-113 |
| [#1177](https://github.com/BuildDownAI/AI-Implement/pull/1177) | AII-1422 |
| [#1178](https://github.com/BuildDownAI/AI-Implement/pull/1178) | AII-968 |
| [#1179](https://github.com/BuildDownAI/AI-Implement/pull/1179) | AII-1420 |
| [#1180](https://github.com/BuildDownAI/AI-Implement/pull/1180) | AII-967 |
| [#1181](https://github.com/BuildDownAI/AI-Implement/pull/1181) | AII-970 |

Integrated baseline: the feature lane after #1175 merged as commit `db554e08752d99954d0024ae522397826f4bb492`
(its tree is `b66a202333152272dcda4dc15c387e1ed20d001d`). The build-down operator reported 319 suites / 10192 unit tests
(4 skipped), 985 targeted tests, typecheck/build, and 900 local Restate tests in 22 suites (900 on each of three CI runs
of the PR head `bdc8d26a`). These figures are operator-reported; this pipeline did not re-run them at that commit. They
are source and synthetic evidence, not paid or live acceptance.

At the prerequisite baseline above, deployment and target workflow sync had not occurred. Later operator-reported
deployment evidence is recorded separately below; it does not establish the runtime of this checkout.

## Opt-in native planning-skills proof

`scripts/planning-skills-proof.mjs` is not part of `npm test` and adds no dependency. It drives the compiled production
`setupPlanningWritePolicy` and the `claude` CLI against a loopback synthetic protocol server, using an owned temporary
workspace and `HOME` removed in a `finally`. It captures the actual `claude --version` and asserts: trusted Skill loads;
Bash and Edit are denied; a Write outside `ai-output/comments/` is blocked; a comments Write succeeds; repository
`.claude` skill and command are absent from `system/init`, explicit calls answer Unknown skill, and no hook runs; quoted,
single-quoted and malformed YAML hooks, a source inside the workspace and `..selected-home` are excluded. Bundled vendor
skills may still appear in discovery.

Run from the repository root after `npm run build`, with the pinned image (the one recorded above, Claude 2.1.284):

```bash
docker run --rm --network none --user "$(id -u):$(id -g)" --cap-drop ALL \
  --security-opt no-new-privileges --read-only --tmpfs /tmp:rw,exec,size=256m \
  -v "$PWD/dist:/app/dist:ro" -v "$PWD/node_modules:/app/node_modules:ro" \
  -v "$PWD/package.json:/app/package.json:ro" \
  -v "$PWD/scripts/planning-skills-proof.mjs:/proof.mjs:ro" \
  -e PLANNING_PROOF_DIST=/app/dist \
  --entrypoint node \
  sha256:d8a31b74e210140540300c5a5141b215c2aebe6bcbe55a9b77548be9cc3cf323 /proof.mjs
```

The mounted `dist` must be built from the same commit as the script. If the image keeps its own dependencies, drop the
`node_modules` and `package.json` mounts. If the image needs a writable `HOME`, none is required: the script sets its own.

The image's default entrypoint is a session bootstrap that fails on missing runner credentials, so `--entrypoint node`
is required and only `/proof.mjs` follows the image.

**Status: independently validated by build-down on `aa9fe17302fbe010c6dc6cae897ae18954054230`** (PR #1182 comment
6210317200) in the recorded image, after `npm run build`: Claude 2.1.284, exit 0, not timed out, eight synthetic loopback
requests; trusted Skill load, denied Bash/Edit/outside Write, allowed comments Write, repository skill/command
discovery/call/hook exclusion, and all five source-validation cases passed. Network none, unprivileged UID/GID,
capabilities dropped, no-new-privileges, read-only root, owned tmpfs; no live credentials or paid calls. The pipeline
itself did not run Docker. Paid/live and Codex-on-Restate acceptance remain pending.

## Source boundary and October 17 operator evidence

Source inspected for this reconciliation: `3da438d30d3fa9502a9b17f8882ecb3473ab1627`.
`src/restate/review-fix-production.ts#selectedEntry` selects only GitHub Actions;
`canAdmit` returns `configuration_error` for managed projects before GitHub calls or reservation.
Consequently **this checkout cannot launch managed Codex Restate review-fix on any backend**.
Do not remove those guards as part of verification or infer support from a later deployed revision.
AII-1335/1336 and the protected GHA preparation/admission increments must be integrated first.

The following is supplied operator evidence from AII-1289's October 17 status, not independently
replayed or fetched in this reconciliation. Preserve it as historical evidence while reconciling
source and artifacts before final acceptance. No live call, provisioning, deployment or workflow
sync is authorized by this ledger.

| Milestone | Supplied evidence | Limit |
|---|---|---|
| Managed GHA / ChatGPT later review-fix | TEST-5, AI-Implement #1218/#1221; attempt `reviewfix-fa04fa31c7359e782c5a15041871d7ad12b8a6e136e0b3892852aeea27d86613`, runner `GHA39045579755`, snapshot `0456eef4-4717-4fcd-8b62-a866d9825130`, published head `4f10b595`; selected `codex/openai/gpt-6-luna/chatgpt-plan-test/codex-subscription`. [Bot finalizer](https://github.com/BuildDownAI/codex-sandbox-repo/pull/7#issuecomment-6235865381) reports addressed finding, termination and released occupancy. Private PR7 merged `73ebde8`. | Narrow normal GHA proof; cost unavailable; does not prove Fly/local or recovery. |
| Fly / Legacy / ChatGPT | TEST-6 and fresh TEST-8: planning, configured implementation, restricted native review, callbacks, termination, post-push gap/code review and normal polling release; private PR8/9 merged. | Ordinary pipeline; no automatic Restate review-fix ownership. Full run/snapshot/head identifiers still need artifact readback. |
| Local Docker / ChatGPT | AI-Implement #1229, source `e647e762`, full loop `c5d05ee7-ca11-4841-98cd-a903cf11202f`; 246 focused tests and nine source-bound Docker scenarios reported passing; container exit zero and lease released. | Ordinary pipeline; manual cancellation recovery is not automatic Restate recovery. Snapshot and pushed-head identifiers still need artifact readback. |
| Codex PlanningRun / GHA | TEST-4 reported an actual configured Codex PlanningRun. | Workflow, run, snapshot and head identifiers must be transcribed from artifacts before final ledger acceptance. |
| Available-profile validation | AII-1456 / AI-Implement #1229 merged as `dae8192b1b21037c3fa4f4e396d9e87fabdaa2e2`; executable `e647e762` reportedly deployed with Restate registered. | Deployment observation applies to that revision, not this checkout. |

TEST-2 remains limited historical Fly/ChatGPT proof: exit zero with error telemetry and later approval;
the original stream cause is unknown. Preserve failed invocations even when a later review succeeds.
A generic Claude/GHA or Claude/Fly run never supplies Codex-specific acceptance.

## Remaining acceptance matrix

“Reported” below means the operator milestone above exists; it does not fill missing artifact
identifiers or bypass this checkout's source restrictions. All six rows require planning,
implementation and structured review, the immutable stage snapshot, run/backend/runner identity,
exact pushed head, and approval bound to that head. Later review-fix additionally requires the
ReviewFixPR/workflow and ReviewFixAttempt identities, accepted result, confirmed termination and
released occupancy. Do not include tokens, credential contents or auth journals in evidence.

| Backend | OpenAI API key | ChatGPT plan |
|---|---|---|
| Docker | Blocked: existing permitted profile/live release required | Ordinary full loop reported; identifiers incomplete; Restate review-fix blocked |
| Fly | Blocked: existing permitted profile/live release required | Ordinary pipeline reported; identifiers incomplete; Restate review-fix blocked by AII-1336/1338 |
| GHA | Blocked: existing permitted profile/live release required | Initial native run TEST-3 and PlanningRun TEST-4 reported; TEST-5 later review-fix accepted by operator on later source; integration/readback required here |

| Dimension | Remaining gate / evidence |
|---|---|
| Required children | PR mapping above records prerequisite history, not a current terminal-status audit. Verify all required children including AII-1424 and the existing AII-1334/1335/1336/1338 tree, with accepted evidence, before closing. |
| Restate backend composition | Adopt delivered managed seams; production-composed synthetic GHA/Fly/local launch and correct-result acceptance remain unproven here. Unsupported combinations must reserve/launch nothing. |
| Planning ownership | TEST-4 artifact identifiers and restart/cancel/retry proof preserving run and snapshot identity. |
| Live Fly Restate | TEST-7 is reported blocked by the supported administrator refusing Fly + Restate before dispatch. Require Codex-specific PlanningRun and later ReviewFixAttempt; AII-1338 generic proof alone is insufficient. |
| Recovery | Restart while running, uncertain launch/lost acknowledgement, duplicate/stale callback, cancellation, timeout, disabled/unavailable auth and expired-token resume. Prove no duplicate writer or secret journal, preserve identity, and confirm termination before occupancy release. Local SIGINT/manual operator recovery does not meet this gate. |
| Mixed stages | Existing permitted Claude/Codex API/plan profiles and separately released live validation; record each stage's snapshot and invocation attribution. |
| Administration | Retain synthetic preview above; record supported control readback, inherited/permitted values and next-run-only edits without mutating active snapshots. |
| Trusted skills | Retain native/synthetic proof above; both planners use selected trusted skills, denied tools/writes remain denied. Only the selected trusted `.agents/skills` subtree is copied; unrelated host configuration/rules remain excluded. |
| Token renewal | Executor-level synthetic coverage is not durable expired-token resume acceptance; require protected renewal through the existing owner. |
| Reporting / compatibility | Agent/model/profile/auth/limit and available usage; missing/partial cost remains unavailable/partial, never fabricated zero. Preserve invocation failure separately from later approval; opted-out Claude unchanged and invalid/unauthorized settings never fall back. |
| Shipped diagnostics | Verify AII-1415–1417 behavior in final smoke; reuse AII-394 for Linear visibility, without replacement issues. |

The existing PlanningRun engine suite injects lifecycle dependencies. The review-fix pilot suite uses
production coordinator/store/finalizer/GHA worker adapters but replaces admission eligibility and
external edges. Passing those suites does not prove managed credential delivery or Fly/local
composition. `review-fix-production-model-auth.test.ts` separately checks the current managed
admission refusal. Do not relabel generic replay tests as Codex parity.

AII-1289 remains open. Preserve D10/John backend gates. Managed Claude subscription lifecycle
(AII-963) and the future implementation-loop Restate migration remain separate and cannot substitute
for these existing PlanningRun and ReviewFixPR/ReviewFixAttempt paths.

## Current-checkout verification (November 10, 2026)

On baseline `3da438d30d3fa9502a9b17f8882ecb3473ab1627` plus the uncommitted
documentation and admission-test changes, Node v24.22.2:

- `npm run typecheck` and `npm run build` passed.
- `npm test` passed: 319 files, 10,199 tests; database isolation guard passed.
- The two requested PlanningRun/review-fix pilot Restate suites passed: 97 tests.
- `review-fix-production-model-auth.test.ts` passed: eight tests, including
  Fly, local and shadow selections returning deferred without reservation,
  credential lookup, GitHub calls or queue mutation. These are rejection tests,
  not managed-backend launch acceptance.
- Focused image, workflow sync/input/shim, local-feedback command and admission guards passed:
  `npx vitest run src/__tests__/codex-runner-image.test.ts src/__tests__/workflow-sync.test.ts src/__tests__/workflow-input-allowlist.test.ts src/__tests__/workflow-shim-structure.test.ts src/__tests__/local-feedback-command.test.ts src/__tests__/image-equiv-check.test.ts src/__tests__/review-fix-production-model-auth.test.ts`
  — 247 tests across seven files. Source guards do not attest a built image.
- Docker runtime validation is blocked: `docker version` returns command not
  found. No image build, local Docker scenario or native image proof was performed.

The reviewer requests remain integration blockers: PR references above are not a
terminal child-status audit, and absent artifact identifiers cannot be inferred
from issue titles or ordinary pipeline success. The supplied release explicitly
withholds deployment, workflow sync and live credential provisioning. No live
validation was attempted. Integrating the reviewed prerequisite backend/auth
tree and obtaining authorized artifact readback are still necessary; removing
admission guards would not establish parity.

## Review findings and integration handoff (November 10, 2026)

All four substantive review findings remain open. The checks above are regression
evidence for the current restricted source, not acceptance of the missing integration.
The two requested Restate suites are unchanged: adding a Codex label to their existing
fakes would bypass precisely the production authentication/admission seam under review.

| Finding | Observed blocker | Required completion evidence |
|---|---|---|
| 1 — integrated ledger | This checkout contains prerequisite history, but no current accepted terminal-child audit or complete six-row live artifacts. | Record each required child's terminal disposition, reviewed merge/source identity and accepted evidence link; complete each backend/auth row and the mixed-stage, configuration, renewal and compatibility dimensions. |
| 2 — production composition and recovery | `createProductionReviewFixServices` constructs `GithubReviewFixWorker`; `selectedEntry` excludes Fly/local and `canAdmit` rejects managed GHA projects. No protected managed multi-backend seam is available here to exercise. | Integrate reviewed AII-1335/1336 and managed GHA preparation/admission prerequisites under their existing gates; then exercise production admission, protected auth and worker/result composition in the two requested suites, including every recovery fault listed above. Keep unsupported selections non-launching. |
| 3 — live identity and Fly Restate | Supplied TEST-4 evidence omits identifiers; TEST-7 remains blocked. Ordinary Fly/local success cannot fill either missing Restate record. | Read back authorized artifact records for the actual PlanningRun and later Codex Fly ReviewFixAttempt, with exact pushed-head approval, accepted result, termination and released occupancy. |
| 4 — images and local runtime | `docker version` fails because the executable is absent in this environment. | In a Docker-capable environment, run the source-bound synthetic gate in [local-feedback.md](local-feedback.md) and the native image proof above against the final integrated source; retain the dirty source diff, immutable image ID, commands and results. |

For each live row, retain an artifact link and the executable source/image identity,
backend/auth kind, stage agent/model/profile, workflow/dispatch/run/runner IDs, snapshot ID,
ReviewFixPR/attempt ID where applicable, full pushed commit and approval commit, accepted
outcome, termination and occupancy-release evidence. Mark unavailable fields explicitly;
do not reconstruct missing IDs from abbreviated commits or replace them with a generic
Claude run. Store only safe identifiers, never credential material.

This handoff requests no deployment, workflow sync or credential provisioning. The
existing release does not authorize those operations or new live calls. It also does
not authorize replacing the prerequisite backend tree with an implementation inside
this verification issue. AII-1289 cannot be reported complete from this checkout.

## Release order

1. Reviewed prerequisite integration to testing (credentials and GHA capability).
2. The existing sequence AII-1368 → AII-1312 → AII-1374 → AII-1313, under D10/John.
3. Final AII-1289 matrix completion afterward.

This order adds no scheduler, backend architecture or bypass.
