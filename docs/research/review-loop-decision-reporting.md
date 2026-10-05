# How the fix agent and the reviewer report a decision back to the pipeline (AII-1071)

**Date:** 2026-10-05. **Tree read:** `testing` at `3b0f583`. **Issue:** [AII-1071](https://linear.app/eudoxus/issue/AII-1071). **Pattern anchor:** AII-1028.

This is an investigation. It changes no source file. Each statement is marked **verified** (a file and line, a GitHub record, a run record, or an experiment against the pinned version) or **theory** (a lead with the step that would verify it), as [standing rule 1](../standing-rules.md) requires. Line numbers are for `3b0f583`.

## Summary

The five cases come from four separate faults, not one. In each case the model made a usable decision, and the pipeline had no typed channel that carried it to the gate.

| Fault | Cases | Where the decision was lost |
|---|---|---|
| F1. A finding is not tied to the head it was written for | #871, #872 | The loop takes the newest Claude review comment as the current verdict, whatever head it reviewed. When `claude-review` skipped the new head, the old head's finding went to fix pass 2. |
| F2. A fix pass with no code change has one exit: `no_changes` | #853, #871, #872 | Only a `follow-up` disposition lets the loop continue. `fixed` and `invalid` with a clean tree end the run. Internal reviewer findings have no disposition at all. There is no "already fixed". |
| F3. The gap-fill reviewer has no baseline | #868 gap-fill 1 | The gap-fill review sees `git diff HEAD`, the gap-fill's own delta. The fix agent's correct `invalid` disposition never reached that reviewer. |
| F4. A run can be approved while its agent says "not done" | #868 gap-fill 2 | The agent wrote "No code changed … Not done" in a tracker comment. The gate read only the reviewer's `approved` and wrote `runner_approved`. |

In the last 30 days, 25 of 300 post-push review runs in `BuildDownAI/AI-Implement` ended `no_changes` (12) or at the review cap (13). In 18 of them, the PR was merged later with no further commit, at the head the loop had refused. That count has limits, described under Q6.

**Recommendation:** fix F1 on its own first (option A). Then replace the fix agent's three loose report channels with one decision object per model step (option D). The decision object carries the "already fixed" vocabulary of option B, so B is not built as a separate change to the side file. Fix the gap-fill baseline (option C) as a separate issue. None of these changes needs a new right (level 1 in [standing rule 2](../standing-rules.md)), and none weakens the approval mark (ADR 014). D makes the mark stricter.

zod needs no upgrade. See [zod and Restate](#zod-and-restate).

## The five cases

### #871 (AII-1069) and #872 (AII-1067): a stale external finding (F1, F2)

| Time (UTC, 2026-10-04) | #871 | Evidence |
|---|---|---|
| 17:35:31 | First commit `91d02af` | PR timeline |
| 17:39:14 | The build-down session (`jodwyer`) converts the PR to draft | PR timeline, `convert_to_draft` |
| 17:39:44 | Claude review of `91d02af`: verdict `approve`, one `minor` finding (`listHeldReservations` and the job generation) | issue comment, `review-findings/v1` block |
| 17:39:56 | Loop: "starting fix pass 1/2", with the minor finding listed as an unresolved external finding | bot comment `iter=1` |
| 17:40:24 | Fix pass 1 pushes `9885822` and fixes the finding | bot comment `iter=1 fix-complete` |
| 17:40:30 | `Claude PR review` on `9885822` (`pull_request_target`, synchronize): **skipped** | Actions run 37221408251 |
| 17:41:04 | Loop: "starting fix pass 2/2" with **the same finding** | bot comment `iter=2` |
| 17:41:19 | Fix pass 2: no file changes → `no_changes`, "Not ready to merge" | bot comment `iter=2 no-changes` |
| 18:04:32 to 18:04:35 | Session marks the PR ready and merges it by hand at `9885822` | PR timeline |

#872 follows the same sequence: draft at 18:15:15, fix push `0f62560` at 18:15:49, `Claude PR review` skipped at 18:15:53 (run 37223752148), fix pass 2 with the old finding, `no_changes` at 18:16:33, merged at `0f62560` at 18:28:11. In #872, fix pass 1 wrote `fixed` for the finding ("The one external finding is marked fixed in `ai-output/finding-dispositions.json`", comment `iter=1 fix-complete`).

**Where the decision was lost (verified):**

1. **Why `claude-review` skipped.** `.github/workflows/claude-review.yml:31` runs the job on `pull_request_target` only when `github.event.pull_request.draft == false`. The PR was a draft at each fix push. The session drafted it, and the pipeline did not. The skip is the workflow working as designed.
2. **Why the old finding was reused.** `collectExternalReviewFindingsFromGh` (`src/pipeline/review-ledger.ts:52`) reads all PR issue comments, sorts them newest first, and takes the newest recognised Claude verdict (`review-ledger.ts:639-660`). Nothing compares the head that the comment reviewed with the current head. A `review-findings/v1` block has no head field (`docs/review-findings-contract.md`). The wait for the external check did see the skip: two `no-real-verdict` probes return `running` (`post-push-review.ts:806-808`). But the loop still collects findings when the state is `running` (`post-push-review.ts:2059-2061`), and the "external review pending" exit applies only when there are no gating findings (`cleanInternalNoGatingFindings && externalReviewPending`, line 2181). With one stale gating finding, the loop starts a fix pass instead.
3. **Why fix pass 2 ended as `no_changes`.** See F2 below.

The finding in #871 was `minor`, and the reviewer's own verdict was `approve`. Every external finding gates whatever its severity (`isReviewLedgerSourceGating` returns `true` for every source other than the internal and summary sources, `post-push-review.ts:433-442`). So the loop spent two fix passes on a note that the reviewer did not count as a blocker. That follows the current policy (ADR 019 gates structured sources by default), but it is worth a decision. See the issues list.

### #853 (AII-1020): an internal finding repeated after it was fixed (F2)

| Time (UTC, 2026-10-03) | Event | Evidence |
|---|---|---|
| 16:18:50 | Internal reviewer: blocking finding in `finishJob` (`planning-run-production.ts:160`) | bot comment `iter=1` |
| 16:19:10 | Fix pass 1 pushes `64798d6` | bot comment `iter=1 fix-complete` |
| 16:19:16 to 16:19:26 | `Claude PR review` runs on `64798d6` (success): "The earlier blocking finding is fixed." | run 37136411111, issue comment |
| 16:20:00 | Internal reviewer, iteration 2: "The previous finding is still unresolved" | bot comment `iter=2` |
| 16:20:19 | Fix pass 2: no file changes → `no_changes` | bot comment `iter=2 no-changes` |
| 16:50:12 | Merged by hand at `64798d6` | PR timeline |

The issue's first-row description ("the review cap repeated a finding that pass 1 had fixed") fits, but the fault is not the stale external finding. The external review ran on the new head and confirmed the fix. The repeated finding came from the **internal** reviewer.

- **Verified:** internal findings can only end a no-change pass as `no_changes`. The `dispositions-only` branch requires `issues.length === 0` (`post-push-review.ts:2434`), and the disposition instructions cover only external findings (`dispositionFixBlock`, line 2324). The fix agent had no way to say "this is already fixed at `64798d6`".
- **Verified:** the internal reviewer reads `gh pr diff` (`post-push-review.ts:1925`) about two seconds after the push. The loop knows the pushed SHA (`leaseSha`, line 1838), but it does not check that the diff it reads is for that SHA.
- **Theory:** the iteration-2 reviewer saw the pre-push diff, because GitHub had not yet moved the PR head. The other possibility is a plain model error. The prompt tells the reviewer to keep an unresolved previous finding, and lists the previous findings. **To verify:** read the iteration-2 review prompt in the job log of the implement run for AII-1020 (2026-10-03, about 16:19 UTC), and check whether its `<pr_diff>` contains the marker check from `64798d6`. The job logs were not reachable from this session (see [Not verified](#not-verified)).

### #868 (AII-1064) gap-fill 1: the reviewer's baseline (F3)

The operator's `/ai-implement` comment (14:44) asked for three items. The third item was "Keep a Legacy planning failure unchanged". The gap-fill run (Actions run 37210414746, dispatched 14:45) ended `iterations_exhausted` after 3 passes, with no push (run record; tracker autopsy at 15:20: "No PR could be opened (no code changes were produced)").

- **Verified (tracker comment, 15:20):** the fix agent decided correctly, with a reason. It gave the reviewer finding the disposition `invalid`: "on `testing`, the planning failure branch contains no such call … So Legacy behavior is unchanged by gating the call on `lifecycleOwner.kind === "restate"`". The session later confirmed this reading and committed the same change by hand (`ed9fac6`).
- **Verified (code):** a gap-fill run skips post-push review (`shouldSkipPostPushReview`, `pipeline-loader.ts:121`). Its only reviewer is the feedback-loop review. That reviewer sees `getDiff` = `git diff HEAD` (`feedback-loop.ts:262`), which is the gap-fill's own change against the PR head, not the PR against its base branch. The review prompt (`review.ts:50-75`) names no baseline. The gap-fill change removed a call that the PR's first commit had added, so in a diff against the PR head it looked like a change to Legacy. The reviewer's final feedback says exactly that: "It alters Legacy planning-failure behaviour, because the fast release no longer runs for Legacy dispatches."
- **Verified (code):** the feedback loop never reads the dispositions file. It writes `dispositions: []` in every cycle summary (`feedback-loop.ts:655, 721, 795, 870`). `run-autonomous.ts:893-899` reads the file only after the pipeline ends, and uses it only to reply to GitHub review threads. The agent's `invalid` disposition therefore reached neither the reviewer nor the gate.
- The operator's own baseline note ("the baseline for 'a Legacy project is unchanged' is the feature branch before this PR") was in the second `/ai-implement` comment (15:33), which went to gap-fill 2, not gap-fill 1. **Theory:** whether the reviewer prompt receives the operator's comment text at all. **To verify:** check how the gap-fill envelope carries the comment into `issueDescription` or the acceptance bar.

### #868 (AII-1064) gap-fill 2: approved with no result (F4)

- **Verified (run record):** the second gap-fill run (dispatched 15:34) has conclusion `runner_approved`, `approved: true`, 1 iteration (`get_issue_report_card AII-1064`).
- **Verified (tracker comment, 16:01):** the agent reported plainly: "**No code changed. I could not reproduce the failure, so I have not found its cause and I am not stating one.**", and under "Not done", "the acceptance asks for a stated cause … I have no evidence either way, so I added neither."
- **Verified (code):** for a gap-fill run, `approved = fbOutputs.approved === true` (`run-autonomous.ts:882`), because post-push review is skipped. The fix agent's statement goes to a tracker comment only. Nothing in the gate reads it.
- So the issue's phrase "no statement of a cause" is not quite right. The agent did state its result: "could not reproduce, not done". That statement had no channel to the gate, and it was not posted on the PR (the PR's comments contain no gap-fill summary).
- **Theory:** the feedback-loop reviewer approved an empty diff. **To verify:** read the review pass in the job log of Actions run 37213488028.

## The six questions

**Q1. The stale finding. Verified.** Yes. In #871 and #872, fix pass 2 received a finding from the Claude review of the previous head (timelines above). The external review did not run on the new head because the session had made the PR a draft, and `claude-review.yml:31` requires `draft == false`. The loop should not give a fix pass a finding that was written for an earlier head. Option A says how to tell, with what the loop already reads.

**Q2. The missing disposition. Verified.**

- The contract is in the fix prompt only when there are gating external findings (`post-push-review.ts:2324`). For internal findings (#853) it is absent.
- The vocabulary is `fixed | follow-up | invalid` (`finding-dispositions.ts:20`). `fixed` is defined as "you changed the code to address it" (line 70). So "already fixed in an earlier commit" has no correct value.
- Even a complete set of dispositions does not keep a no-change pass alive. `remainingGatingExternalFindings` subtracts only `deferredKeys` (line 2432), and only `follow-up` adds to `deferredKeys` (line 1872). A pass that marks every finding `fixed` or `invalid` and changes nothing ends `no_changes` (line 2459). This contradicts the comment at line 2104 ("An 'invalid' disposition is not filtered — it stays gating so the next review decides"): in the no-change path, no next review runs.
- The file is read leniently. A missing file or bad JSON gives an empty list with one log line (`finding-dispositions.ts:79-97`). The agent is never told that its report was dropped.

In #872, fix pass 1 did write a disposition (`fixed`). What fix pass 2 wrote is not recoverable: the loop deletes the file after reading it (line 1866), and a Legacy run's cycle summaries are not forwarded (`docs/cycle-summary-evidence.md`, step 3). Whatever pass 2 wrote, the code path above ends the run.

**Q3. The channel. Verified.**

| Channel | Producer | Enforced? | Read by | What happens when it fails |
|---|---|---|---|---|
| `structured_output` under `--json-schema` (`executor.ts:548`) | internal reviewers | yes: CLI schema, then `parseReviewVerdict` | the gate | fails closed (`invalid_review`) |
| `review-findings/v1` block in a PR comment | external Claude review | parsed (ADR 020) | the gate | parse failure → `findingsUnavailable`, fails closed; no head field |
| "final JSON object in stdout" `{fixed, testing, notes}` (prompt, line 2342) | fix agent | no (`expectsStructuredOutput: false`, line 2369); best-effort `parseFixSummary` (line 882) | the PR comment only | silently missing |
| `ai-output/finding-dispositions.json` | fix agent (external findings only) | sanitised, lenient | the loop (post-push), or thread replies only (gap-fill) | silently empty |
| Gap-fill summary prose | fix agent | no | tracker comment only | not read by any gate |
| Clean working tree (`git status --porcelain`) | side effect of the fix pass | n/a | the loop | read as `no_changes` |

Decisions that have no channel today: "already fixed at commit X"; "no change is needed, because Y"; "the cause is X"; "I could not reproduce it"; "not done / blocked"; "this finding is about an old head"; "this internal finding is wrong". Each one is lost, or turns into a wrong state (`no_changes`, `iterations_exhausted`, or a false `runner_approved`).

**Q4. The reviewer's baseline. Verified for the code, theory for the model's reading.** The post-push reviewer reads `gh pr diff`, which is the PR against its base branch. The gap-fill reviewer reads `git diff HEAD`, which is the gap-fill's own change against the PR head (`feedback-loop.ts:262`). Neither prompt names a baseline. In a gap-fill, "unchanged" can only be read against the PR head, which is what happened in #868 gap-fill 1. Yes: the review prompt should name the PR's base branch as the baseline for "unchanged", and the gap-fill reviewer should get the PR's diff against the merge base in addition to the gap-fill delta (option C).

**Q5. An approval with no result. Verified.** A gap-fill run that changes nothing can be approved today (#868 gap-fill 2). Its statement goes to the tracker and not to the PR. It should have to state why (an outcome plus a reason), and the PR should carry that statement. An outcome of "not done" or "blocked" must never produce the approval mark (option D).

**Q6. The cost. Verified, with the limits below.**

The run records cannot answer this question.

- The report card's `terminationReason` and `approved` come from the feedback loop. For AII-1069, it shows `approved: true, terminationReason: "approved"`, but the post-push loop on #871 ended `no_changes` (`get_issue_report_card AII-1069`).
- Cycle summaries are durable only for Restate review-fix pilot attempts. A Legacy run's file is not forwarded (`docs/cycle-summary-evidence.md`, step 3).

So the count comes from the post-push loop's own PR comment markers (`<!-- ai-implement post-push … -->`). It covers 474 PRs created in `BuildDownAI/AI-Implement` since 2026-09-05. That repo ran 444 of the 500 jobs in the fleet report for the period.

| Final loop marker | Runs |
|---|---|
| approved | 161 |
| invalid-external-review | 33 |
| review-failed | 23 |
| **iterations_exhausted (review cap)** | **13** |
| external-pending | 13 |
| fix pass started, no later marker | 13 |
| **no-changes** | **12** |
| no end marker | 11 |
| fix-failed | 11 |
| fix-complete, no later marker | 6 |
| reviewer-turns-exhausted | 4 |
| **Total** | **300** |

Of the 25 `no-changes` and review-cap runs:

| Outcome | no-changes | review cap | PRs |
|---|---|---|---|
| Merged, no commit after the loop ended (the refused head was merged) | 9 | 9 | #413, #422, #424, #425, #435, #452, #453, #458, #464, #506, #557, #563, #676, #844, #853, #866, #871, #872 |
| Merged after further commits | 3 | 2 | #449, #479, #558, #564, #590 |
| Closed without merge | 0 | 2 | #420, #476 |

Limits of this count:

- A PR that someone merged unchanged is evidence that a person accepted that head, not proof that the head was correct.
- `postPrComment` updates a comment that has the same marker (`post-push-review.ts:964-980`), so a later run on the same PR overwrites an earlier run's markers. The table counts one run per PR and undercounts PRs that had several runs.
- Other repos on the orchestrator are not counted.

Three of the "merged after further commits" runs are F1/F2-like in another way. In #479, #558 and #564, the "unresolved external review findings" that ended the run were compliments ("This is the right fix", "The previously-flagged … concern is moot", "I'm not re-litigating"). They came from heading-based prose extraction, the misparse that ADR 019 describes. These three runs predate or overlap that ADR (2026-09-08 to 09-14).

**Does `no_changes` ever end a run correctly? Verified, yes.** In #866 the only gating issue was "CI check 'restate-tests-binary' is failing on the current head". The fix agent could not find a defect to fix. Stopping was right. Only the reason was wrong: the run needed "the fix agent found nothing to change; CI is red" rather than "fix pass made no changes; blockers remain". Keep the stop. Make the fix agent's decision say why, and let the pipeline pick the terminal state from that decision (option D).

## Options

All four options are level 1 under standing rule 2: they change only orchestrator code and the runner image. None adds a GitHub App permission, an event subscription, or a template change.

### A. Tie each external finding to the head it was written for

When the loop reads external findings, accept the newest Claude verdict comment only if a matching check run with a real verdict exists **on the current head**, and the comment was created after that check run started. The loop already reads check runs at the head SHA (`probeExternalReviewCheck`, line 657). Otherwise, the findings are "for an earlier head". The loop does not give them to a fix pass. It ends `external_review_pending` ("Manual review required; external review did not run on the current head"), the state it already uses when the check never finishes.

- **Fixes:** F1 (#871, #872). Also every future case where the external check is skipped, cancelled or slow after a fix push.
- **Costs:** one check in `collectExternalReviewFindingsFromGh`, or in its caller, plus tests. No contract change. A later `review-findings/v2` could add a `head` field, but that is a level-3 change for target repos and is not needed.
- **Does not fix:** F2 to F4. It also does not explain why sessions draft PRs during a run. That belongs in the bd-build-down skill: drafting a PR while its run is in flight silences `claude-review` on the next push, and marking it ready re-runs the review and holds auto-merge until the review finishes (see [#870](#an-adjacent-observation-870)).

### B. An "already fixed" disposition, proven against the head

Add `already_fixed` (with the commit) to the vocabulary, and give internal findings dispositions too. A no-change pass in which every gating finding has a disposition does not end. It goes to one more review of the current head, by the internal reviewer and the external check when it ran. The loop continues to approval only if that review does not repeat the finding.

- **Fixes:** F2 (#853, #871, #872), including the `invalid` contradiction at line 2104.
- **Costs:** small on its own. It still sits on the lenient side file, so a missing report stays silent.
- **Does not fix:** F3, F4. It also does not stop a reviewer from repeating a fixed finding (#853); it only gives that repetition a second, head-checked look.
- **The gate:** an `already_fixed` claim is never accepted as approval. Only a review of the current head can approve (ADR 014).

### C. Name the baseline in the review prompts

The post-push and gap-fill review prompts state the baseline: the PR's base branch. The gap-fill reviewer gets two diffs: the PR against the merge base with its base branch, and the gap-fill's own change. The operator's gap-fill comment reaches the reviewer as data.

- **Fixes:** F3 (#868 gap-fill 1).
- **Costs:** a prompt change and a second diff in `feedback-loop.ts`, under the existing diff cap.
- **Does not fix:** F1, F2, F4. A model can still misread a correct diff.

### D. Every model step returns one decision object (recommended frame)

Each model step returns a typed result through the channel the reviewers already use (`--json-schema`, `executor.ts:548`). The pipeline branches on that result and nothing else. The rest of this section is the pattern.

**One schema, three uses.** A zod schema per step is the single source:

1. `z.toJSONSchema(schema)` gives the `--json-schema` argument, so the CLI enforces the shape before the step returns.
2. `schema.safeParse(result.structuredOutput)` checks it again in the runner, including cross-field rules that JSON Schema cannot state.
3. Where the result crosses into Restate, the same schema is the handler's or promise's serde (`serde.zod(schema)` today, or `restate.serde.schema(schema)`).

The hand-kept `REVIEW_VERDICT_JSON_SCHEMA` and its parser (`review-verdict.ts:18`) become one definition.

A sketch for the fix pass. Field names are proposals for the issue that builds it.

```ts
const FindingDecision = z.object({
  findingKey: z.string().regex(/^[0-9a-f]{64}$/),
  decision: z.enum(["fixed_now", "already_fixed", "invalid", "follow_up", "cannot_reproduce"]),
  reason: z.string().min(1).max(500),
  commit: z.string().regex(/^[0-9a-f]{7,40}$/).optional(),      // required for already_fixed (checked in superRefine)
  location: z.string().optional(),
}).strict();

export const FixPassResult = z.object({
  outcome: z.enum(["changed", "no_change_needed", "not_done"]),
  summary: z.string().min(1),          // posted on the PR as-is
  findings: z.array(FindingDecision),  // every gating finding, internal and external
  testing: z.array(z.string()),
}).strict().superRefine(/* every listed findingKey answered once; already_fixed has a commit; … */);
```

**Rules:**

1. **Only the decision moves the loop.** Stdout JSON, the dispositions file and "the tree happened to be clean" stop deciding anything. The tree state is checked *against* the decision: `outcome: "changed"` with a clean tree, or `no_change_needed` with a dirty tree, is a contradiction and ends the run as `decision_contradicts_tree`.
2. **An exhaustive switch.** Each `outcome` and each `decision` maps to exactly one pipeline action:

   | Decision | Action |
   |---|---|
   | `changed` | commit, push, review the new head |
   | `no_change_needed`, or every finding `already_fixed` / `invalid` | no push; review the current head again; the finding is closed only if that review does not repeat it (option B's rule) |
   | `follow_up` | defer the finding, as today (ADR 028) |
   | `not_done` | end the run as `not_done`, with the summary posted on the PR; never the approval mark |
   | `cannot_reproduce` | a reason the PR and the tracker show; treated as `not_done` unless the reviewer of the current head approves the head without that finding |

   A new enum value then fails the type check until every switch handles it.
3. **A claim is not proof (ADR 014).** `already_fixed` and `no_change_needed` never approve. They only send the head back to review. The approval mark still needs an approving review of the current head, and the gap-fill path gets the rule it lacks today: a run whose decision is `not_done` cannot be approved.
4. **A bad answer gets one repair turn, then a terminal state.** If `safeParse` fails, one more turn goes to the agent with the zod errors. If that also fails, the run ends as `decision_unreported`. It never falls through to `no_changes` or to approval.
5. **The statement is posted.** `summary` and the per-finding reasons go on the PR (the place a reviewer looks) and on the tracker.
6. **Keep the top level an object.** Use a flat object with an `outcome` enum, and cross-field rules in `superRefine`, not a top-level `z.discriminatedUnion`. `z.toJSONSchema` turns a discriminated union into a top-level `oneOf` (experiment below). Whether the pinned CLI accepts that under `--json-schema` is not verified.

**What Restate adds, and what it does not.** Restate has no feature that makes an LLM return a standard value. Its AI docs leave structured output to the LLM SDK, and their own evaluator example decides with `evaluation.startsWith("PASS")`. What Restate gives this pattern is the boundary: a schema on the handler or promise input rejects a bad payload before the workflow acts on it, and the journal keeps the decision for replay and inspection. This repo already does it for result metadata: `validateReviewFixResultMetadata` in the `result` handler, with a `TerminalError` on failure (`review-fix-attempt.ts:290-294`). For a Restate-owned review-fix attempt, the decision object would ride a `ReviewFixResultMetadataV2` and be checked by the same schema at that handler. A Legacy run consumes the decision in-process, in the runner. A Symbolica-style agent framework is not needed: the CLI already enforces the schema, and the whole pattern is one module of schemas plus one switch per step.

- **Fixes:** F2 and F4 fully, and the reporting half of F3 (the agent's `invalid` reaches the next reviewer as data). With A, it also closes F1.
- **Costs:** the largest option. A schema module, the fix-pass invocation (`expectsStructuredOutput: true`), the no-change branch, the gap-fill path in `run-autonomous.ts`, PR comments, tests. It is split into issues below.
- **Does not fix:** a reviewer that misjudges a correct head (#853 if it was a model error), or a missing baseline (C).

## Recommendation

A first, then D with B's vocabulary inside it, and C alongside.

- **A** is small, it is independent of the rest, and it removes the most visible fault (two of the five cases, and every future skipped-check case).
- **D** is the frame that the operator chose. It replaces the side-file contract rather than patching it a third time, the way ADR 019 replaced prose parsing. B's rule ("already fixed must be proven by a review of the current head") becomes D's rule 3, so B is not built separately.
- **C** is a prompt and diff change that does not depend on D.

This differs from the original session's "A + B first, C separate" only in where B lives: in the decision object, not in `finding-dispositions.json`.

## zod and Restate

**No upgrade is needed. Verified.**

- `package.json` declares `"zod": "^4.1.13"`. That is a lower bound, not a pin. `package-lock.json` resolves `zod` **4.6.5**.
- The range was added with `@restatedev/restate-sdk-zod` in commit `560c3ae` (AII-710, 2026-09-17), which gives no reason. 4.1.13 was presumably the current version then. **Theory**, not recorded.
- `@restatedev/restate-sdk-zod` 1.17.1 accepts `zod ^3.25.0 || ^4.0.0`.
- Restate's TypeScript serialization docs say that from zod 4.2 a schema can go straight to `restate.serde.schema(...)` (Standard Schema), and that `@restatedev/restate-sdk-zod` is for older zod.

**Experiment (2026-10-05, scratch project with `zod@4.6.5`, `@restatedev/restate-sdk@1.17.1`, `@restatedev/restate-sdk-zod@1.17.1`):**

- `restate.serde.schema` exists. It accepts a valid payload and throws on an invalid one, with a readable path list ("(at /reason) Too small …").
- `serde.zod` behaves the same, and throws a `ZodError`.
- Both expose a JSON Schema (`jsonSchema`).
- `z.toJSONSchema` gives a draft 2020-12 schema. A discriminated union becomes a top-level `oneOf` (rule 6 above).

**Optional hygiene:** if code starts to use `restate.serde.schema`, raise the floor to `^4.2.0`. A fresh resolution cannot drop below the version that the Standard Schema path needs, and `@restatedev/restate-sdk-zod` can be removed later. This is not a prerequisite.

**Not verified:** a payload that fails a serde inside a running workflow (an awakeable or promise value, not ingress) surfaces as a thrown `TypeError` or `ZodError`. Whether Restate then retries it rather than failing terminally needs a test. Until it has one, validate inside the handler and throw a `TerminalError` explicitly, as `review-fix-attempt.ts:290-294` does.

## An adjacent observation: #870

From the comment on AII-1071. **Verified:** #870 was approved by the loop at 17:37:42. The session drafted it at 17:39:13, and a draft is a veto in the auto-merge gate (`auto-merge.ts:83`). The session marked it ready at 17:50:35. `ready_for_review` is a trigger of `claude-review.yml`, so a new `Claude PR review` run started at 17:50:38, and that check was in progress when the session merged by hand at 17:55:15. **Theory:** auto-merge was holding on "Waiting on checks" (`auto-merge.ts`, the `pending` branch) and would have merged when that review finished. **To verify:** the orchestrator log lines `[auto-merge] Waiting on checks: PR #870` between 17:50 and 17:55. A session that holds a PR as a draft for a smoke test therefore costs one extra review run and about four minutes, and silences the review of any push made while the PR is a draft (F1).

## Not verified

| Claim | Step that would verify it |
|---|---|
| #853: the iteration-2 internal reviewer read a pre-push diff | Read the review prompt in the AII-1020 implement job log (2026-10-03 about 16:19 UTC); check `<pr_diff>` for the `64798d6` marker check. GitHub job logs redirect to a blob host that this session's network does not allow; fetch them from a machine with `gh` |
| #868 gap-fill 2: the feedback-loop reviewer approved an empty diff | Job log of Actions run 37213488028, review pass |
| The operator's `/ai-implement` comment reaches the gap-fill reviewer prompt | Trace the comment text from `comment-gapfill-drain.ts` into the run envelope and `review.ts` |
| The pinned Claude CLI (`2.1.284`, `Dockerfile.session:28`) accepts a top-level `oneOf` under `--json-schema` | One `claude -p --json-schema` call with the generated schema, in the runner image |
| A serde failure on a promise or awakeable value inside a workflow is terminal | A Restate test against the pinned server 1.7.10 |
| #870 would have auto-merged when its review finished | Orchestrator log, 17:50 to 17:55 UTC on 2026-10-04 |

## Issues to file

Each issue is level 1. None changes the approval gate except to make it stricter.

1. **Post-push review: use an external verdict only when it was written for the current head (option A).** Tests: a skipped check on the new head with an old verdict comment → `external_review_pending`, and no fix pass. A real verdict on the new head → unchanged behaviour.
2. **Decision schemas: one zod module for every model step's result, generating the `--json-schema` and the parser.** Move `REVIEW_VERDICT_JSON_SCHEMA` onto it first, with no behaviour change. Raise the zod floor only if `restate.serde.schema` is used.
3. **Fix pass returns a `FixPassResult` (option D, with B's vocabulary).** Replaces the stdout JSON and `finding-dispositions.json` in post-push review. It covers internal findings, and the no-change rule "review the current head again; never approve on the claim". It adds the terminal states `not_done`, `decision_unreported` and `decision_contradicts_tree`, and posts `summary` on the PR. Depends on 2.
4. **Gap-fill: the decision gates the approval mark.** `not_done` or `cannot_reproduce` cannot write `runner_approved`. The gap-fill reviewer receives the agent's decisions as data, and the statement is posted on the PR. Depends on 3.
5. **Review prompts name the base branch as the baseline, and the gap-fill reviewer gets the PR diff against the merge base (option C).**
6. **Post-push review: check that the diff read for a review is the diff of the pushed head.** Compare the PR head SHA from GitHub with `leaseSha` before `gh pr diff`, and retry briefly if they differ. Do this only if the #853 log check confirms the stale read.
7. **Run record: record the post-push review termination reason.** The report card shows the feedback loop's reason, so a `no_changes` or review-cap end is invisible in `get_issue_report_card` and the fleet report (AII-1069 shows `approved` while #871 ended `no_changes`).
8. **Decide whether a `minor` external finding under an `approve` verdict gates (ADR 019 follow-up).** #871 spent two fix passes on one.
9. **bd-build-down skill (skills repo): do not draft a PR while its run is in flight.** Doing so silences `claude-review` on the run's next push, and marking it ready re-runs the review and holds auto-merge (#870, #871, #872).
10. **Restate review-fix: carry the decision in `ReviewFixResultMetadataV2`, validated by the same schema at the `result` handler.** Depends on 3. Add a test that a failed serde on that path is terminal.
