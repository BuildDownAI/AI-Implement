# 018. Adopt Restate one run kind at a time; the run-ledger program is contingent

**Status:** Proposed
**Date:** 2026-09-10. Amended 2026-09-14: case order swapped; the three-slice rule added. Amended 2026-09-23: the review-fix pilot becomes the first run lifecycle.

## Context

ADR 017 records the direction: move the run lifecycle onto a durable-execution engine (Restate). The original sequence ("Plan, Part 1" §8 and "Plan, Part 2" §8) put the run-ledger program first — the idempotent signed report, credential scoping, and the run-kind contract, tracked as AII-611 — and only then migrated run kinds. AII-611 is large, touches every live report path at once, and would bring instability before any evidence that the engine direction pays.

Two facts moved since that sequence was written. The integration-testing tree (AII-441) stands alone — its callback branch is verify-only by construction and depends on nothing in AII-611. And kg-refresh became a nearly standard run kind: AII-583 deleted its special push-credential path, and the AII-555 lane moved its dispatch onto the standard workflow.

## Decision

We adopt Restate one run kind at a time and make the run-ledger program contingent on evidence:

1. Review-fix first (operator decision, 2026-09-23): Restate controls GitHub Actions review-fix attempts that start after the previous runner stops. The runner keeps its existing internal review/fix cycles. Local Docker review-fix and other run lifecycles remain outside this migration. The harness and sidecar already exist. The pilot follows the [review-fix research](../research/2026-09-23-restate-review-fix-explained.md); the pilot design was approved at the mega-build-up design gate on 2026-09-24.
2. Keep the kg-refresh migration (AII-682) queued after the review-fix pilot. Keep the feedback-loop test surface (AII-629) as later work; it supplies the injected-executor seam for AII-440. This amendment changes their order, not their implementation scope.
3. Keep integration testing (the AII-441 tree) as later work, building on the proven harness and server and judged against its written criteria.
4. Each migration flips **its own** callback branch to verify-only: the token is validated, never consumed, and a duplicate report is absorbed by a Restate idempotency key. This is a per-path slice of the AII-611 idea, carried inside each migration.
5. SQLite stays the system of record. Every migrated run kind writes its dispatch row, run record, and conclusion to SQLite from journaled steps. Restate holds workflow position and, where a run kind needs one-at-a-time execution, the in-flight marker of a Virtual Object gate. The review-fix pilot also requires shared atomic admission across competing legacy and Restate dispatch paths. SQLite remains authoritative for business run history; the Restate journal provides execution diagnostics. Existing admin history remains readable; the pilot extends the job view with correlated lifecycle and activity evidence. KG ingest is outside the pilot.
6. Each migration lands as three slices on its feature branch: **add** (the workflow module and its scenarios, no production wiring), **switch** (every production path onto the workflow, with the legacy code kept inert so the slice is revertible alone), **delete** (the legacy glue, its tests, and the docs). The add slice shares no file with the deploy work, so it runs beside it.
7. After the second migration, a written evaluation gate decides: the main pipeline migrates the same way and AII-611 is cancelled or narrowed, or AII-611 proceeds first. The decision lands on AII-611, and ADRs 017, 018, and 023 move to Accepted or Rejected.
8. Before kg-refresh starts, the review-fix pilot passes its own evaluation gate: the specified failure scenarios, a live restart recovery, and ADR 017's one-week footprint and operating criteria. Passing CI and one ordinary live run is insufficient. The broader run-ledger decision still follows two run lifecycle migrations.

## Alternatives considered

- **Keep kg-refresh first** — superseded by the operator on 2026-09-23. The review-fix pilot tests durable coordination around an external runner, including feedback received during an attempt and uncertain launch recovery. The existing kg-refresh work remains queued for later.
- **Green-field first (integration testing before kg-refresh)** — the order this ADR first recorded. Rejected by the operator on 2026-09-14: it defers value on the buggiest live glue, and the deployment risk exists in the first case either way, because the SDK dependency enters the image with the harness.
- **Ledger first (the original sequence)** — rejected for now: it changes every live report path before any migration exists to justify it.
- **Big-bang pipeline migration** — rejected: it replaces roughly twelve live modules at once; a failure is neither cheap nor local.
- **One PR per migration** — rejected on 2026-09-14: the first case's single issue changed nine files and adapted five test files; one review cannot hold the cutover and the deletion at once.
- **No Restate at all** — remains the recorded fallback: if a case fails its criteria, the pre-Restate bodies are the fallback design and ADR 017 is Rejected.

## Consequences

- Easier: evidence precedes program. Each step deletes hand-rolled lifecycle glue instead of adding a parallel system. A failure at any step is local and reversible: the switch slice reverts alone.
- Harder: token handling is heterogeneous during the transition — unmigrated paths consume single-use tokens while migrated paths verify only. The evaluation gate must resolve the end state so the split does not become permanent.
- The run-ledger ADRs stay Proposed longer, and draft PR #495 stays a draft until the gate.
