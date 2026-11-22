# Close the Loop — Implementation Plan

> **For AI-Implement:** Each task below maps to a tracker issue. The pipeline picks up each issue independently — task descriptions are self-contained.

**Goal:** Cap dispatch storms, ship the per-issue report card (MCP + admin), capture review escape at merge, and redesign planning comments so each section reaches its consumer — measured against the frozen 2026-08-12 baseline (87.0% one-shot, 1.13 avg passes, $1.31/run).

**Architecture:** Three independent rails plus one redesign. Breaker: new `dispatch_breaker` table gates the poll. Report card: compute-on-read aggregation module with MCP + admin consumers. Escape capture: passive GitHub fetch at `markMerged`. Planning: new 3-comment template, dual-prefix fetch, Acceptance Bar injected into the review pass, machine block feeding the existing `parseDeclaredFiles` guard.

**Tech stack:** Node 24 / TypeScript, better-sqlite3 (via `getDb()` from `src/dedup.ts` — never open a second handle), vitest. **`typecheck` excludes `src/__tests__` and vitest strips types unchecked — every new test file gets an explicit `npx tsc --noEmit -p` pass with a throwaway tsconfig.**

**Tracker container:** Linear project (created at filing; both docs attached).

---

## File structure

| File | Task | Responsibility |
|---|---|---|
| `src/dispatch-breaker.ts` (new) | 1 | breaker table + state machine, single owner of park/unpark |
| `src/index.ts` | 1 | poll gate + failure/success accounting calls |
| `src/admin.ts` | 2, 6 | parked-list/unpark endpoints; report endpoint |
| `src/admin-ui/pages/runners.ts` | 2 | parked banner + unpark button |
| `src/run-autonomous.ts` | 3, 9 | feedback-loop outputs reporting; autopsy on success |
| `src/merge-capture.ts` (new) | 4 | `pr_merge_capture` table + capture-at-merge |
| `src/reconcile-merged.ts` | 4 | call capture after `markMerged` |
| `src/report-card.ts` (new) | 5 | all aggregation queries (issue card, fleet, runaways) |
| `src/mcp.ts` | 5 | two new diagnostic tools |
| `src/admin-ui/pages/reports.ts` (new) | 6 | report page |
| `src/admin-ui/index.ts`, `src/admin-ui/sidebar.ts` | 6 | page registration |
| `workflows/PLANNING.md` | 7 | v2 template (Map / Bar / Risks + machine block) |
| `src/run-planning.ts` | 7 | built-in planning prompt → 3 comments |
| `src/linear-planning-fetch.ts` | 7 | dual-prefix fetch (old + new headers) |
| `src/pipeline/steps/implement.ts` | 7 | remove dead `workUnits` path |
| `src/pipeline/steps/feedback-loop.ts` | 8 | split Bar from context; pass-aware resend |
| `src/pipeline/steps/review.ts` | 8 | `acceptanceBar` input in review prompt |
| `src/planning-block.ts` (new) | 9 | machine-block parser |
| `src/poll-selection.ts` | 9 | guard accepts planning-block files |
| `src/run-autopsy.ts` | 9 | planned-vs-actual line; success stat |
| `src/providers/jira.ts` | 10 | real `fetchPlanningContext` |
| `.env.example` | 1 | `DISPATCH_BREAKER_THRESHOLD` |

---

### Task 1: Dispatch circuit breaker core

**Shape:** deep-and-targeted · **Migration/backfill?** no (additive table, created on init like every other table)

**Files:**
- Create: `src/dispatch-breaker.ts`
- Modify: `src/index.ts` (poll gate ~line 391; failure paths that call `deleteDispatched`/skip `markDispatched`; success path)
- Modify: `.env.example` (new var, grouped with reaper/watchdog vars)
- Test: `src/__tests__/dispatch-breaker.test.ts`

**Parallel-safe with:** Tasks 3, 4, 7, AII-276 · **Blocked by:** —

