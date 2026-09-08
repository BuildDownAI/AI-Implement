# 017. Move the run lifecycle onto a durable-execution engine, Restate first

**Status:** Proposed
**Date:** 2026-09-08
**References:** AII-567 incident report (sections 5 and 6), the plan documents "Plan, Part 1" and "Plan, Part 2" of 2026-09-08, AII-441 and children AII-472 to AII-477, AII-521 and AII-555 (the cost of adding a run kind), ADR 012, ADR 013, ADR 014, ADR 015, ADR 016, `docs/run-lifecycle.md`, `docs/run-kind-contract.md`

## Context

One run's state lives in six loops that each infer it from a different signal (`docs/run-lifecycle.md`). Adding the kg-refresh run kind touched about seven lifecycle modules (AII-555 retrospective). Two incidents in one week, the child-PR merge race (AII-560) and the run-token burn (AII-567), were failures of that glue, not of the pipeline. The lifecycle can only be tested by a live run of about thirty minutes.

A durable-execution engine models exactly this lifecycle: a workflow keyed by identity for dedup, journaled steps with retries and deadlines for dispatch and gates, a durable promise for the report, timers for loss detection, child workflows for the cascade, and a journal as history. The candidates sized for one Node process with SQLite on one Fly machine are Temporal Cloud (managed, per-action billing, deterministic workflow code), Temporal self-hosted (a cluster with its own database, larger than the orchestrator), DBOS (a library, needs Postgres), Restate (one binary with an embedded store, TypeScript SDK, Business Source License 1.1 with a grant that covers our use), and the same shape hand-built inside the orchestrator.

No decision on this question existed in the knowledge graph before this record.

## Decision

We move the run lifecycle onto Restate, in this order, and we decide each step against written criteria.

1. **First, the engine-independent changes**: ADR 015 (idempotent signed report) and ADR 016 (credentials stop at the process boundary). They fix the incident's causes and are what any engine will call.
2. **First Restate implementation: the integration-testing lifecycle (AII-441).** AII-474 as a Workflow keyed by the deployed commit; AII-476 as a Virtual Object keyed by the PR number; AII-477 as a Workflow keyed by PR and head SHA. This lifecycle is green field, isolated behind its own flags, and has the same shape as the run lifecycle. Its tests run in seconds against a Restate container with fake Fly, GitHub, and tracker.
3. **Then the run kinds, by the contract in `docs/run-kind-contract.md`**: kg-refresh first, then the implementation run kind, the cascade last.
4. **Restate runs as one more process in the Fly app**, with its embedded store on a volume. SQLite stays for everything that is not the run lifecycle. Postgres is not required by this decision.

The migration of the run kinds proceeds only when the AII-441 spike passes all of these:

| Criterion | Pass condition |
|---|---|
| Tests | The lifecycle scenarios pass in CI in under 60 seconds per file with Docker on the runner |
| Live run | One merge to `testing` produces exactly one integration-test run whose report resolves the promise |
| Restart | A deploy during a live run produces no second dispatch, and the run completes after the restart |
| Footprint | The Restate machine runs one week within its memory allocation |
| Code removed | AII-474 and AII-476 ship with no new sweep, no new settings state machine, and no new code in `src/reaper.ts` |
| Operations | Upgrades and restarts documented in `docs/deployment.md`; one week unattended |

If any criterion fails, this ADR moves to Rejected with the reason, AII-474 and AII-476 ship as their pre-Restate bodies say, and steps 1 and 3 still stand on their own.

## Alternatives considered

- **Temporal Cloud.** The most complete model and the most mature. Rejected for now: a vendor and a per-action bill, a determinism discipline across about twelve modules, and a footprint larger than a one-operator system needs. Revisit if a second tenant or cross-service durability appears.
- **Temporal self-hosted.** Rejected: a server cluster with Postgres or Cassandra, larger than the orchestrator.
- **DBOS.** Rejected: needs Postgres, which we do not run, for a benefit Restate gives without it.
- **The same shape inside the orchestrator only** (a ledger with explicit transitions, timers instead of sweeps). Partly adopted: ADR 015 and ADR 016 are that shape. Rejected as the end state, because we would keep maintaining loss detection, retries, and history ourselves, with no test environment.
- **Do nothing.** Rejected. The seams in `docs/run-lifecycle.md` grow a sibling per run kind, the pattern ADR 013 exists to stop.

## Consequences

Easier: one predicate per lifecycle question; exactly-once per key without a dedup table; a report that cannot be burned; lifecycle tests in seconds; a journal instead of six inferring loops.

Harder: one more process to run, upgrade, and back up, with its own volume; a determinism rule for lifecycle code; the Restate server calls the SDK endpoint, so the orchestrator opens an internal listener that must never be public; a restore must restore SQLite and the Restate store to the same point.

Not verified at the time of writing, to be settled in the spike: the SDK endpoint registration and port, the durable timer API, Restate's memory footprint on Fly, and the `fly.toml` process-group shape.
