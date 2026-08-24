# Close the Loop — Design Decisions

**Date:** 2026-08-12 · **Tracker:** Linear (team AII) · **Repo:** BuildDownAI/AI-Implement
**Baseline (frozen 2026-08-12, testing orchestrator):** 87.0% one-shot approval, 95.1% eventual, 1.13 avg passes, $1.31 avg cost (unplanned cohort). Planning A/B: no lift (86.7% one-shot, 1.20 passes, $1.59 — before planning-run cost). Retry storms: AII-253 = 120 dispatches; BDS-1/BDS-2 = 35 dispatches, zero merges. Zero max_turns hits.

## Objective

Make the AI-Implement harness measurable and self-limiting: cap runaway dispatch storms, expose a per-issue report card (MCP + admin), capture review-escape at merge time, and redesign the per-issue planning comments so each section reaches the consumer that can act on it — all measured against the frozen baseline.

## Scope

**In v1:**
1. Dispatch circuit breaker (consecutive-failure park) — supersedes the dedup-TTL approach.
2. `get_issue_report_card` + `get_fleet_report` MCP tools + one admin page; `terminationReason` persistence fix.
3. Merge-time review-escape capture (passive, at `markMerged`); escape-rate in the report card.
4. PLANNING.md redesign: Implementation Map / Acceptance Bar / Risks; Acceptance Bar wired into the review pass; planned-files machine block feeding the dispatch guard and a planned-vs-actual autopsy line; Jira `fetchPlanningContext` implemented against the new format (Wave 2).
5. Revival of AII-276 (post-push gate reads the external review verdict) as a sibling.

**Deferred:** findings→tracked-items workflow (AII-285), re-review of post-open commits (AII-312), run summaries to Linear (AII-130), phase legibility (AII-131/AII-208), learnings-comments v2 (→ BDS-32, skills repo).
**Out of scope:** per-project admin field for the breaker threshold (env var only); any tracker-side workflow changes; KG ingest changes.

## Decisions