**Rubric:** Pattern anchor: `src/dedup.ts` (table init + accessor style), `src/stuck-watchdog.ts` (bounded-attempts + give-up notify). Test fixture: `src/__tests__/` sqlite-backed dedup tests. Trust boundary: none (internal state). Rollback: set `DISPATCH_BREAKER_THRESHOLD=0` to disable (0 = never trip). Observability: ticket comment + webhook notify on trip; parked rows in admin (Task 2). Parallel-safety: verified, no file overlap with peers.

- [ ] **Step 1: failing tests** — state machine transitions:

```ts
import { recordDispatchFailure, recordDispatchSuccess, isParked, unpark } from "../dispatch-breaker.js";
// threshold 3 via env in beforeEach
it("parks on 3rd consecutive failure, not before", () => {
  recordDispatchFailure("iss-1", "implementation", "exit_1");
  recordDispatchFailure("iss-1", "implementation", "exit_1");
  expect(isParked("iss-1", "implementation")).toBe(false);
  recordDispatchFailure("iss-1", "implementation", "exit_1");
  expect(isParked("iss-1", "implementation")).toBe(true);
});
it("success resets the counter", () => { /* 2 fails, success, 2 fails → not parked */ });
it("phases count independently", () => { /* planning fails don't park implementation */ });
it("unpark clears parked_at AND counter", () => { /* after unpark, 2 more fails → still not parked */ });
it("threshold 0 disables tripping", () => { /* 10 fails → never parked */ });
it("trip returns true exactly once (comment/notify fire once)", () => {
  /* recordDispatchFailure returns {tripped: boolean}; 4th failure → tripped false */
});
```

- [ ] **Step 2: implement `src/dispatch-breaker.ts`**

```ts
// Table (init pattern mirrors dedup.ts):
// CREATE TABLE IF NOT EXISTS dispatch_breaker (
//   issue_id TEXT NOT NULL, phase TEXT NOT NULL,
//   consecutive_failures INTEGER NOT NULL DEFAULT 0,
//   last_conclusion TEXT, last_failure_at INTEGER, parked_at INTEGER,
//   PRIMARY KEY (issue_id, phase))
export function recordDispatchFailure(issueId: string, phase: string, conclusion: string):
  { tripped: boolean; failures: number } { /* upsert; trip when count reaches threshold() && !parked */ }
export function recordDispatchSuccess(issueId: string, phase: string): void { /* reset counter, keep parked rows parked */ }
export function isParked(issueId: string, phase: string): boolean {}
export function unpark(issueId: string, phase?: string): boolean {}
export function listParked(): Array<{ issueId: string; phase: string; failures: number; lastConclusion: string | null; parkedAt: number }> {}
function threshold(): number { return Number(process.env.DISPATCH_BREAKER_THRESHOLD ?? 3); }
```

