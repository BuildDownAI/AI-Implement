# 018. Adopt Restate one run kind at a time; the run-ledger program is contingent

**Status:** Proposed
**Date:** 2026-09-10

## Context

ADR 017 (Proposed, draft PR #495) records the direction: move the run lifecycle onto a
durable-execution engine (Restate). The original sequence ("Plan, Part 1" §8 and "Plan,
Part 2" §8) put the run-ledger program first — the idempotent signed report (ADR 015),
credential scoping (ADR 016), and the run-kind contract, tracked as AII-611 — and only then
migrated run kinds. AII-611 is large, touches every live report path at once, and would
bring instability before any evidence that the engine direction pays.

Two facts moved since that sequence was written. The integration-testing tree (AII-441:
AII-612, AII-474, AII-476, AII-477) already stands alone — its callback branch is
verify-only by construction and depends on nothing in AII-611. And kg-refresh became a
nearly standard run kind: AII-583 deleted its special push-credential path, and the
AII-555 lane moved its dispatch onto the standard workflow.

## Decision

We adopt Restate one run kind at a time and make the run-ledger program contingent on
evidence:

1. kg-refresh first (operator decision, 2026-09-14): its lifecycle glue is the buggiest
   of its kind — the reaper rules alone needed two fix rounds — and the run kind is
   nearly standard since AII-583 and AII-555. The Restate harness and the deployed
   server land inside this case; the consequence, accepted, is that the first case is
   not deployment-free.
2. The feedback-loop test surface second (CI only, no deployment): the implement/review
   loop extracted behind an injected executor and tested as a workflow with
   testcontainers. This case is the seam the multi-agent work (AII-440, Codex and
   OpenCode) builds on.
3. Integration testing after that (the AII-441 tree), building on the proven harness
   and server, judged against its written criteria ("Plan, Part 2" §5).
4. Each migration flips **its own** callback branch to verify-only: the token is validated,
   never consumed, and a duplicate report is a no-op by the workflow handler rule. This is
   a per-path slice of the AII-611 idea, carried inside each migration.
5. SQLite stays the system of record. Every migrated run kind writes its dispatch row, run
   record, and conclusion to SQLite from journaled steps. Restate holds workflow position
   only. Admin surfaces and the KG ingest are unchanged.
6. After the second migration, a written evaluation gate decides: the main pipeline
   migrates the same way and AII-611 is cancelled or narrowed, or AII-611 proceeds first.
   The decision lands on AII-611, and ADRs 015, 016, 017, and this one move to Accepted or
   Rejected.

## Alternatives considered

- **Green-field first (integration testing before kg-refresh)** — the order this ADR
  first recorded. Rejected by the operator on 2026-09-14: it defers value on the
  buggiest live glue, and the deployment risk exists in the first case either way,
  because the SDK dependency enters the image with the harness.
- **Ledger first (the original sequence)** — rejected for now: it changes every live
  report path before any migration exists to justify it, and its blast radius is the
  instability the operator flagged.
- **Big-bang pipeline migration** — rejected: it replaces roughly twelve live modules at
  once; a failure is neither cheap nor local.
- **No Restate at all** — remains the recorded fallback: if the integration-testing spike
  fails its criteria, the 2026-09-02 child bodies are the fallback design and ADR 017 is
  Rejected.

## Consequences

- Easier: evidence precedes program. Each step deletes hand-rolled lifecycle glue (the
  kg-refresh reaper special cases needed two fix rounds) instead of adding a parallel
  system. A failure at any step is local and reversible.
- Harder: token handling is heterogeneous during the transition — unmigrated paths consume
  single-use tokens while migrated paths verify only. The evaluation gate must resolve the
  end state so the split does not become permanent.
- ADRs 015 and 016 stay Proposed longer, and draft PR #495 stays a draft until the gate.
