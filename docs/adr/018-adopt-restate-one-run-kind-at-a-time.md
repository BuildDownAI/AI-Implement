# 018. Adopt Restate one run kind at a time; the run-ledger program is contingent

**Status:** Accepted
**Date:** 2026-09-10. Amended 2026-09-14: case order swapped; the three-slice rule added. Amended 2026-09-23: the review-fix pilot becomes the first run lifecycle. Amended 2026-10-01: the rule 7 gate is closed.

## Context

ADR 017 records the direction: move the run lifecycle onto a durable-execution engine (Restate). The original sequence ("Plan, Part 1" §8 and "Plan, Part 2" §8) put the run-ledger program first — the idempotent signed report, credential scoping, and the run-kind contract, tracked as AII-611 — and only then migrated run kinds. AII-611 is large, touches every live report path at once, and would bring instability before any evidence that the engine direction pays.

Two facts moved since that sequence was written. The integration-testing tree (AII-441) stands alone — its callback branch is verify-only by construction and depends on nothing in AII-611. And kg-refresh became a nearly standard run kind: AII-583 deleted its special push-credential path, and the AII-555 lane moved its dispatch onto the standard workflow.

## Decision

We adopt Restate one run kind at a time and make the run-ledger program contingent on evidence:

1. Review-fix first (operator decision, 2026-09-23): Restate controls GitHub Actions review-fix attempts that start after the previous runner stops. The runner keeps its existing internal review/fix cycles. Local Docker review-fix and other run lifecycles remain outside this migration. The harness and sidecar already exist. The pilot follows the [review-fix research](../research/2026-09-23-restate-review-fix-explained.md); the pilot design was approved at the mega-build-up design gate on 2026-09-24.
2. Keep the kg-refresh migration (AII-682) queued after the review-fix pilot. Keep the feedback-loop test surface (AII-629) as later work; it supplies the injected-executor seam for AII-440. This amendment changes their order, not their implementation scope.
3. Keep integration testing (the AII-441 tree) as later work, building on the proven harness and server and judged against its written criteria.
4. Each migration flips **its own** callback branch to verify-only: the token is validated, never consumed, and a duplicate report is absorbed by a Restate idempotency key. This is a per-path slice of the AII-611 idea, carried inside each migration.
5. SQLite stays the system of record (amended 2026-10-08: it is the read model, a projection of the journal; see the amendment below). Every migrated run kind writes its dispatch row, run record, and conclusion to SQLite from journaled steps. Restate holds workflow position and, where a run kind needs one-at-a-time execution, the in-flight marker of a Virtual Object gate. The review-fix pilot also requires shared atomic admission across competing legacy and Restate dispatch paths. SQLite remains authoritative for business run history; the Restate journal provides execution diagnostics. Existing admin history remains readable; the pilot extends the job view with correlated lifecycle and activity evidence. KG ingest is outside the pilot.
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

## Amendment (2026-09-28): kg-refresh starts on the pilot's integrated evidence

Rule 8 required the review-fix pilot's live restart recovery and one week of operating evidence before kg-refresh starts. The operator (John, with Cameron) decided on 2026-09-28 to start kg-refresh on the pilot's integrated evidence: PR #722 merged into `testing` as `6f79b09`, the AII-813 fault matrix, and 131 pinned Restate tests green. The SAN live evaluation (AII-815) continues in parallel and no longer gates AII-682. The matching bullet in ADR 031 is amended the same way. Rule 7's evaluation gate after two migrations is unchanged.

## Amendment (2026-10-01): the rule 7 gate is closed; the main pipeline migrates the same way

**Decision.** The operator (John) closes the evaluation gate of rule 7. The main pipeline migrates to Restate the same way: one run kind, or one bounded slice of a run kind, at a time, under rules 4, 5, and 6. ADR 017, ADR 018, and ADR 023 move to Accepted.

**The two migrations.**

- Review-fix pilot: PR #722 merged into `testing` as `6f79b09`, with the AII-813 fault matrix and 131 pinned Restate tests.
- kg-refresh (AII-682): top-of-tree PR #820 merged into `testing` as `aad256d`. The legacy state machine, the reaper rules, and the kg-refresh GHA monitor are deleted (AII-685).

**Basis.** The gate closes on integrated test evidence, not on live operating evidence. The SAN live evaluation (AII-815) and the live kg-refresh proof on the testing orchestrator continue. If either fails its criteria, this amendment is reopened.

**The run-ledger program (AII-611) is narrowed.** Verify-only token handling is no longer part of AII-611: each migration flips its own callback branch (rule 4). The signed report payload and credential scoping at the process boundary stay as the scope of AII-611 and get their own decision. Their two design records are in draft PR #495 and are not merged.

**End state for tokens.** The split in "Consequences" is temporary. Each report path becomes verify-only when its run kind migrates. No path stays on single-use tokens after the last migration.

**What this removes.** Later migrations need no amendment to pass rule 7. The GitHub Actions planning run (AII-1018) is the first slice under this decision.

## Amendment (2026-10-08): the journal is the record of the run; SQLite is a projection of it

**Rule, for every migrated run kind.** The journal is the record of the run. Each value a SQLite row carries is a journaled step result, and each SQLite write is a projection of journaled values: a `resolve` step journals the row's values from config and the environment, and a `record-*` step writes them to the store and reads nothing else. A row written from values computed inside the write cannot be rebuilt from the journal, cannot move to another store without a workflow change, and cannot gain a column by adding a field to a journaled result; a projection can.

**The credential rule.** A run token or a machine nonce is minted or derived inside a step, written inside that step, and never returned, because a step result is journaled. A nonce is derived (HMAC-SHA256 of the dispatch id and the attempt, under the runner token secret) and not stored as a random value: the journal holds the dispatch id and the attempt, and the secret and the nonce never enter it. A new attempt derives a new nonce.

**What does not change.** SQLite stays the read model that the admin pages, `/api/token`, the runner callbacks, and the reaper use. Decision 5's "SQLite remains authoritative for business run history; the Restate journal provides execution diagnostics" is amended: the journal is the record and SQLite is the read model built from it. ADR 017 point 2 is narrowed the same way.

**First applied to** kg-refresh (AII-1150): steps `resolve`, `reserve`, `nonce-N`, `dispatch-N`, `record-dispatch-N`, `record-reconcile-N`, `close-row`, `persist`. `PlanningRun` and `ReviewFixAttempt` are re-checked against this rule when they are next touched (`docs/standing-rules.md` rule 3); this amendment does not change them. The recipe is [restate.md](../restate.md) § "Journal projections", and the tests are [restate-testing.md](../restate-testing.md) § "Testing a journal projection (two tiers)".
