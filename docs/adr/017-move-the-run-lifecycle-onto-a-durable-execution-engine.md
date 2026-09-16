# 017. Move the run lifecycle onto a durable-execution engine, Restate first

**Status:** Proposed
**Date:** 2026-09-08. Amended 2026-09-14: the order of adoption moved to ADR 018; the deployment shape moved to ADR 023.
**References:** AII-567 incident report (sections 5 and 6), the plan documents "Plan, Part 1" and "Plan, Part 2" of 2026-09-08, AII-521 and AII-555 (the cost of adding a run kind), ADR 012, ADR 013, ADR 014, ADR 018, ADR 023, AII-614, AII-682

## Context

One run's state lives in six loops that each infer it from a different signal. Adding the kg-refresh run kind touched about seven lifecycle modules (AII-555 retrospective). Two incidents in one week, the child-PR merge race (AII-560) and the run-token burn (AII-567), were failures of that glue, not of the pipeline. The lifecycle can only be tested by a live run of about thirty minutes.

A durable-execution engine models exactly this lifecycle: a workflow keyed by identity for dedup, journaled steps with retries and deadlines for dispatch and gates, a durable promise for the report, timers for loss detection, child workflows for the cascade, and a journal as history. The candidates sized for one Node process with SQLite on one Fly machine are Temporal Cloud (managed, per-action billing, deterministic workflow code), Temporal self-hosted (a cluster with its own database, larger than the orchestrator), DBOS (a library, needs Postgres), Restate (one binary with an embedded store, TypeScript SDK, Business Source License 1.1 with a grant that covers our use), and the same shape hand-built inside the orchestrator.

No decision on this question existed in the knowledge graph before this record.

## Decision

We move the run lifecycle onto Restate, one run kind at a time, and we decide each step against written criteria.

1. The order of adoption and the per-migration rules are ADR 018. The engine-independent changes of the run-ledger program (idempotent signed report, credential scoping) are contingent on the evaluation gate ADR 018 defines; they are not prerequisites.
2. Restate runs beside the orchestrator as a sidecar child process on the same machine, with its embedded store on the same volume (ADR 023). SQLite stays the system of record for everything that is not workflow position. Postgres is not required by this decision.
3. Each migration is judged against these criteria at ADR 018's gate:

| Criterion | Pass condition |
|---|---|
| Tests | The run kind's lifecycle scenarios pass in CI in under 60 seconds per file with Docker on the runner |
| Live run | One trigger of the migrated kind produces exactly one run whose report resolves the promise |
| Restart | A restart during a live run produces no second dispatch, and the run completes after the restart |
| Footprint | The Restate sidecar runs one week within the machine's memory allocation |
| Code removed | The migration deletes the run kind's sweep, its state machine, and its reaper branch, and adds no new sweep |
| Operations | Upgrades, restarts, and restore are documented in `docs/deployment.md` and `docs/restate.md`; one week unattended |

If a criterion fails, this ADR moves to Rejected with the reason and the run kind ships as its pre-Restate design.

## Alternatives considered

- **Temporal Cloud.** The most complete model and the most mature. Rejected for now: a vendor and a per-action bill, a determinism discipline across about twelve modules, and a footprint larger than a one-operator system needs. Revisit if a second tenant or cross-service durability appears.
- **Temporal self-hosted.** Rejected: a server cluster with Postgres or Cassandra, larger than the orchestrator.
- **DBOS.** Rejected: needs Postgres, which we do not run, for a benefit Restate gives without it.
- **The same shape inside the orchestrator only** (a ledger with explicit transitions, timers instead of sweeps). Rejected as the end state: we would keep maintaining loss detection, retries, and history ourselves, with no test environment.
- **Do nothing.** Rejected. The lifecycle seams grow a sibling per run kind, the pattern ADR 013 exists to stop.

## Consequences

Easier: one predicate per lifecycle question; exactly-once per key without a dedup table; a report that cannot be burned; lifecycle tests in seconds; a journal instead of six inferring loops.

Harder: one more child process to run, upgrade, and back up; a determinism rule for lifecycle code; the Restate server calls the SDK endpoint, so the orchestrator hosts a listener that must stay on localhost; token handling is heterogeneous while unmigrated paths still consume single-use tokens.

Verified since 2026-09-08 from the Restate documentation: the durable timer API and the testing options. Settled in code by AII-612 and AII-627: the endpoint API and port, the registration call, the memory footprint.