- **Breaker trip condition:** 3 consecutive failed/timed-out dispatches per issue+phase, counter reset on success. Matches the stuck watchdog's 3-attempt convention (AII-117) and AII-282's keep-simple rationale. Rejected: lifetime dispatch cap (blocks legitimate long-lived gap-fill work — AII-253 merged after many legitimate re-dispatches); cost budget (the worst storms fail cheaply — BDS-1/2 would never trip it).
- **Breaker trip action:** park the issue — poll skips it; one classification ticket comment (failure class + run links + unpark instructions); webhook notify; visible in admin Runners view. Unpark is human-only (admin button).
- **Breaker state lives in its own table** (`dispatch_breaker`: issue_id, phase, consecutive_failures, last_conclusion, parked_at) — it must survive dedup-row deletion, which happens on every failure. The poll gate checks it before dispatch.
- **Dedup policy: explicit state supersedes TTL.** AII-259 (TTL) closes as superseded — a timer would auto-unpark storms. AII-194's orphan case (fast-failed dispatch leaves a dead dedup row) folds into the breaker: a fast-fail clears the row *and* counts a failure.
- **Report card is compute-on-read** over dispatch_log / step_log / comment_gapfill_queue / review_fix_dispatches / reconciliation_queue / pr_merge_capture — no materialized columns at current scale. One aggregation module, two consumers: MCP tools on `/mcp` (OAuth-gated, read-only) and one admin SPA page. Supersedes AII-51 and AII-129.
- **`terminationReason` fix:** the feedback-loop step's outputs (approved, iterations, terminationReason, passes[]) must land in `step_log.outputs_json`; today they are NULL everywhere and pass data is reconstructed from sub-steps.
- **Review-escape capture is passive, at `markMerged`:** approval timestamp = last approved `review.N` step; fetch PR commits + reviews; bucket post-approval commits by author class (runner App bot / other bots / human); count external findings by source (claude-review / codex / human); store one `pr_merge_capture` row; `review_escape = approved-then-corrected`. No workflow change for the operator — fixing PRs directly with a local session remains fine and is now measured.
- **Planning comments become three, each with a named consumer:** Implementation Map (implementer, grounding: approach ≤3 sentences, canonical `- Modify:` Files bullets, repo-discovered constraints and hazards, hard length cap), Acceptance Bar (review pass: falsifiable claims injected into the review prompt), Risks & Open Questions (human + implementer, unchanged). Work Units dies — nothing ever consumed it (the fetch never collected it; the `workUnits` parallel path in `implement.ts` has no producer and is removed). Test Plan dies — generic content delivered to the wrong phase.
- **Machine block** (`<!-- ai-implement-planning v:1 … -->`) carries planned files → reused by the sibling file-overlap dispatch guard and by a planned-vs-actual line in the run autopsy (autopsy extended to successful runs).
- **Context re-send discipline:** full planning context on pass 1; Map only on pass 2+.
- **Seed-once migration:** the fetch accepts old AND new comment headers indefinitely; our four repos (AI-Implement, skills, docs, sandbox) get a one-time manual PLANNING.md re-seed. Jira provider implements `fetchPlanningContext` against the new format only.
- **Rollout:** breaker on by default, `AI_IMPLEMENT_BREAKER_THRESHOLD` env var (default 3), documented in `.env.example` in the same change. Planning redesign carries a measurement gate: re-run the baseline after ~30 planned runs on the new format; the redesign must beat 87% one-shot / 1.13 passes or be revised.
- **Testing:** vitest on the breaker state machine (fail/success/fast-fail/park/unpark transitions), merge-capture bucketing (no-review-step and gap-fill edge cases), report-card aggregation (fixtures incl. legacy no-telemetry rows), dual-prefix planning fetch, review-prompt injection. New test files get an explicit typecheck (the suite's known blind spot).
- **Observability:** the report card *is* the observability surface; breaker trips additionally notify via webhook + ticket comment.

## Overlap & Reconciliation

- **AII-51 loop metrics** — Superset (ours). Action: close as superseded once the report-card issue files, link.
- **AII-129 [Obs G2] telemetry + admin UI** — Superset (ours). Action: close as superseded, link.
- **AII-130 [Obs G3] summaries to Linear** — Adjacent. Action: leave in Backlog, link from container.
- **AII-285 findings accounting** — Adjacent (workflow vs. our measurement). Action: leave in Backlog, link; escape data decides its fate.
- **AII-276 post-push gate x external review** — Dependency/sibling. Action: revive into this project, attach, `AI-Implement` label per wave plan.
- **AII-312 review post-open commits** — Adjacent. Action: leave, link.
- **AII-259 dedup TTL** — Superseded by explicit breaker state. Action: close with rationale + link.
- **AII-194 orphaned dedup row** — Subset. Action: close as folded into the breaker issue, link.
- **AII-2 auto-retry recoverable failures** — Superseded (the breaker + existing retry paths are the deliberate version). Action: close with rationale.
- **AII-167 Jira planning artifacts** — Subset. Action: close as folded into the Wave-2 Jira child, link.
- **AII-131 planning→implementation transition** — Adjacent. Action: leave, link.
- **AII-46 reviewer structured JSON** — Stale/superseded by Acceptance Bar wiring. Action: close with rationale.
- **AII-208 phase legibility** — Adjacent. Action: leave.
- **BDS-32 learnings marking** — Related (other team). Action: post the v2 design (MLD sections + promotion ledger + report-card dependency) as a comment on BDS-32; link from container.
- **BDS-35 review-audit process** — Adjacent. Action: leave, link.

## Open Questions

- Whether the admin report page needs per-project filtering in v1 (default: yes, it's one WHERE clause).
- Exact bot-author allowlist for commit bucketing (default: the App's bot login = runner; `*[bot]` = bot; else human).
