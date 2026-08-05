# Cascade Conflict Recovery — Design Decisions

Source issue: [AII-264](https://linear.app/eudoxus/issue/AII-264) · bd-mega-build-up 2026-07-31
KG recon: fresh graph (5h); decisive priors AII-263 (adjacent stall family), AII-222→252→134 (auto-merge engine, shipped), AII-243 (comment-gapfill rail), BDS-16 (skills-side sequencing home).

## Objective

When parallel children of a grouping cascade conflict on shared files, the orchestrator recovers automatically — a DIRTY child PR gets an agent-driven conflict resolution and merges without human intervention — and a lightweight dispatch guard makes the collision less likely in the first place.

## Scope

**In v1:**
1. **Detection** — in `auto-merge.ts`, a failed merge attempt (non-`merged` result on a grouping-branch PR) is classified via a named seam (`classifyStalledChild()`-shaped) as a *conflict stall*.
2. **Recovery** — enqueue a **synthetic conflict-resolution entry** on the existing `comment_gapfill_queue`; the gap-fill run executes the bd-build-down Phase-2f template (*merge the feature branch into the PR branch, resolve keeping both sides' intent, re-run tests, push*); the next auto-merge tick merges the now-clean PR.
3. **Guardrails** — per-PR attempt cap **2**, derived by counting the PR's prior synthetic rows (no new table); `INSERT OR IGNORE` on a deterministic synthetic key prevents double-enqueue while one is in flight; **re-dirty after a successful resolve = fresh attempt**; on cap exhaustion → `notify` (existing hook) with PR + conflicting files, then today's "leave for a human."
4. **Prevention (lightweight, fail-open)** — at poll selection, when ≥2 children of one feature node are parallel candidates: regex-parse declared `Files:`/`Modify:` paths from issue bodies; if a candidate's declared set intersects an **in-flight** sibling's, defer it until that sibling merges. No parsable list → dispatch as today (zero behavior change for hand-written issues).

**Deferred:** AII-263 (max_turns/draft stalls) — consumes the detection seam later, separate build-up. Skills-side sibling file-intersection audit — **BDS issue** (fold toward BDS-16), filed in Phase 4 reconciliation.

**Out of scope:** blind/union git merges (never, not even as fallback); provider/Jira work (nothing here is provider-specific); configurable attempt cap (fixed 2, YAGNI).

## Decisions

- **Detection point:** the merge *attempt* result, not a `mergeable` pre-check — `listOpenPullRequests` doesn't return mergeability (GitHub computes it lazily); the attempt is authoritative and already made. Rejected: polling GET-PR mergeable (extra calls, async-compute races).
- **Remediation rail:** reuse `comment_gapfill_queue` + `enqueueCommentGapfill` with a synthetic entry. Rejected: orchestrator-side git merge (semantic conflicts need judgment — OOL-148's conflict was in a file six siblings edited); new dedicated queue (duplicates queue/worker/dispatch plumbing).
- **Synthetic keying:** deterministic negative `comment_id` derived from PR number + attempt index — collision-free with real webhook comment IDs (always positive), and gives per-attempt uniqueness plus in-flight dedup via the existing unique key + `INSERT OR IGNORE`.
- **Cap accounting from the queue itself:** count completed synthetic rows for the PR. Rejected: new attempts column/table (state that can drift; the queue already remembers).
- **Prevention lever:** verify declared files, don't predict — the spec's `Files:` section is the only cheap, already-present signal. Rejected: serializing all siblings (kills the throughput win); code analysis/LLM prediction (heavyweight).
- **Trust boundary:** the instruction text is orchestrator-composed (not user input); the gap-fill dispatch path already verifies commenter permissions for real comments — synthetic entries bypass the webhook entirely (internal origin, marked as such).
- **Testing:** unit tests mirroring the existing auto-merge suite — conflict classification, enqueue-once dedup, cap enforcement, notify-on-exhaustion, synthetic-key derivation; poll-selection tests for overlap deferral (intersect / no-list / no-sibling cases). No e2e (rail covered by AII-243 tests).
- **Observability:** log line per detection/enqueue/deferral; `notify` on cap exhaustion (alerted stall replaces silent stall).

## Overlap & Reconciliation

- **AII-263 max_turns draft stall** — Adjacent. Action: keep separate; this build-up ships the named detection seam it will consume. Reference in both issues.
- **AII-260 parent re-dispatch loop** — Adjacent (different surface, parent finalize; no shared files). Action: ignore-with-rationale.
- **AII-252 / AII-134 auto-merge engine** — Dependency, satisfied (Done on `testing`). Action: build on it.
- **AII-186 run-ID stall** — different stall class (dispatch latency). Action: ignore-with-rationale.
- **BDS-16 bd-summit-push cascade-aware sequencing** — Adjacent, skills repo. Action: file the skills-side sibling file-intersection audit as a BDS issue referencing it (Phase 4).

## Open Questions

None load-bearing. Default carried: cap fixed at 2; prevention guard scoped to same-feature-node siblings only (cross-tree overlaps out of scope).
