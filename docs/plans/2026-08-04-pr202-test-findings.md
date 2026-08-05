# PR #202 (AII-264 fix set) — end-to-end test findings & required changes

**Tested:** `test/pr-202-aii-264` @ `76eafea` = PR #202 head (`ai-implement/feature/aii-264`) + latest `testing` (0 behind), AI-Implement **v1.0.0** base.
**Two full runs:** (1) Fly `ai-implement-oolidata` release v13, GH-Actions runners (`:next`); (2) local `dev:local`, local-docker runners built from the same branch, gap-fills via GH Actions.
**Test harness:** a grouped parent with a seed child + three siblings that edit the *same line* of one doc in parallel (two declare their files in the issue body, one doesn't) — forcing simultaneous unblock, a guaranteed merge conflict, and a racing-recovery scenario. Trees: OOL-155/156–159 (Fly), OOL-160/161–164 (local), repo `jodwyer/alpacaWheel`.

KG search terms for this work: `AII-264`, `AII-266`, `AII-267`, `comment_gapfill_queue`, `hasPendingConflictResolution`, `selectFileOverlapDeferrals`, `conflict resolution attempt`, `file-overlap`.

---

## Finding 1 — 🔴 AII-266 livelock: a successfully-dispatched conflict resolution never terminalizes, so attempt 2 is unreachable

**Observed (both runs).** When two sibling PRs go DIRTY together, both attempt-1 resolutions dispatch; the first to push merges; its merge re-dirties the second PR. The second PR's queue row is stuck in `'dispatched'`, `hasPendingConflictResolution()` returns true forever, and auto-merge logs `resolution in flight` every cycle indefinitely. No attempt 2, no cap, no notify, no human signal. Live repros: Fly **PR #3530** (OOL-157), local **PR #3533** (OOL-164 — left wedged as evidence; its gap-fill run `completed/success`, PR still DIRTY, 6+ idle cycles).

**Root cause.**
- `CommentGapfillStatus = "pending" | "dispatched" | "skipped" | "failed"` (`src/comment-gapfill-queue.ts:3`) — **there is no completed/terminal-success state**.
- The drain marks a row `'dispatched'` after launching the run (`src/comment-gapfill-drain.ts:236`) and **nothing anywhere transitions it afterward** — no reconciliation on run completion, no TTL.
- `hasPendingConflictResolution()` counts `status IN ('pending','dispatched')` as pending (`src/comment-gapfill-queue.ts:111`), so the retry branch in `src/auto-merge.ts` can never be reached after one successful dispatch.

**Proof the surrounding design is correct.** In the local run, rows that *failed* to dispatch ("No dispatch log for PR #3530") went to `'failed'` (terminal) — and the machinery then worked exactly as designed: attempt 2 enqueued, cap (2) exhausted, "leaving for a human". The retry/cap/give-up logic is fine; **only the successful-dispatch path lacks a terminal transition.**

**What needs to change.** Terminalize gap-fill queue rows when their run finishes:
- Add a `"completed"` status to `CommentGapfillStatus`.
- When the job monitor/reconciler observes a gap-fill run reaching a terminal state (success or failure), transition the corresponding queue row (`markCommentGapfillProcessed(id, "completed" | "failed")`). Gap-fill dispatches already write dispatch-log entries, so the join exists.
- Optionally, as a belt-and-braces backstop, have `hasPendingConflictResolution` disregard `'dispatched'` rows whose linked run is no longer in flight (or older than a generous TTL).
- Result: next auto-merge cycle sees DIRTY + no pending + attempts < cap → attempt 2 fires; the existing cap/notify path then behaves as already proven.

## Finding 2 — 🟡 AII-267 guard is bypassed when siblings unblock simultaneously (the normal fan-out case)

**Observed (both runs).** When the seed child completes, *all* siblings become candidates in the **same poll batch** and all dispatch in the same cycle — including two siblings declaring the same file (157+159; 162+164). The `file-overlap` deferral **never fired in either run**.

**Root cause.** `src/index.ts:384–385`: `inFlightSiblings = allCandidates.filter((i) => inFlightIssueIds.has(i.id))` and `selectFileOverlapDeferrals(toProcess, inFlightSiblings)` — candidates in the same `toProcess` batch are never checked **against each other**, only against previously in-flight issues. Simultaneous unblock is the dominant real-world pattern (one blocker releasing N siblings), so the guard misses its primary use case.

**What needs to change.** Apply the overlap check *within* the batch: process `toProcess` in order, accumulate the declared files of accepted candidates, and defer any later candidate whose declared files intersect that accumulated set (union it with genuinely in-flight siblings' files). Deterministic ordering (e.g. by identifier) keeps it stable across cycles.

## Finding 3 — 🟡 (suspected, code-reading) the guard's in-flight set may be near-always empty even across cycles

`inFlightSiblings` is filtered **from `allCandidates`** — but an in-flight issue normally carries `AI-Working` and is therefore excluded from the candidate snapshot entirely. If so, cross-cycle deferral also rarely triggers. Not directly observed (the same-batch bypass fired first in both runs). **Change:** source the in-flight sibling set from the job log / provider snapshot (including `AI-Working` issues), not from the candidate list — and add a unit test where a declaring candidate coexists with an `AI-Working` declaring sibling.

## Finding 4 — minor / polish

- **Cap-exhausted log+notify repeats every poll cycle** for the same PR (observed with #3530: identical line every ~60s). With Slack notify configured this becomes notification spam. Emit once per PR (or on state change).
- **Attempts are counted at enqueue, not successful dispatch** — #3530 reached "cap (2) exhausted" locally without any resolution run ever executing (both dispatches failed on "No dispatch log"). Consider only counting attempts that actually dispatched, or distinguishing dispatch-failure retries from resolution retries.
- **Recovery gap-fills ignore the mapping's `executionMode`** — on a `local-docker` mapping they dispatched via `github-actions, image: workflow-default`. Works, but either honor the mode or document the asymmetry.
- **Cross-instance recovery is impossible by design**: an orchestrator can only recover PRs it has a dispatch-log row for ("No dispatch log for PR #N"). Acceptable for single-orchestrator deployments; worth a docs note.

## What is verified working (do not re-litigate)

Feature-branch grouping; child PRs based on the feature branch on **both** runner paths (AII-258 fix, `:next` and local image); auto-merge of clean children; conflict **detection** and classification; synthetic gap-fill **dispatch** (seconds after enqueue); **single-conflict recovery end-to-end, twice** (Fly PR #3529 → OOL-159 Done; local PR #3534 → OOL-163 Done); no double-enqueue while a resolution is pending; cap + give-up + "leave for a human" via the failed path; parent close + roll-up PR (`feature → testing`) for human review.

## Current live state (evidence preserved)

- Local: **PR #3533 wedged in the livelock** (OOL-164 In Progress, OOL-160 parent waiting) — the primary repro.
- Fly tree: PR #3530 cap-exhausted (secondary evidence); PR #3509 (ool-126 roll-up) untouched, awaiting human review.
- Fly OOL project paused; local orchestrator can be Ctrl-C'd at any time.

---

# RETEST ADDENDUM — 2026-08-04, branch @ `cb5aadc` (AII-277 + AII-278)

Fresh 4-child harness (OOL-165/166–169, `docs/aii264-conflict-test-r2.md`), local orchestrator + local-docker runners built from `cb5aadc`. **Result: PASS.** Cascade ran fully hands-off, seed → triple batch → deferral → conflict recovery → deferred child → parent close → roll-up **PR #3541** (`feature/ool-165 → testing`, CLEAN, human-review).

**Finding 2 (same-batch guard) — FIXED, observed live.** `[poll] Deferring OOL-169: Declared files overlap sibling OOL-167: docs/aii264-conflict-test-r2.md. Deferred until it merges.` logged for 6 cycles; OOL-167 accepted; undeclared OOL-168 dispatched fail-open; OOL-169 released the cycle after OOL-167 went Done and landed cleanly.

**Finding 1 (recovery) — FIXED for the exercised path.** OOL-167's PR #3537 went DIRTY (re-dirtied by #3538's merge) → attempt 1 enqueued, dispatched, resolved, merged within ~3 minutes, OOL-167 Done. Note: with the AII-278 guard active, only one recovery is ever in flight per shared file, so the *racing* attempt-2 path did not occur live — it is covered by the AII-277 unit tests. (The agent-authored narrative inside the test doc claims attempt 2 fired; the orchestrator log shows attempt 1 only — trust the log.)

**Structural observation worth keeping:** AII-278 largely *prevents* the racing scenario that triggered the AII-277 livelock — declared-overlap siblings are serialized at dispatch, so recovery races can now only arise from undeclared overlaps.

**One residual follow-up — pre-fix orphaned rows do not heal.** The pre-existing wedged row for PR #3533 (created under the old build, its job already terminal before the fix deployed) is still `status='dispatched'` after restart; the `updateJobStatus` choke point never fires for jobs that terminalized pre-fix, and auto-merge still logs `resolution in flight` for it. Suggested: a one-time startup sweep (terminalize `dispatched` rows whose linked job is already terminal) or a manual `UPDATE`. New trees are unaffected.

**Minor:** the cap-exhausted *log* line for PR #3530 still prints every poll cycle (notify-once appears to cover notifications only).

---

# R3 ADDENDUM — 2026-08-04, branch @ `9925be0` (adds AII-279)

Fresh 4-child harness (OOL-170/171–174, `docs/aii264-conflict-test-r3.md`), local orchestrator + local-docker runners @ `9925be0`, with the round-1 wedged state (PR #3533 orphaned `dispatched` row; PR #3530 cap-exhausted) preserved as live verification targets.

## Every fix behavior now observed live — the complete matrix

| Behavior | Evidence |
|---|---|
| **AII-279 startup sweep** | Boot: #3533's orphaned row `dispatched`→`completed` in DB → same cycle: `enqueued conflict resolution (attempt 2)` |
| **AII-277 attempt-2 after sweep** | PR #3533 **MERGED** 14:38 → OOL-164 Done → the round-1 tree self-completed → roll-up **PR #3550** (`feature/ool-160 → testing`, CLEAN) |
| **AII-277 racing attempt-2 (organic)** | PR #3546 (OOL-173): attempt-1 went stale → `[gapfill] terminalized 1 queue row(s) … -> completed` → attempt 2 → **MERGED** 14:46 → OOL-173 Done. The original livelock scenario, healing live. |
| **AII-278 cross-cycle deferral** (first live sighting) | `Deferring OOL-172: Declared files overlap sibling OOL-174` — candidate vs *in-flight* sibling via seen-candidates cache (172 lagged one cycle on Linear snapshot consistency) |
| **AII-278 same-batch deferral** | Verified in r2 (OOL-169) |
| **AII-279 cap log-once** | #3530 cap-exhausted line: exactly **1** across the whole run (was 1/cycle) |

## New findings (this round)

1. **🔴 Parent no-work churn loop (top remaining issue).** A grouping parent whose closing work is done and whose roll-up PR is open (awaiting human review) remains dispatchable: it re-dispatches → the run finds no meaningful work → either produces a trivial closing PR that auto-merges into the feature branch **past the open roll-up** (#3551, #3552 for OOL-160) or exits with no PR (`pr_not_found`) → the stuck-watchdog **resets the ticket and clears dedup** → immediate re-dispatch. Observed as a hard ~3-minute loop on BOTH OOL-160 and OOL-165, each iteration a full runner session (~$2–3). Missing guard: **a grouping parent with an open top-of-tree roll-up PR for its feature branch should not be dispatchable** until that PR merges/closes (and the `pr_not_found` reset should not re-arm such parents).
2. **🟡 Harness/procedure race (self-inflicted, worth documenting):** a parent created *and labeled* before its first child exists is a childless labeled issue = a **leaf** — a poll landing in that gap dispatches it standalone (PR #3544, `ool-170-… → testing`). Ordering guidance: create parent → create children → then label parent → then children (or pause polling while staging a tree).
3. 🟡 OOL-172's post-deferral run ended `pr_not_found` and was reset rather than retried to completion (possibly interleaved with the churn loop consuming slots); its tail was not driven to completion because the run was stopped to halt churn.

## Verdict

AII-277/278/279 all function as designed — the conflict-recovery + dispatch-guard machinery is complete and observed end-to-end, including the previously-livelocked state self-healing across a restart. **The one blocking-quality item before relying on grouped cascades unattended is the parent no-work churn loop (finding 1)** — it is a cost/noise bug, not a correctness bug (roll-ups remain correct), but it burns a runner session every few minutes per waiting parent, indefinitely.

---

# R4 ADDENDUM — 2026-08-04, branch @ `6b5b222` (adds AII-264 r3 hold fix `645bd07`)

Boot per the no-`source` env procedure (per-var grep/sed exports). No fresh tree needed: the r3 leftovers were the test. **Result: PASS — the churn loop is dead.**

**Parent hold — FIXED, observed at the exact r3 trigger state.** On boot the monitor reset OOL-165/OOL-160's stale jobs (dispatchable, the precise state that churned in r3); every subsequent poll logged `Holding OOL-165: roll-up PR #3541 is open — no parent work until it merges/closes` (and the OOL-160/#3550 twin) with **zero dispatches, zero containers**. The RE-DISPATCH audit counters revealed r3's churn scale: **84 attempts** on OOL-165 and **52** on OOL-160 — all now converted to holds.

**Full release→hold arc verified.** OOL-170 was parked behind stale leaf PR #3544 (`Ready for Review` from the r3 harness race). Operator closed #3544 + cleared the label/dedup → parent dispatched (transparent `RE-DISPATCH #2` audit line) → closing **PR #3600 → `feature/ool-170` → auto-merged** → `[merge-up] Opened feature→base PR #3601 (awaiting human merge)` → next poll: **`Holding OOL-170: roll-up PR #3601 is open`**. Hold engages automatically on a just-created roll-up.

**Also confirmed this round:** startup sweep correctly silent (0 orphaned rows — r3 healed them all); cap log-once held (#3530: one line at boot, none after); OOL-172 was already Done (its PR #3548 merged in r3 — earlier addendum misattributed #3548 to OOL-174).

**Residual notes (minor):**
- A PR **closed without merge** does not reconcile its ticket — OOL-170 stayed `Ready for Review` until manually cleared. Consider treating closed-unmerged PRs like failures (reset the ticket) so an operator closing a bad PR doesn't strand the issue.
- The `RE-DISPATCH #N` warn line prints before the hold decision, so held parents still emit a would-be-re-dispatch warning each poll — cosmetic ordering.

**Final state:** four roll-up PRs OPEN + CLEAN awaiting human review — **#3601** (ool-170), **#3550** (ool-160), **#3541** (ool-165), **#3509** (ool-126) — with their parents held. The AII-264 fix set (AII-258/266/267/277/278/279 + hold) is fully verified across four rounds; merging or closing each roll-up releases its hold on the next poll.

---

# R5 ADDENDUM — 2026-08-04, final end-to-end @ `6b5b222` under live polling

Fresh 4-child harness (OOL-175/176–179, `docs/aii264-conflict-test-r5.md`) staged with the corrected order (create parent unlabeled → create children → label parent → label children) **while the orchestrator was actively polling**. **Result: PASS — complete lifecycle, ~20 min, no interventions during the cascade.**

Sequence observed: staging survived live polling (parent never dispatched as a leaf; waiting-parent from first sight) → seed PR #3602 merged → triple batch: same-batch deferral (`Deferring OOL-179: … overlap sibling OOL-177`), undeclared OOL-178 fail-open → #3604 (177) merged → #3603 (178) DIRTY → attempt-1 → re-dirtied by #3605 (179, post-deferral, clean) → row terminalized → **attempt-2 → merged** → parent closed (#3606) → `[merge-up] Opened … PR #3607` → **`Holding OOL-175`** on the next poll. Roll-up #3607 CLEAN, awaiting human review.

**One residual observed (new nuance on the r4 close-unmerged note):** a no-own-work parent's first closing run produced no changes → `pr_not_found` → watchdog reset → RE-DISPATCH #2, which happened to write closing notes and broke out. The **pre-roll-up** window has no hold protection, so a parent whose agent repeatedly produces no changes could loop there; today it costs one extra run and is luck-dependent on the agent writing something. Suggested hardening: treat a clean-exit/no-changes closing run of a grouping parent as *finalize* (mark merged/Done and proceed to merge-up) rather than failure+reset.

**Campaign totals (5 rounds):** every mechanism in AII-258/266/267/277/278/279 + the hold fix observed live, most several times. Five roll-ups now open for human review: #3607 (r5), #3601 (r3-tree), #3550 (r1-tree), #3541 (r2-tree), #3509 (ool-126 — real chokepoint implementation, the only non-throwaway).

---

# R6 ADDENDUM — 2026-08-04, finalize-path verification @ `55e405c`

Fresh 4-child harness (OOL-180/181–184, `docs/aii264-conflict-test-r6.md`), parent explicitly instructed to produce no diff in its closing run. Staged with correct ordering under live polling.

## PASS — the r5 hardening works exactly as designed

- **`[monitor] Grouping parent OOL-180: closing run produced no changes — finalized for roll-up (no reset)`** — first attempt, no reset, no second dispatch, no luck required. Roll-up **PR #3612** (`feature/ool-180 → testing`, CLEAN) opened by merge-up immediately after.
- **Child grace-recheck shipped too**: `exited 0 with no PR — re-checking before declaring pr_not_found` observed repeatedly.
- **Guard serialization eliminated all conflicts**: with the seed also declaring the file, 182 AND 184 deferred against in-flight 181, then 184's deferral re-targeted to 182 as the chain advanced; all four child PRs (#3608–#3611) merged with **zero DIRTY states** — recovery never needed.
- **Closed-without-merge roll-ups respected**: `merge-up` skips re-opening roll-ups for the retired trees (`PR #NNNN was closed without merging`). (Minor: that skip line logs every cycle per retired parent — log-once candidate.)

## 🔴 One remaining race, now cleanly isolated: fast auto-merge makes completed children invisible to the run monitor

When auto-merge merges a child PR **before the monitor's first post-exit check** (routine locally: docs-only runs finish <90s and auto-merge runs every poll), the monitor's PR lookup — and the new grace-recheck — apparently search **open** PRs only. The merged PR is invisible → `pr_not_found` → **reset (clears dedup) → re-dispatch of an already-merged child** → the re-run correctly produces no changes → reset again → loop. Observed on OOL-182, then 184, then 183 (3 resets and climbing at shutdown), each cycle a full runner session, while the actual work sat merged on the feature branch the whole time. The merge-poll reconcile did not catch these (it appears to only track PRs whose job rows are still live; the reset removes that linkage).

**Required behavior:** the post-exit PR lookup (and grace-recheck) must consider **merged/closed** PRs for the run's branch — a run whose PR already merged is a *success* (mark the issue Done via the normal reconcile), never `pr_not_found`. Likely also: merge-poll reconciliation keyed by branch/PR rather than live job rows, so a reset can't orphan a merged PR's ticket. Note the parent path already handles its equivalent (finalize); this is the child-side twin. Regression test: child run exits after its PR was already auto-merged → expect Marked Done, no reset, no re-dispatch.

**Verdict:** finalize fix ✅ shipped and verified; grace-recheck ✅ shipped (needs the merged-PR case); the child fast-merge race is the last known defect in the cascade lifecycle. Roll-up #3612 left open for human review as evidence; the churn required stopping the orchestrator manually.

---

## R7 addendum — full-lifecycle verification @ `d3316b6` (merged-PR-aware post-exit lookup): **PASS, zero resets end-to-end**

**Setup.** Local `dev:local` @ `d3316b6`; fresh tree OOL-185 (no-work grouping parent) + OOL-186 (seed, declares) / OOL-187 (declares, UPDATED-BY-2) / OOL-188 (undeclared, UPDATED-BY-3) / OOL-189 (declares, deferral-check); children 2–4 blockedBy the seed; staging order parent-unlabeled → children → label parent → label children. File: `docs/aii264-conflict-test-r7.md`.

**The r6 defect is fixed — observed four times in one run.** Every fast-merge race resolved through the new path, verbatim:
- `[monitor] PR #3613 for OOL-186 already merged — queued Done-reconcile (no reset)`
- `[monitor] PR #3615 for OOL-188 already merged — queued Done-reconcile (no reset)`
- `[monitor] PR #3614 for OOL-189 already merged — queued Done-reconcile (no reset)` ← **post-conflict-resolution path**, not just first-run
- `[monitor] PR #3616 for OOL-187 already merged — queued Done-reconcile (no reset)`

Each was followed by `[reconcile] Marked OOL-18x Done`. `grep -cE "reset|pr_not_found"` over the whole log returns only these `(no reset)` lines plus the parent finalize line — **zero actual resets, zero pr_not_found, zero re-dispatches of merged work**.

**Every cascade mechanism re-verified in the same run:**
1. blockedBy gating: children 2–4 skipped while seed incomplete; parent skipped while children in flight.
2. Seed OOL-186 dispatched alone, PR #3613, merged, Done.
3. Simultaneous unblock: OOL-189 + OOL-188 (undeclared → fails open) dispatched concurrently; **same-batch file-overlap guard deferred OOL-187** (`Declared files overlap sibling OOL-189 … Deferred until it merges`), re-asserted every cycle until #3614 merged, then released and dispatched exactly on the merge condition.
4. Conflict auto-recovery: #3614 went DIRTY after #3615 won the race; attempt 1 enqueued, gap-fill run (GH Actions run 30948957526) succeeded, PR merged.
5. Parent finalize (r5 fix): closing run `completed (exit 0, PR: none)` → `Grouping parent OOL-185: closing run produced no changes — finalized for roll-up (no reset)`.
6. Merge-up: `Opened feature→base PR #3617 for OOL-185 (awaiting human merge)`; closed roll-ups (#3541/#3550/#3601/#3607) correctly skipped, not resurrected.
7. **Post-finalize steady state improved over r5:** OOL-185 drops out of the poll set entirely (`Found 0 ready` every cycle) — no per-cycle `Holding` churn at all; the orchestrator idles clean.

**Merged doc content is semantically perfect** (all four edits survived two races + one conflict resolution): `Status: UPDATED-BY-2` (last writer), `Deferral-check: r7 child 4 was here`, log entries in true merge order (1 → 3 → 4 → 2).

**Boot heal:** the r6 leftovers (OOL-182/183/184, merged PRs #3609–#3611) were already Done at r7 boot — nothing to reconcile; startup was quiet and correct.

**Operational incident (env, not orchestrator):** commit `d3316b6` accidentally tracked `node_modules` as a self-referential symlink (mode 120000, `node_modules -> <repo>/node_modules`). Checkout replaced the real dependency tree; every npm-spawned node died silently with exit 194. It bypassed `.gitignore` because the `node_modules/` (trailing-slash) pattern matches directories only, never symlinks. Local fix: `rm node_modules && npm ci`; branch fix (partner): `git rm --cached node_modules` + add a bare `node_modules` gitignore line.

**Verdict: the AII-264 cascade lifecycle is fully verified.** Runs r1–r7 collectively confirm: PR-base fix, same-batch + cross-cycle file-overlap deferral (incl. chain re-targeting), conflict auto-recovery (attempt 1, racing attempt 2, cap + give-up), startup sweep, cap log-once, parent hold, parent no-op finalize, closed-roll-up non-resurrection, and merged-PR-aware child reconciliation on both first-run and post-recovery paths. **No known defects remain in the grouped-cascade lifecycle.** Evidence roll-ups for human review: #3612 (r6), #3617 (r7).

---

## R8 addendum — final confirmation @ `85147e1`: PASS (2026-08-04)

Fresh tree OOL-190 (parent) / 191 (seed) / 192 (declares) / 193 (undeclared) / 194 (declares) on jodwyer/alpacaWheel, local `dev:local`. Boot clean: node_modules a real untracked directory (bare `.gitignore` line), `npm run typecheck` exits 0 — the `af668d2` symlink fix verified.

**Verbatim evidence.** Criterion 2 (all four children took the merged-PR path): `[monitor] PR #3618 for OOL-191 already merged — queued Done-reconcile (no reset)` · same for #3619/OOL-194, #3620/OOL-193, #3621/OOL-192, each followed by `[reconcile] Marked OOL-19x Done`. Criterion 5: `[monitor] Grouping parent OOL-190: closing run produced no changes — finalized for roll-up (no reset)` → `[merge-up] Opened feature→base PR https://github.com/jodwyer/alpacaWheel/pull/3622 for OOL-190 (awaiting human merge)`; parent then drops out of the poll set (no Holding churn). Criterion 6: exactly four `closed without merging (respecting the veto; logged once)` lines at boot (PRs #3607/#3601/#3541/#3550), zero repeats for the process lifetime. Criterion 1: `grep -E "reset|pr_not_found|re-dispatch" orch-local-r8.log | grep -v "no reset"` returns empty. Criterion 7: merged doc carries all four edits in true merge order (`Status: UPDATED-BY-2` last writer, deferral-check line intact, log order 1→4→3→2). Roll-up #3622 left open.

**Learning 1 — dispatch-pool classification changed the test's shape.** Criteria 3–4 (file-overlap deferral, conflict recovery) did not trigger in r8: the children classified into the **"needing planning" pool and dispatched one per poll cycle**, unlike r7 where the identically-shaped, identically-staged tree fanned out simultaneously from "ready for implementation" (`Found 3 needing planning, 0 ready` → 2 → 1). Each child finished within a single cycle, so no overlap window opened — zero deferrals, zero conflicts, purely serialized. Coverage for those mechanisms stands via r7 on `d3316b6` (delta to `85147e1` is non-behavioral). The classification knob: `readyForImplementation` requires the `Plan-Complete` label (`src/providers/linear.ts` — `labelNames.has("Plan-Complete")`); freshly-labeled children without it route to `needsPlanning`.

**Learning 2 — parent gate is merged-PR-aware on entry, not just exit (benign).** The parent's closing run dispatched while OOL-192's runner container was still finishing: the gate counted 192 complete via its already-merged PR (#3621) before the Linear Done-reconcile landed. Correct under the r6 semantics; noted so the log ordering doesn't surprise later readers.

**Learning 3 — node_modules symlink failure mode, for the record.** A tracked self-referential symlink (mode 120000) at `node_modules` kills every npm-spawned node with a silent exit 194 — banner prints, then nothing; `node script.mjs` directly works, which mimics an env problem. It bypasses `.gitignore` because a trailing-slash pattern matches directories only. Diagnostic shortcut: `ls -ld node_modules` first, before bisecting env vars.

Optional cleanups still open by documented decision (AII-282): gap-fill recovery runs dispatch via GHA regardless of `executionMode`; attempts counted at enqueue. Verdict: **PR #202 clear to merge** (merge decision owned by John).
