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

The deployment and live evidence that followed is recorded in the dated section below.

## Rollout and live evidence (2026-10-16)

This section is separate from the synthetic evidence above. Rollout facts, synthetic proofs of the published image and live
runs are kept apart below. Nothing here closes AII-1289.

### Rollout

| Item | Value |
|---|---|
| Integration PR #1183 merge | `3ab76f2d03df8d020fe9e6ae30fef603c8686bf5` |
| Merged follow-ups (PR / issue) | #1185 / AII-1425 truthful ownership; #1186 / AII-1426 bootstrap grammar; #1189 / AII-1427 trusted GHA context; #1190 / AII-1435 scoped Git HOME; #1191 / AII-1437 explicit ephemeral implementation policy and `--init`; #1194 / AII-1438 native restricted review |
| Dispatcher | `44325258dcbe8f8d3306e37d39ade2026af1139f`, confirmed deployed by MCP |
| Final runner build | [Actions run 38950064968](https://github.com/BuildDownAI/AI-Implement/actions/runs/38950064968), succeeded |
| Immutable build index digest | `sha256:4791cf0149ea5fb93f3f19ae1b16093e83a340892ae6f975d30ce6dc18cb94c4` |
| Promoted `next` platform manifest digest | `sha256:b15f54b26abebb11809e97b8e4c2eb62e707f034aeb97e2b82c073c0bee8e352` |
| Private workflow PR #5 merge | `03c35f24b346f19ec7e68a2905d090c628aad5c2` |

The two digests are different digest types (build index versus promoted platform manifest); do not substitute one for the
other. Both private workflow files byte-match the final canonical and mirrored templates; the implementation workflow has 4
capabilities and `--init`, planning has 3. The target repository has no PR CI checks configured, so no target CI result
exists for it.

### Synthetic proof of the published image (no live account or model)

The orchestrator's own compiled published image passed the following against a loopback synthetic provider and account.
No live account or model was used for these proofs.

- 13 configured-model native review cases (9 fresh/persistent and 4 actual thread-resume).
- Fresh and expiry/resume implementation, requiring no terminal failure.
- 22 actual workflow handoff checks and 4 real Linux admission checks.
- Candidate #1194: CI 10534 unit tests / 322 suites / 16 native skips, plus 3 x 900 Restate tests; independent run of 483
  targeted tests, typecheck, build and DB-isolation.

### Live: TEST-3 (ordinary GHA, ChatGPT plan)

[TEST-3](https://linear.app/eudoxus/issue/TEST-3/add-a-version-option-to-the-word-count-cli-gha-codex-smoke), attribution
Codex / openai / gpt-6-luna / chatgpt-plan-test / codex-subscription, outcome success for both stages.

| Stage | Dispatch | GHA run | Head | Snapshot | Invocation |
|---|---|---|---|---|---|
| Planning | 2398 | [38924501371](https://github.com/BuildDownAI/codex-sandbox-repo/actions/runs/38924501371) | workflow head `afa4e5091004c7e1f469ef1586ec49d5b544bf6c` | `59d26d41-1a62-48ee-8db4-faad7ad5f4ca` | `planning-090f7f72-5976-4ae8-af38-a1c207b19336` |
| Implementation | 2421 (UUID `0a70d2ff-9b23-4770-af0f-1b5a6e373e3c`) | [38950834723](https://github.com/BuildDownAI/codex-sandbox-repo/actions/runs/38950834723) | PR head `0104954083479023ca74b519ee939a9c5654b3ea` | `b417bdf2-0852-4c8d-b32c-9e60db8240f2` | `implementation-0d8f9a88-8dc0-4ce7-884d-2de1703fdf32` |

- Snapshot IDs were observed directly from sanitized authenticated run records, not inferred.
- Implementation used native implementation and native restricted Codex review, one iteration; current-head native review
  5552376399. PR [BuildDownAI/codex-sandbox-repo#6](https://github.com/BuildDownAI/codex-sandbox-repo/pull/6)
  merged as `3c6e25a7ea1260b090a0249da924c9362970dd9f` at 18:57:12Z; TEST-3 is Done.
- Tokens are per record, not a whole-pipeline aggregate: planning 49881 in / 1069 out; implementation 101322 in / 1687 out.
  Cost is null/unavailable, not zero.
- An independent reviewer ran 5 Python unit tests and 10 real CLI checks as non-root; all passed and only the 3 specified
  files changed (evidence: PR #6 comment 6222589526). The run used the promoted `b15f54b2...` manifest; checkout and finish
  succeeded; the actual non-root admission socket was unreadable and unwritable. The legacy Restate reference is correctly
  null. No target CI exists, so none passed.

Historical failed attempts (kept as history; neither is the final outcome, and neither is TEST-2's unknown stream cause):

| Dispatch | GHA run | Failure |
|---|---|---|
| 2399 | 38924910356 | Failed before model work at Git HOME |
| 2402 | 38929014021 | Failed in the Linux implementation/review sandbox |

### Live: TEST-4 (Codex planning through Restate on GHA, planning only)

[TEST-4](https://linear.app/eudoxus/issue/TEST-4/prove-existing-codex-planning-through-restate-on-gha-planning-only), dispatch
2423, PlanningRun `21e54423-afaf-466a-9001-a2ef0a40562a` (from the MCP report card).

- Real GHA run [38951467322](https://github.com/BuildDownAI/codex-sandbox-repo/actions/runs/38951467322) succeeded on head
  `3c6e25a7ea1260b090a0249da924c9362970dd9f`; snapshot `37e0e5ed-2861-4ad8-ab78-c629024d8263`, invocation
  `planning-3bb10515-b7ab-4421-b2c5-d783fdf3f322`. Same configured model, account and auth; success, 41940 in / 1117 out,
  cost null/unavailable.
- All 3 native planning artifacts posted; checkout and finish succeeded; runner callback POST ok, phase=planning,
  outcome=success. MCP shows terminal `planning_callback`, with no TEST reservation or job left.
- The pickup label was removed after the actual GHA job started; completion did not dispatch implementation. No repository
  edits or PR.
- Caveat: the Restate-owned row's legacy runId is null. The GHA identity above was observed directly from its unique
  workflow run, not inferred from that field. No ReviewFixAttempt ID exists and none is claimed.

### Cleanup and authority

The TEST mapping was restored to fly-machines/Legacy via the supported admin UI and verified after reload; the exact
ephemeral opt-in is absent, autoMerge false and capacity 2 CPU / 4096 MB retained, other mappings untouched. The smokes used
temporary GHA, so this restoration is cleanup and not live Fly acceptance.

AII-1289 remains open (Backlog) with the AII-1336/1338 blockers. Managed review-fix admission is open on GitHub Actions only (AII-1444); the Fly and local guards stay intact, and the
sequence AII-1368 -> AII-1312 -> AII-1374 -> AII-1313 and D10 are not waived. No restart, cancel, retry or
uncertain-launch proof is inferred from these normal successes.

## Live managed review-fix acceptance (2026-10-17)

The normal managed **GHA + configured Codex + Restate review-fix/finalizer** path passed the controlled
[TEST-5](https://linear.app/eudoxus/issue/TEST-5/prove-managed-codex-automatic-restate-review-fix-on-gha) acceptance.
Scope is the ChatGPT-plan profile on GHA. AII-1289's remaining backend, auth, mixed-stage and recovery matrix stays open.

### Deployed code and published runner

Managed launch/admission and live corrections landed in [#1203](https://github.com/BuildDownAI/AI-Implement/pull/1203),
[#1206](https://github.com/BuildDownAI/AI-Implement/pull/1206), [#1208](https://github.com/BuildDownAI/AI-Implement/pull/1208),
[#1210](https://github.com/BuildDownAI/AI-Implement/pull/1210), [#1218](https://github.com/BuildDownAI/AI-Implement/pull/1218)
and [#1221](https://github.com/BuildDownAI/AI-Implement/pull/1221).

| Item | Observed value |
|---|---|
| Dispatcher, running = watched head | `e2134848be1269b757b4722265c343733503288f`, MCP `deployed-ok`, Restate ready/registered |
| Successful runner build | [39045156714](https://github.com/BuildDownAI/AI-Implement/actions/runs/39045156714), same source |
| Immutable build index | `sha256:eb8d5344f4ffa4c23a039774ddc0b18e67850c479b60f7cb8ca69dc3c94a76cd` |
| Build's amd64 manifest | `sha256:ba51de3949045ffedd910c3035b657b2ba59a90366d2abf9f54beaf74244dfc8` |
| Promoted `next` manifest, also observed in the live GHA pull | `sha256:dd30682cbe09629d1b32e9d44b47aacd0d5f3056ef4bb2c9b4c8a93d7a83902b` |

The index, build platform manifest and promoted manifest are different digest types/representations. The published build and
`next` config/layer digests matched. Five relevant compiled evidence/attribution modules in the published image byte-matched
the tested local build. A non-root, network-disabled probe of that image passed successful publication, rejected/null-verdict
and failed-result refusal, null publication usage, unchanged source evidence and nullable attribution checks; its native CLI
reported Codex 0.159.2. This probe used no live account or model. #1221's current-head CI passed 10,649 unit tests and three
runs of 993 real Restate tests, with external review approval.

### Accepted live attempt

The fixture was already correctly `fixed` after the preceding attempt. The leader's genuine
[inline operator review comment](https://github.com/BuildDownAI/codex-sandbox-repo/pull/7#discussion_r4303263585),
inside [COMMENTED review 5558515577](https://github.com/BuildDownAI/codex-sandbox-repo/pull/7#pullrequestreview-5558515577),
requested a permanent exact-object unittest. Normal `review_comment` admission started the attempt automatically.
It was an operator finding, with no invented bot/LLM verdict, hand-written webhook or manual workflow dispatch.

| Evidence | Observed value |
|---|---|
| Restate owner / attempt | `reviewfix-fa04fa31c7359e782c5a15041871d7ad12b8a6e136e0b3892852aeea27d86613` |
| GHA execution | [39045579755](https://github.com/BuildDownAI/codex-sandbox-repo/actions/runs/39045579755), attempt 1, completed/success |
| Input / published head | `58bcb3d04b4da7b03f3694efc65977b6e2222b55` / `4f10b595b7bdb44cc949082c33adcad57bea9060` |
| Frozen agent snapshot | `0456eef4-4717-4fcd-8b62-a866d9825130` |
| Retained invocation | `implementation-da7d6032-cb7a-4510-b02e-a763d44bff6d` |
| Agent / provider / model | `codex` / `openai` / `gpt-6-luna` |
| Profile / auth mode / outcome | `chatgpt-plan-test` / `codex-subscription` / `success` |
| Invocation usage | 105942 tokens in / 1441 out; cost null/unavailable |
| Combined source-cycle usage | 114513 tokens in / 1543 out; cost null; publication usage all null |
| Finding | `adf4e206e3938ee5c0b9ff9a1a522f1daf3029b7606093043bae2cb2be98e9ed`, version 1, addressed |

MCP supplied the snapshot and invocation IDs directly from retained, snapshot-validated attribution. These are per-invocation
figures, separate from the combined implementation/review cycle; publication is not another model call and adds no spend.

Native Codex implementation and restricted native review passed in one iteration. The real GHA log records selected-profile
checkout/finish success, non-root ephemeral implementation admission (Docker socket unreadable/unwritable), and authenticated
result POST success. The immutable source cycle remains pending-push with no output commit; distinct publication cycle 50001
records the actual head, complete finding disposition and `approved:true`. Both retain truthful `tests:missing` telemetry.
The independent operator check ran all six Python tests and rejected four mutated fixtures (state, version, smoke identity,
extra key), then restored the fixture. Only `tests/test_restate_smoke.py` changed in this follow-up. The target repo has no
CI configured; these independent checks are not a target CI claim.

The actual `ai-implement-orchestrator-bot[bot]`
[finalizer effect](https://github.com/BuildDownAI/codex-sandbox-repo/pull/7#issuecomment-6235865381) names the exact head
and addressed finding. MCP showed `evidenceComplete:true`, `terminationConfirmed:true` and no held reservation. A genuine
[current-head operator approval](https://github.com/BuildDownAI/codex-sandbox-repo/pull/7#pullrequestreview-5558535065)
followed independent verification. Private [PR #7](https://github.com/BuildDownAI/codex-sandbox-repo/pull/7) merged as
`73ebde8ee18dcacc9d788742c9d5a8ac95f5021e` at 2026-10-17 15:37:58Z.

TEST-5 also has the earlier PlanningRun `03a7af9b-b6e1-4f24-9b0b-80b20b8a7627` (MCP report card); no planning snapshot is
invented for it here. TEST-4's separate accepted planning run and exact snapshot remain recorded in the preceding section.

### Failures retained and cleanup

| Earlier GHA run | Actual outcome / correction |
|---|---|
| 38969033642 | Checkout unauthorized before model work/push. An accepted-204 settlement reproduction led to #1208. |
| 38972181483 | Checkout unauthorized before repair/push. A documented `workflow_run_id` parser reproduction led to #1210. |
| 39004451748 | Real Codex fix pushed `58bcb3d`, but pre-push cycle evidence lacked the published SHA/dispositions and final approval was withheld. #1218 repaired publication evidence; #1221 retained attribution. |

These are distinct review-triggered attempts. Same-attempt restart, cancellation, timeout, uncertain-launch and expiry/resume
acceptance remain pending below. No force-release, forced deployment or fabricated recovery evidence was used.

After the successful run and private merge, no TEST job/reservation remained. Browser control became unavailable
(`cgWindowNotFound`), so TEST was temporarily paused with the supported partial MCP operation. On October 17, browser access
returned: the supported admin UI saved and reopened fly-machines/Legacy/empty-extraEnv, and a partial MCP update restored
active status. Readback preserved stage settings, autoMerge=false, 2 CPU / 4096 MB and the other mapping fields. TEST-5 is
Done. Restoration itself is not live Fly proof. John's D10 and the remaining AII-1334/1335/1336/1338 work remain separate.

## Fly and local validation continuation (2026-10-17)

AII-1456 tracks this continuation from clean source `7a7e3ec3401295033f1ebd4a187c7f49256788a5`. Fresh checks passed
146 protected Fly/local/configuration/harness/admission tests, 176 stage/auth/preparation tests, 117 real-engine planning
and review-fix pilot tests, and typecheck/build. These checks do not turn synthetic backend fakes into live acceptance.

### Local Docker

The standard `npm run local:feedback` synthetic gate passed all nine scenarios, including the real production full-loop
entrypoint, pinned Codex 0.159.2, provider failure, cancellation, invalid configuration and network isolation. It built image
`sha256:3b2b8a21e3ac28f0a400a1fd09cb0a86f91218820f2d463ec7f562710cfc9077` from the clean source above and removed its
owned temporary roots. Synthetic account/provider evidence is separate from the subsequent live account run.

The live local run used the existing dedicated ChatGPT sign-in record, which refreshed through production logic. All three
stages selected codex/openai/gpt-6-luna/local-chatgpt with codex-subscription authentication. Actual run
`cdb0f500-e8eb-4b34-a1b0-7c432e259cd3`, container `e68796c028d5`, froze snapshot
`local-1f5ff9f5cccb99119810cf0c` on sandbox base `73ebde8ee18dcacc9d788742c9d5a8ac95f5021e`. The full loop completed
planning=0, implementation=0 and native review=approved. The copied workspace added only `tests/test_unicode_words.py`;
all nine Python tests passed independently. The original checkout stayed clean. Docker confirmed exited=0, running=false,
Pid=0; the leader then removed its stopped container. This local harness does not push and is not Restate-owned.

Combined implementation/review cycle usage was 97331 tokens in / 1976 out, cost null. Native review did not claim it ran the
tests; the nine-test result is independent evidence. At that point, the public collector dropped invocation attribution and its
tracked-only diff omitted the new untracked file, although the workspace copy preserved it. AII-1458 repaired these
reporting gaps; the final public-evidence proof is recorded below. An earlier malformed
operator task failed before execution; correcting its required YAML front matter was not an authentication repair.

A separate live SIGINT check, run `9776b3f7-df5c-46b5-8337-cbbc86068823`, recorded logical exit 130 and removed container
`6f6b1b08fb60`. Its timing telemetry reported the observed backend exit 0 without distinguishing cancellation, and the
missing final disposition left the dedicated session lock held. AII-1459 tracks safe unused-lease cleanup and truthful
cancellation evidence. After container/process absence and a parse-valid durably saved host-only ChatGPT record were independently confirmed,
the leader manually recovered only this lock, preserving it in a private recovery directory. This is manual recovery,
not automatic or Restate recovery acceptance. AII-1457/PR #1223 and AII-1459/PR #1225 merged to testing as `7ee7d75e`
and `a390ab74`: diagnostic echo/artifacts now share sensitive-output filtering and preserve the primary failure;
cancellation evidence keeps logical 130 separate from Docker exit. Independent 28 diagnostic and 70 cancellation tests,
three separate negative reproductions, typecheck/build and all CI passed. The standard Docker gate then passed all nine
scenarios on clean `a390ab74416833c5c6e6895ba81c31a0dc5d1f1d`, image
`sha256:fc9fc87667f265c237127e98b9828abf7335d43eceb25259fbd665b116e4fe7d`.

A live rerun on that gated source/image, `6819d3ba-2b3c-4d96-abb1-e2e1607dd0fb` / container `48bdd8c2d4e1`,
completed planning and implementation but returned iterations_exhausted/exit 1. The in-loop reviewer accepted source
claims 1–3 and refused solely because it could not execute claim 4's unittest command. All nine tests passed independently
on the actual copied workspace; only the requested test file was added. Docker exited 1, running=false, Pid=0, and the
session lease released normally. This genuine failed review is preserved. AII-1465/PR #1227 merged the distinct in-loop
prompt correction to testing as `0aa32521a6c21380fcd162263507257b9672835b`: 200 independent focused tests, typecheck/build,
all CI and independent reviews passed. AII-1458/PR #1226 then merged the artifact repair as
`e647e762447550582a2d6b6d10c838f2434ededb`. Its own post-push correction fixed stale attribution after early startup
failures; both independent malformed-envelope and rejected-bootstrap probes passed afterward, along with 53 focused
tests, typecheck/build and current-head CI/reviews. No duplicate leader correction was dispatched.

A real Docker/CLI early-cancellation probe, `6b33d4a8-db90-4781-b0a3-d06c6abeb6d6` / `e4f45e71c694`,
correctly retained backend exit 137 separately from cancelled=true/logical 130. SIGINT was injected immediately after the
actual launch returned, but credential loading had already occurred: the guard correctly reported held(persistence_missing).
The initial unused-lease hypothesis was rejected. This proves truthful cancellation and a used-session hold, not real
unused settlement or automatic recovery. The real bridge tests and synthetic gate cover unused settlement separately.

The leader later recovered only the stopped early-cancel test's lock after confirming container/process absence and
the parse-valid, durably saved host-only ChatGPT record, preserving the old lock privately. No lock was cleared by age
or filename alone. Manual operator recovery remains distinct from automatic recovery acceptance.

Final local acceptance used clean combined source `e647e762447550582a2d6b6d10c838f2434ededb`: 246 focused tests and all
nine standard Docker scenarios passed, with owned temporary roots removed. The gate built immutable image
`sha256:c5f5188728dd7a152d18efeac96e3eaaaddbce9a1c01b1bf584cb5706c8f1d88`. The subsequent live run
`c5d05ee7-ca11-4841-98cd-a903cf11202f` / container `3634062f1bb2` used that same source/image and completed
planning=0, implementation=0, native review=approved and exit=0. The actual production decoder inside the container
confirmed snapshot `local-1f5ff9f5cccb99119810cf0c` and all three configured Codex/OpenAI/gpt-6-luna/local-chatgpt stages
with codex-subscription auth.

Public `telemetry.json` now retains latest invocation `implementation-db3a7a20-c214-4d70-86a6-674b5a8858cd`,
72177 tokens in / 1313 out, cost null. This is distinct from the combined implementation/review cycle's 89090 in /
1904 out, cost null. The reviewer explicitly left test execution unverified; the leader independently ran all nine
Python tests successfully. `changes.diff` includes only new `tests/test_unicode_words.py` (+55 lines), passes
`git apply --check` against the unchanged original checkout, and agrees with `diffstat.txt`. Docker confirmed exit 0,
running=false, Pid=0 and no OOM; the normal session lease released and the lock was absent. The leader removed only the
stopped test container. An in-memory scan of 63 artifact files against the current access/refresh/id-token strings found
zero known leaks. This accepts the ordinary local path, including the public-evidence repair and actual in-loop prompt
semantics; it does not establish Restate ownership or automatic recovery.

### Fly Machines

TEST-6 ordinary Legacy planning dispatch 2452 succeeded on real machine `8111699a5e6368`, using the published `dd30682c...`
runner manifest recorded above. Frozen snapshot `ea282117-228c-43e1-8819-23e8bde05f2b` and invocation
`planning-56366196-7bd4-4a32-93d8-8e33cb54e76f` were read directly from sanitized authenticated job attribution. Selection
was codex/openai/gpt-6-luna/chatgpt-plan-test/codex-subscription; outcome success, 39833 tokens in / 1301 out, cost null.
Checkout/finish and planning callback succeeded; the machine stopped with exit 0 and no OOM.

Implementation dispatch 2454 on machine `80d966a6116938` published private PR #8 at
`a2aaf6dc453e8dce559d80dc1908b1336d0de3fc`. Native code review approved the requested three-file stdin change; nine
Python tests and seven CLI cases passed independently, and the JSON smoke fixture stayed unchanged. However, diff-only
gap analysis demanded the leader's external run/termination evidence inside the diff, attempted a no-code fix and stopped.
The real callback reported failure and the job became review_failed/stopped, despite the machine's exit 0. AII-1460/PR #1224 merged the bounded prompt repair to testing as `6054731a`. Its published runner manifest
`sha256:36546198403f25826b4dc44580b968d6c6ec83a0bf8331d9d45ae115cec38540` was checked against the tested compiled prompt.
A normal comment gapfill then succeeded, as recorded below; a fresh initial run is still needed to verify post-push review.

The retained implementation invocation `implementation-40ea1e01-1fc7-4d1e-b89a-cad33e6a8b42`, snapshot
`87617a04-ae05-4ea0-83a8-f2cb1f9ab5ee`, itself reports success and 100565 tokens in / 1713 out, cost null. That is
per-invocation diagnostic evidence, not the overall job outcome: the callback and job correctly retain the later review
failure. Do not replace one with the other.

Private PR #8 then merged as `a0757eaf8dd0359874bf1c9c46d109c7a272ce76` after normal comment gapfill dispatch 2460
on Fly machine `8911d69c41d248` using the published `36546198...` image. Snapshot
`ce073c97-0144-4d52-ac8c-966e6acd56f9`, invocation `implementation-aadcdcba-b693-45b5-bf3c-d198bb69140b`, selected
codex/openai/gpt-6-luna/chatgpt-plan-test/codex-subscription; outcome success, 84540 tokens in / 1363 out, cost null.
Actual logs confirm in-loop approval, accepted gap-analysis success callback, auth finish, child exit 0 and no restart;
reservation readback was empty. All ten Python tests and seven CLI checks passed independently on exact head
`bef6edc496871d9a8e30dc3f280152ea45140906`, and human review 5559109210 approved. No target CI is configured.
Comment gapfills skip post-push review by design, so this does not validate the prompt repair or erase dispatch 2454's
failure. Fresh initial-run TEST-8 then closed that gap: private PR #9 merged
`72ace32a9dfce8fa89cf2f13eee8c95df5d121da` after exact-head human approval 5559141022, all twelve Python tests and two
independent CLI examples. Only the two requested tests changed at `da23628cdcf66bb25f32c5eeb4244213e59a69e0`.

TEST-8 planning dispatch 2461 / machine `82ddd05a01d7e8` and implementation dispatch 2463 / `80e335f6957e48` both
used actual image `sha256:d46d40288a9ec3462e18f5be44e3e8d372c31e340d41bb923d600ba2d9dd69e3`. Planning snapshot
`f6565b85-8788-4c78-87f3-2fac23efb155`, invocation `planning-7cfce6e7-c197-480e-a207-2b6b5eb7feb5`, reported
44332 tokens in / 1922 out, cost null. Implementation snapshot `8ec0001a-5578-49ec-ae72-d23ce34410b7`, invocation
`implementation-f905165d-77fe-47b7-8706-e6dfa9b8e52f`, reported 116952 in / 1543 out, cost null. Both selected
codex/openai/gpt-6-luna/chatgpt-plan-test/codex-subscription and reported successful invocation outcomes. These are
per-invocation counts, not aggregate job spend.

The actual initial-run post-push review executed and native report 5559134462 approved gap analysis and code review,
while truthfully marking external execution facts unverified. Actual logs confirmed accepted success callbacks, auth
finish and exit 0, with no OOM or restart. The next ordinary poll released the TEST reservation. This verifies the prompt
repair through real Codex semantics and accepts the ordinary Legacy Fly path; automatic Restate Fly remains separate.

The supported admin UI refused TEST-7's planning-only Fly/Restate selection before dispatch:
`reviewFixLifecycle "restate" requires executionMode "github-actions"`. The unsaved form was cancelled; TEST stayed on
Fly/Legacy/empty-extraEnv/active. TEST-7 is blocked by AII-1336, and the existing administrative coupling is recorded there.
Synthetic Fly/local PlanningRun tests do not establish a selectable live configuration. Automatic Fly/local Restate
review-fix and John's original D10/backend adoption remain gated.

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
itself did not run Docker. Paid/live acceptance is recorded in the dated sections above; this synthetic skill probe adds no live evidence.

## Limited historical evidence

TEST-2 supplies limited Fly/ChatGPT proof: exit 0 with error telemetry, then approval, with the original stream cause
unknown. It is not the final matrix. Earlier automatic Restate review-fix success on Claude/GHA did not prove Codex. TEST-5's accepted Codex run is recorded above.

## Pending and partial: paid/live acceptance

Each pending row needs an exact run ID, frozen snapshot ID and head SHA recorded when it is accepted. Nothing is accepted
until those are present.

| Case | Status | Required evidence |
|---|---|---|
| Docker x OpenAI API key | Pending | Run ID, snapshot ID, head SHA |
| Docker x ChatGPT plan | Verified ordinary local full loop and public attribution/new-file evidence on combined source e647e762; no Restate ownership | Run/snapshot/base head above; no local push by design |
| Fly x OpenAI API key | Pending | Run ID, snapshot ID, head SHA |
| Fly x ChatGPT plan | Verified ordinary Legacy planning, implementation, native review and comment gapfill; TEST-6/8 | TEST-6 machine/snapshot/head above; not full acceptance |
| GHA x OpenAI API key | Pending | Run ID, snapshot ID, head SHA |
| GHA x ChatGPT plan | Verified for TEST-3 ordinary runs and TEST-5 managed Restate review-fix; see the dated sections. API-key, mixed and Restate recovery cases remain pending | Run IDs, snapshot IDs and heads recorded above |
| Real Codex PlanningRun and a later ReviewFixAttempt | Verified for the recorded GHA/ChatGPT PlanningRun (TEST-4) and later managed ReviewFixAttempt (TEST-5); other matrix cases remain pending | ReviewFixAttempt identifier, snapshot ID, head SHA |
| Mixed-stage runs (Claude and Codex across planning/implementation/review) | Pending | Run ID, snapshot ID, head SHA per stage |
| Codex on Restate: restart recovery | Pending | Live run ID, snapshot ID, head SHA |
| Codex on Restate: cancel | Pending; ordinary local SIGINT truthfulness and used-session hold/manual recovery above are separate | Live run ID, snapshot ID, head SHA |
| Codex on Restate: uncertain launch | Pending | Live run ID, snapshot ID, head SHA |
| Codex on Restate: retry | Pending | Live run ID, snapshot ID, head SHA |
| Codex on Restate: lost launch acknowledgement | Pending | Live run ID, snapshot ID, head SHA |
| Codex on Restate: duplicate and stale callback | Pending | Live run ID, snapshot ID, head SHA |
| Codex on Restate: timeout | Pending | Live run ID, snapshot ID, head SHA |
| Codex on Restate: unavailable auth | Pending | Live run ID, snapshot ID, head SHA |
| Codex on Restate: expired-token resume | Pending | Live run ID, snapshot ID, head SHA |
| Codex on Restate review-fix, live | Verified for TEST-5 GHA/ChatGPT normal completion | Exact attempt/run/snapshot/head and finalizer above |

Managed Restate review-fix admission is open on GitHub Actions only (AII-1444): Codex API/ChatGPT and supported mixed selections admit when the workflow capabilities and read-only readiness hold. Fly and local Docker still refuse until AII-1336, managed Claude subscription stays refused, and no live proof exists yet. AII-1338 is generic Fly proof, not Codex-specific.
AII-1289 owns the final Codex-specific evidence.

## Release order

1. Reviewed prerequisite integration to testing (credentials and GHA capability).
2. The existing sequence AII-1368 → AII-1312 → AII-1374 → AII-1313, under D10/John.
3. Final AII-1289 matrix completion afterward.

This order adds no scheduler, backend architecture or bypass.