- [ ] **Step 3: wire `src/index.ts`.** (a) Poll gate: extend the `isAlreadyDispatched(issueId) || inFlightIssueIds.has(issueId)` predicate (~line 391) with `|| isParked(issueId, phase)`. (b) Every terminal-failure path that today clears/skips dedup (`deleteDispatched` at ~line 290, the intentionally-not-marked paths at ~962/~1084, and the monitor's failed/timed_out handling) calls `recordDispatchFailure(issueId, phase, conclusion)`; the **fast-failed dispatch path also clears its dedup row** (AII-194 fix — today it orphans). (c) Completion-success path calls `recordDispatchSuccess`. (d) On `tripped: true`: post one ticket comment via the mapping's provider (`provider.postComment`) — first line `**⛔ AI-Implement parked this issue**`, then failure count, last conclusion, run links from `dispatch_log`, and "Unpark: admin → Runners → Unpark, or ask the operator" — and send `notifyText` to the configured webhook. Comment posting is best-effort (log, never throw).
- [ ] **Step 4: `.env.example`** — add `DISPATCH_BREAKER_THRESHOLD` with comment: consecutive failed dispatches per issue+phase before parking; `0` disables; default `3`.
- [ ] **Step 5:** `npm test` + `npm run typecheck` + explicit test-file typecheck. Commit.

---

### Task 2: Breaker admin surface (parked list + unpark)

**Shape:** deep-and-targeted · **Migration/backfill?** no

**Files:**
- Modify: `src/admin.ts` (GET `/api/parked`, POST `/api/parked/unpark` — mirror the existing dedup-delete endpoint at ~line 332)
- Modify: `src/admin-ui/pages/runners.ts` (parked banner + per-row Unpark button, `window.api()` calls)
- Test: `src/__tests__/admin-parked.test.ts` (endpoint behavior over a seeded breaker table)

**Parallel-safe with:** 3, 4, 5, 7–10 · **Blocked by:** Task 1 (module exists)

**Rubric:** Pattern anchor: existing Runners page + `admin.ts` dedup endpoints. Test fixture: existing admin endpoint tests. Trust boundary: admin auth already gates `/api/*` — no new surface. Rollback: mechanical. Observability: n/a (it *is* the surface). Parallel-safety: `src/admin.ts` also touched by Task 6 → **Task 6 is blocked by Task 2** (serialized hotspot).

Steps: failing endpoint test (GET returns seeded parked rows; POST unparks and re-poll dispatches) → implement endpoints calling `listParked`/`unpark` → banner UI (`registerPage` IIFE convention, `window.esc()` for issue ids) → tests/typecheck → commit.

---

### Task 3: Persist feedback-loop outputs (terminationReason) to step_log

**Shape:** deep-and-targeted · **Migration/backfill?** no

**Files:**
- Modify: `src/run-autonomous.ts` (the feedback-loop step report; fix is expected here — diagnose first)
- Test: extend `src/__tests__/run-autonomous.test.ts`

**Parallel-safe with:** 1, 2, 4, 7, AII-276 · **Blocked by:** — (Task 9 is blocked by this — shared `run-autonomous.ts`)

**Rubric:** Pattern anchor: the sub-step reporting in `feedback-loop.ts` (~line 276: outputs assigned before final `reporter.report`). Test fixture: existing run-autonomous tests with a stub reporter. Trust boundary: none. Rollback: mechanical. Observability: `SELECT json_extract(outputs_json,'$.terminationReason') FROM step_log WHERE step_type='feedback-loop'` non-null on new runs — this is the acceptance probe.

Steps: **Diagnose** — on the deployed data every `feedback-loop` row has `outputs_json='{}'` even though `feedbackLoopStep.run()` returns `{approved, iterations, finalFeedback, terminationReason, passes}` (`feedback-loop.ts:391`); trace where run-autonomous reports that step and why outputs are dropped (likely the step is reported `running` and never re-reported with outputs, or outputs are attached after the final report). Write the failing test asserting the reporter received the outputs object on the terminal report → fix → cap `finalFeedback` at 4KB in the reported outputs (callback payload hygiene) → tests/typecheck → commit.

---

### Task 4: Merge-time review-escape capture

**Shape:** deep-and-targeted · **Migration/backfill?** no (new table only)

**Files:**
- Create: `src/merge-capture.ts`
- Modify: `src/reconcile-merged.ts` (call after successful `markMerged`, ~line 37, best-effort)
- Test: `src/__tests__/merge-capture.test.ts`

**Parallel-safe with:** 1, 2, 3, 7, 8, 10, AII-276 · **Blocked by:** —

**Rubric:** Pattern anchor: `src/github.ts` App-auth REST helpers; `run-autopsy.ts` best-effort style. Test fixture: mocked `fetchImpl` pattern from `linear-planning-fetch.ts` tests. Trust boundary: GitHub API reads with existing App token — no new grants. Rollback: capture is best-effort and additive; a failure logs and never blocks reconciliation. Observability: capture-rate visible in report card (rows vs merged PRs).

- [ ] **Step 1: failing tests** — author bucketing and escape logic:

```ts
it("buckets commits: app bot=runner, *[bot]=bot, else human", () => { /* three-author fixture */ });
it("escape=true when approved and post-approval human/bot commits exist", () => {});
it("escape=false when approval absent (never-approved draft PR merged manually)", () => {});
it("no approval timestamp → all commits counted, approval_ts null", () => {});
it("markMerged flow continues when GitHub fetch throws", () => {});
```

- [ ] **Step 2: implement.** Table: `pr_merge_capture (repo TEXT, pr_number INTEGER, issue_id TEXT, merged_at INTEGER, approval_ts INTEGER, commits_runner INTEGER, commits_bot INTEGER, commits_human INTEGER, post_approval_lines INTEGER, findings_json TEXT DEFAULT '{}', review_escape INTEGER, captured_at INTEGER, PRIMARY KEY (repo, pr_number))`. `capturePrMerge({repo, prNumber, issueId})`: approval_ts = `MAX(ended_at)` of approved `review.N` rows joined via `dispatch_log` for the issue; GET `/repos/:repo/pulls/:n/commits` and `/reviews` + `/comments`; bucket by author login (App bot slug = runner, `endsWith("[bot]")` = bot, else human); findings_json = counts per source; `review_escape = approval_ts != null && (post-approval human+bot commits > 0 || external findings > 0)`.
- [ ] **Step 3:** wire into `reconcile-merged.ts` inside a try/catch logging `[merge-capture]`. Tests/typecheck. Commit.

---

### Task 5: Report-card module + MCP tools

**Shape:** deep-and-targeted · **Migration/backfill?** no

**Files:**
- Create: `src/report-card.ts`
- Modify: `src/mcp.ts` (append two entries to the diagnostic tools array ~line 34–58; two cases in `callDiagnosticTool` ~line 73)
- Test: `src/__tests__/report-card.test.ts`

**Parallel-safe with:** 2, 7, 8, 9, 10 · **Blocked by:** Task 3 (reads feedback-loop outputs first-class), Task 4 (escape columns read `pr_merge_capture`)

**Rubric:** Pattern anchor: `get_issue_dispatch_status` (`mcp.ts:118`) for tool shape; `scripts/baseline-report.sql` is the *specification* of the aggregations — port its TEMP-view logic (fb_loop preferred, substep fallback, fixture filter) to SQL-in-TS. Test fixture: seeded sqlite with three eras of rows (no-telemetry legacy, substep-only, full feedback-loop outputs) asserting identical numbers to the script's hand-checked results. Trust boundary: `/mcp` OAuth gate already covers new tools; read-only. Rollback: additive tools. Observability: n/a.

`getIssueReportCard(identifier)` → `{issue, repo, runs[], totals: {dispatches, passes, cost_usd, max_turns_hits}, approved, planned, merged, escape: {post_approval_commits, external_findings, review_escape} | null, gapfill_rounds, review_fix_rounds, parked}`. `getFleetReport({days=30})` → per-repo aggregates + one_shot_pct + planning A/B cohorts + escape_rate + `runaways` (open issues ranked by consecutive failures / dispatch count, threshold ≥3). Steps: failing aggregation tests → module → MCP registration (`get_issue_report_card` requires `issue`; `get_fleet_report` optional `days`) → tests/typecheck → commit.

---

### Task 6: Admin Reports page

**Shape:** deep-and-targeted · **Migration/backfill?** no

**Files:**
- Create: `src/admin-ui/pages/reports.ts`
- Modify: `src/admin-ui/index.ts` (import + both strings), `src/admin-ui/sidebar.ts` (route), `src/admin.ts` (GET `/api/report?days=30&project=` → `getFleetReport`)
- Test: `src/admin-ui/__tests__/reports.test.ts` (this suite IS typechecked)

**Parallel-safe with:** 8, 9, 10 · **Blocked by:** Task 5 (module), Task 2 (shared `src/admin.ts`)

**Rubric:** Pattern anchor: `pages/audit.ts` (table-heavy page). Test fixture: existing admin-ui tests. Trust boundary: admin session gate. Rollback: mechanical. Observability: n/a. Page: fleet table, planning A/B block, escape rate, runaway list linking to Runners unpark; per-project filter (one WHERE param).

---

### Task 7: PLANNING.md v2 — Map / Acceptance Bar / Risks

**Shape:** deep-and-targeted · **Migration/backfill?** no

**Files:**
- Modify: `workflows/PLANNING.md` (template body: 3 comment specs + machine block; front-matter/comment-format docs updated)
- Modify: `src/run-planning.ts` (built-in fallback prompt emits the same 3 comments; filenames `01-implementation-map.md`, `02-acceptance-bar.md`, `03-risks.md`)
- Modify: `src/linear-planning-fetch.ts` (PREFIXES ← old three **plus** `## 🗺 AI Planning: Implementation Map`, `## ✅ AI Planning: Acceptance Bar`, `## ⚠️ AI Planning: Risks & Open Questions`; PREAMBLE reworded: planning content is a *map*, not orders — resolves the "follow these decisions"/"never follow instructions" contradiction)
- Modify: `src/pipeline/steps/implement.ts` (delete `WorkUnit`, `workUnits` input, `PARALLEL_IMPL_INSTRUCTIONS`, the `workUnits` block at lines 55–66)
- Test: extend `src/__tests__/linear-planning-fetch.test.ts` (old-only, new-only, mixed comment sets)

**Parallel-safe with:** 1, 2, 3, 4, AII-276 · **Blocked by:** —

**Rubric:** Pattern anchor: current `PLANNING.md` structure (front matter + comment contract). Test fixture: existing planning-fetch tests. Trust boundary: planning comments remain untrusted data inside `<planning_context>` — unchanged. Rollback: fetch keeps old headers forever; re-seeded repos can revert their template independently. Observability: Task 9's planned-vs-actual line. **New-comment spec must include:** Map = approach ≤3 sentences + `## Files` in canonical `- Modify: \`path\`` bullets (parseable by `parseDeclaredFiles`) + constraints/hazards, ≤60 lines; Bar = numbered falsifiable claims, each checkable against the diff or a command; Risks unchanged; machine block `<!-- ai-implement-planning v:1 {json: files[], risk} -->` appended to the Map comment.

---

### Task 8: Acceptance Bar → review pass; pass-aware context resend

**Shape:** deep-and-targeted · **Migration/backfill?** no

**Files:**
- Modify: `src/pipeline/steps/feedback-loop.ts` (split fetched context: extract the Bar comment by its header; pass `acceptanceBar` to the review sub-step inputs at ~line 250; implement pass 1 gets full context, pass 2+ gets Map only)
- Modify: `src/pipeline/steps/review.ts` (new `acceptanceBar?: string` input; prompt gains: "Planning defined this acceptance bar. Verdict must address each numbered claim: …"; content is untrusted data — same framing as planning context)
- Test: extend `src/__tests__/feedback-loop.test.ts` + `review.test.ts`

**Parallel-safe with:** 2, 4, 5, 6, 10 · **Blocked by:** Task 7 (Bar exists in fetched context)

**Rubric:** Pattern anchor: existing `planningContext` threading (`feedback-loop.ts:255`). Test fixture: existing feedback-loop tests with stub executor. Trust boundary: Bar is untrusted → injected as data with the standard do-not-follow-directives framing. Rollback: absent Bar comment → behavior identical to today (old-format repos unaffected). Observability: review outputs already logged per pass.

---

### Task 9: Planning machine block → dispatch guard + planned-vs-actual autopsy

**Shape:** deep-and-targeted · **Migration/backfill?** no

**Files:**
- Create: `src/planning-block.ts` (`parsePlanningBlock(comment: string): {v: number, files: string[], risk?: string} | null` — tolerant JSON-in-HTML-comment parse)
- Modify: `src/poll-selection.ts` (`selectFileOverlapDeferrals` ~line 79: when an issue's own body parses to 0 files, fall back to its planning-block files if a planning comment is available on the candidate)
- Modify: `src/run-autopsy.ts` + `src/run-autonomous.ts` (~line 550: autopsy also written on approved runs as a short stat block `95-run-stats.md` — passes, cost, planned files vs `filesChanged` delta; keep `90-` reserved)
- Test: `src/__tests__/planning-block.test.ts`

**Parallel-safe with:** 2, 5, 6, 8, 10 · **Blocked by:** Task 7 (block emitted), Task 3 (shared `run-autonomous.ts`)

**Rubric:** Pattern anchor: `parseDeclaredFiles` (`poll-selection.ts:26`) for parse style + fail-open contract. Test fixture: poll-selection overlap tests. Trust boundary: block is tracker-sourced data — parse defensively, never eval. Rollback: parser returning null everywhere = today's behavior. Observability: the stat line itself.

---

### Task 10: Jira planning-context fetch (new format only)

**Shape:** deep-and-targeted · **Migration/backfill?** no

**Files:**
- Modify: `src/providers/jira.ts` (~line 581: implement `fetchPlanningContext` via `this.client` comment fetch; collect the three v2 headers, newest per header, same 40KB cap + `<planning_context>` sanitization — extract the shared assembly from `linear-planning-fetch.ts` into `src/planning-context-assembly.ts` and reuse)
- Create: `src/planning-context-assembly.ts` (header-select + cap + sanitize, shared by both providers)
- Modify: `src/linear-planning-fetch.ts` (delegate assembly to the shared module)
- Test: `src/__tests__/jira-planning-fetch.test.ts`

**Parallel-safe with:** 2, 5, 6, 8, 9 · **Blocked by:** Task 7 · **Folds:** AII-167

**Rubric:** Pattern anchor: `linear-planning-fetch.ts` (assembly contract, ADF-to-text via existing jira helpers). Test fixture: linear-planning-fetch tests. Trust boundary: same untrusted framing. Rollback: returns `""` on any error — today's behavior. Observability: planned cohort appears for Jira repos in fleet report.

---

### Task 11 (operator, no pipeline label): Re-seed + re-baseline

**Files:** target repos' `PLANNING.md` (AI-Implement, skills, docs, sandbox) — manual PRs; then after ~30 planned runs, re-run `scripts/baseline-report.sql` and compare against this plan's frozen baseline.

**Blocked by:** 7, 8, 9. Routing: operator (no `AI-Implement` label). Acceptance: four repos on v2 template; a dated comparison comment on the container project (beat 87% one-shot / 1.13 passes, or file the revision).

---

## Cross-sibling file-intersection audit (declared `## Files` parse)

All tasks parse ≥1 file via the canonical bullets. Pairwise verdicts for tasks claiming parallel-safety:

- 1 ∩ {3,4,7} = ∅ (index.ts vs run-autonomous/merge-capture/planning files) ✓
- 3 ∩ 9 = **`src/run-autonomous.ts`** → 9 Blocked by 3 ✓ (serialized)
- 2 ∩ 6 = **`src/admin.ts`** → 6 Blocked by 2 ✓ (serialized)
- 7 ∩ 8 = ∅ (implement.ts vs feedback-loop/review.ts) — 8 blocked by 7 anyway ✓
- 7 ∩ 10 = **`src/linear-planning-fetch.ts`** → 10 Blocked by 7 ✓ (already serialized)
- 4 ∩ 5 = ∅ (merge-capture writes table; report-card reads via SQL only) — 5 blocked by 4 anyway ✓
- 5 ∩ 6 = ∅ on files (report-card.ts vs admin files) — 6 blocked by 5 anyway ✓
- AII-276 ∩ all = ∅ (post-push gate files: `src/pipeline/steps/post-push-review.ts` area) ✓

## Waves

- **Wave 1 (Todo + label):** 1, 3, 4, 7, AII-276 (revived)
- **Wave 2 (Backlog → promote as blockers merge):** 2 (←1), 5 (←3,4), 8 (←7), 9 (←7,3), 10 (←7), 6 (←5,2)
- **Operator:** 11 (←7,8,9)

**Critical path:** 7 → 8/9 → 11 (re-baseline) and 3/4 → 5 → 6. Two chains of depth 3 — with Wave 1 running in parallel, minimum ~3 dispatch generations.

## Self-review notes

- Every design-doc decision maps to a task (breaker→1/2; report card→5/6; terminationReason→3; escape→4; planning→7/8/9/10; measurement gate→11; AII-276→revival).
- No TBDs; naming consistent (`dispatch_breaker`, `pr_merge_capture`, `parsePlanningBlock`, `DISPATCH_BREAKER_THRESHOLD`).
- Reconciliation actions (close/fold/link for AII-2/46/51/129/167/194/259 + BDS-32 comment) execute at filing time, not as tasks.
