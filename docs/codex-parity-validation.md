# Codex parity validation (provisional)

This page records the evidence for Codex support and what is still unproven. It does not claim complete Codex parity.
AII-1289 owns the final Codex + Restate acceptance and stays open; closing it must replace each pending row below with
accepted evidence. This page does not waive them.

Operator procedures: [model-account-operations.md](model-account-operations.md). Template markers:
[workflow-envelope.md](workflow-envelope.md). Planning isolation: [pipeline-architecture.md](pipeline-architecture.md).

## PR #1730 acceptance status

**Incomplete; this integration must not be treated as completing AII-1289.** The [PR review](https://github.com/BuildDownAI/AI-Implement/pull/1730#issuecomment-7228186477)
requires checkable evidence for the remaining Codex/Restate acceptance matrix. The native Claude skills proof below and Codex skill discovery without a turn
cannot satisfy it. Keep the parent open until the remaining matrix and backend/recovery gates have accepted evidence.

### October 17 operator-reported milestones

The following evidence comes from the issue's October 17 update (AII-1456 / PR #1229), not from live validation
performed in this checkout. It supersedes the older blanket pending status only for the stated milestones.

| Milestone | Reported evidence | Limits |
|---|---|---|
| GHA / ChatGPT managed Restate review-fix | TEST-5: attempt `reviewfix-fa04fa31c7359e782c5a15041871d7ad12b8a6e136e0b3892852aeea27d86613`, workflow `GHA39045579755`, snapshot `0456eef4-4717-4fcd-8b62-a866d9825130`, published head `4f10b595`; [bot finalizer](https://github.com/BuildDownAI/codex-sandbox-repo/pull/7#issuecomment-6235865381), termination and released occupancy. | Narrow GHA normal-path milestone; no Fly/local Restate or recovery acceptance. Cost unavailable. |
| Codex PlanningRun | TEST-4 reports actual configured Codex PlanningRun on GHA. | Exact run/snapshot/head identifiers are not supplied here; the combined identity-bound acceptance row remains pending. |
| Fly / ChatGPT ordinary pipeline | TEST-6 and TEST-8 report planning, implementation, native review, callbacks and termination; TEST-8 also reports post-push review. | Legacy ownership; no automatic Restate recovery proof. Full run/snapshot/head identifiers remain to be collected here. |
| Local Docker / ChatGPT ordinary pipeline | Runtime `e647e762`, full loop `c5d05ee7-ca11-4841-98cd-a903cf11202f`; native approval, clean checkout, zero container exit and released lease reported. | No automatic Restate ownership/recovery acceptance; full snapshot/head evidence remains to be collected here. |

These reports describe later deployed work, not capabilities established by this checkout. In this checkout,
`canAdmit` in `src/restate/review-fix-production.ts` still returns `configuration_error` for managed projects
before reservation. Do not enable admission merely to match the reported deployment: protected launch/auth and backend
ownership prerequisites must be integrated and verified first. TEST-7 remains blocked on AII-1336.

API-key and mixed-stage live rows require existing permitted profiles. Fly/local managed Restate admission and proof,
restart/uncertain-launch/callback/cancel/timeout/auth recovery, and the D10/John backend gates remain blockers.
No live call is authorized merely by this evidence record. The separate AII-963 and future implementation-loop migration
remain outside this acceptance.

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

At the integrated baseline above, deployment and target workflow sync had not occurred; later operator-reported deployment evidence is recorded separately above.

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
itself did not run Docker. The full paid/live and Codex-on-Restate matrix remains incomplete; the later reported milestones above do not close it.

## Limited historical evidence

TEST-2 supplies limited Fly/ChatGPT proof: exit 0 with error telemetry, then approval, with the original stream cause
unknown. It is not the final matrix. The early automatic Restate review-fix in this campaign ran on Claude/GHA and does
**not** prove Codex. The later TEST-5 Codex/GHA milestone is recorded separately above.

## Remaining paid/live acceptance and evidence gaps

Each pending row needs an exact run ID, frozen snapshot ID and head SHA recorded when it is accepted. Nothing is accepted
until those are present.

| Case | Status | Required evidence |
|---|---|---|
| Docker x OpenAI API key | Pending | Run ID, snapshot ID, head SHA |
| Docker x ChatGPT plan | Ordinary loop reported; evidence incomplete | Run ID, snapshot ID, head SHA |
| Fly x OpenAI API key | Pending | Run ID, snapshot ID, head SHA |
| Fly x ChatGPT plan | Ordinary loop reported; evidence incomplete | Run ID, snapshot ID, head SHA |
| GHA x OpenAI API key | Pending | Run ID, snapshot ID, head SHA |
| GHA x ChatGPT plan | Narrow managed milestone reported; full row incomplete | Run ID, snapshot ID, head SHA |
| Real Codex PlanningRun and a later ReviewFixAttempt | Pending | Both identifiers, snapshot ID, head SHA |
| Mixed-stage runs (Claude and Codex across planning/implementation/review) | Pending | Run ID, snapshot ID, head SHA per stage |
| Codex on Restate: restart recovery | Pending | Live run ID, snapshot ID, head SHA |
| Codex on Restate: cancel | Pending | Live run ID, snapshot ID, head SHA |
| Codex on Restate: uncertain launch | Pending | Live run ID, snapshot ID, head SHA |
| Codex on Restate: retry | Pending | Live run ID, snapshot ID, head SHA |
| Codex on Restate: lost launch acknowledgement | Pending | Live run ID, snapshot ID, head SHA |
| Codex on Restate: duplicate and stale callback | Pending | Live run ID, snapshot ID, head SHA |
| Codex on Restate: timeout | Pending | Live run ID, snapshot ID, head SHA |
| Codex on Restate: unavailable auth | Pending | Live run ID, snapshot ID, head SHA |
| Codex on Restate: expired-token resume | Pending | Live run ID, snapshot ID, head SHA |
| Codex on Restate review-fix, live | Pending | Live run ID, snapshot ID, head SHA |

This checkout still refuses managed Restate review-fix admission; later GHA deployment evidence does not establish Fly/local support here. Backend integration remains gated by AII-1335/1336. AII-1338 is generic Fly proof, not Codex-specific.
AII-1289 owns the final Codex-specific evidence.

## Release order

1. Reviewed prerequisite integration to testing (credentials and GHA capability).
2. The existing sequence AII-1368 → AII-1312 → AII-1374 → AII-1313, under D10/John.
3. Final AII-1289 matrix completion afterward.

This order adds no scheduler, backend architecture or bypass.
