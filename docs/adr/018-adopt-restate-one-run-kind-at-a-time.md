# 018. Adopt Restate one run kind at a time; the run-ledger program is contingent

**Status:** Proposed
**Date:** 2026-09-10. Amended 2026-09-14: case order swapped; the three-slice rule added.

## Context

ADR 017 records the direction: move the run lifecycle onto a durable-execution engine (Restate). The original sequence ("Plan, Part 1" §8 and "Plan, Part 2" §8) put the run-ledger program first — the idempotent signed report, credential scoping, and the run-kind contract, tracked as AII-611 — and only then migrated run kinds. AII-611 is large, touches every live report path at once, and would bring instability before any evidence that the engine direction pays.

Two facts moved since that sequence was written. The integration-testing tree (AII-441) stands alone — its callback branch is verify-only by construction and depends on nothing in AII-611. And kg-refresh became a nearly standard run kind: AII-583 deleted its special push-credential path, and the AII-555 lane moved its dispatch onto the standard workflow.

## Decision

We adopt Restate one run kind at a time and make the run-ledger program contingent on evidence:

1. kg-refresh first (operator decision, 2026-09-14; AII-682): its lifecycle glue is the buggiest of its kind — the reaper rules alone needed two fix rounds — and the run kind is nearly standard since AII-583 and AII-555. The Restate harness and the sidecar server land inside this case; the consequence, accepted, is that the first case is not deployment-free.
2. The feedback-loop test surface second (CI only, no deployment; AII-629): the implement/review loop extracted behind an injected executor and tested as a workflow with testcontainers. This case is the seam the multi-agent work (AII-440) builds on.
3. Integration testing after that (the AII-441 tree), building on the proven harness and server, judged against its written criteria.
4. Each migration flips **its own** callback branch to verify-only: the token is validated, never consumed, and a duplicate report is absorbed by a Restate idempotency key. This is a per-path slice of the AII-611 idea, carried inside each migration.
5. SQLite stays the system of record. Every migrated run kind writes its dispatch row, run record, and conclusion to SQLite from journaled steps. Restate holds workflow position and, where a run kind needs one-at-a-time execution, the in-flight marker of a Virtual Object gate (amendment 2026-09-14, on trial in the first case; the fallback is a conditional insert of the dispatch row). Restate never holds run history. Admin surfaces and the KG ingest are unchanged.
6. Each migration lands as three slices on its feature branch: **add** (the workflow module and its scenarios, no production wiring), **switch** (every production path onto the workflow, with the legacy code kept inert so the slice is revertible alone), **delete** (the legacy glue, its tests, and the docs). The add slice shares no file with the deploy work, so it runs beside it.
7. After the second migration, a written evaluation gate decides: the main pipeline migrates the same way and AII-611 is cancelled or narrowed, or AII-611 proceeds first. The decision lands on AII-611, and ADRs 017, 018, and 023 move to Accepted or Rejected.

## Alternatives considered

- **Green-field first (integration testing before kg-refresh)** — the order this ADR first recorded. Rejected by the operator on 2026-09-14: it defers value on the buggiest live glue, and the deployment risk exists in the first case either way, because the SDK dependency enters the image with the harness.
- **Ledger first (the original sequence)** — rejected for now: it changes every live report path before any migration exists to justify it.
- **Big-bang pipeline migration** — rejected: it replaces roughly twelve live modules at once; a failure is neither cheap nor local.
- **One PR per migration** — rejected on 2026-09-14: the first case's single issue changed nine files and adapted five test files; one review cannot hold the cutover and the deletion at once.
- **No Restate at all** — remains the recorded fallback: if a case fails its criteria, the pre-Restate bodies are the fallback design and ADR 017 is Rejected.

## Consequences

- Easier: evidence precedes program. Each step deletes hand-rolled lifecycle glue instead of adding a parallel system. A failure at any step is local and reversible: the switch slice reverts alone.
- Harder: token handling is heterogeneous during the transition — unmigrated paths consume single-use tokens while migrated paths verify only. The evaluation gate must resolve the end state so the split does not become permanent.
- The run-ledger ADRs stay Proposed longer, and draft PR #495 stays a draft until the gate.
