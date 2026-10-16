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

Integrated baseline `b66a202333152272dcda4dc15c387e1ed20d001d`: `env -u RUNNER_TOKEN_SECRET npm test` passed 319 suites,
10192 tests (4 skipped); typecheck, build and 985 targeted tests passed; the local Restate suite passed 900 tests in 22
suites, and three CI passes passed 900 each. This is source and synthetic evidence, not paid or live acceptance.

Deployment and target workflow sync have not occurred.

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
  sha256:d8a31b74e210140540300c5a5141b215c2aebe6bcbe55a9b77548be9cc3cf323 node /proof.mjs
```

The mounted `dist` must be built from the same commit as the script. If the image keeps its own dependencies, drop the
`node_modules` and `package.json` mounts. If the image needs a writable `HOME`, none is required: the script sets its own.

**Status: pending native validation in the pinned image.** The pipeline did not run Docker. The script ran once against
a local Claude 2.1.284 on the host (all assertions passed); that is not the pinned-image run. Build-down must execute the
command above before merge and record the output.

## Limited historical evidence

TEST-2 supplies limited Fly/ChatGPT proof: exit 0 with error telemetry, then approval, with the original stream cause
unknown. It is not the final matrix. A successful automatic Restate review-fix in this campaign ran on Claude/GHA; that does
**not** prove Codex.

## Pending: paid/live acceptance

Each pending row needs an exact run ID, frozen snapshot ID and head SHA recorded when it is accepted. Nothing is accepted
until those are present.

| Case | Status | Required evidence |
|---|---|---|
| Docker x OpenAI API key | Pending | Run ID, snapshot ID, head SHA |
| Docker x ChatGPT plan | Pending | Run ID, snapshot ID, head SHA |
| Fly x OpenAI API key | Pending | Run ID, snapshot ID, head SHA |
| Fly x ChatGPT plan | Pending | Run ID, snapshot ID, head SHA |
| GHA x OpenAI API key | Pending | Run ID, snapshot ID, head SHA |
| GHA x ChatGPT plan | Pending | Run ID, snapshot ID, head SHA |
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

Managed Restate review-fix admission still refuses until AII-1335/1336. AII-1338 is generic Fly proof, not Codex-specific.
AII-1289 owns the final Codex-specific evidence.

## Release order

1. Reviewed prerequisite integration to testing (credentials and GHA capability).
2. The existing sequence AII-1368 → AII-1312 → AII-1374 → AII-1313, under D10/John.
3. Final AII-1289 matrix completion afterward.

This order adds no scheduler, backend architecture or bypass.
