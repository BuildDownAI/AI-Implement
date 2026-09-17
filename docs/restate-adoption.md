# How Restate simplifies the code and improves AI-Implement

An assessment, not a decision. The decisions are ADR 017 (move the run lifecycle onto a durable-execution engine), ADR 018 (adopt one run kind at a time, gated on evidence), ADR 023 (run the server as a sidecar), ADR 025 (MCP tools are Restate handlers, the Operator object is the refresh authority), and ADR 015 (reads open, writes declared). This page synthesises what those decisions buy, what they cost, and where each cost has a path to becoming an advantage. It is written after the AII-687 tree landed the foundation — the harness, the sidecar, the tools service, and the `Operator` object — and before any run kind has migrated.

## The gains

**It deletes hand-rolled lifecycle glue.** Before Restate, one run's state lived in six loops that each inferred it from a different signal, and adding the kg-refresh run kind touched about seven lifecycle modules (ADR 017 § Context). Two incidents in one week — the child-PR merge race and the run-token burn — were failures of that glue, not of the pipeline. A durable-execution engine models the lifecycle directly: a workflow keyed by identity for deduplication, journaled steps with retries and deadlines, a durable promise for the report, and timers for loss detection. Every migration is required to delete the run kind's sweep, its state machine, and its reaper branch, and to add no new sweep (ADR 017 criteria table, "Code removed"; ADR 018 § Decision 6).

**Concurrency correctness comes as a side effect, not a second mechanism.** The `Operator` object is the first proof. The old SQLite refresh path had a read-then-write race and revoked a whole token family on any re-presentation, so two Claude Code sessions sharing one credential store killed each other's session. A Virtual Object's `exclusive` handler serialises callers for free, as a consequence of adopting the grace-window fix rather than as a lock to maintain (ADR 025 § Alternatives considered; `docs/restate.md` § "The Operator object").

**One door replaces many.** Every orchestrator tool is one Restate handler; `/mcp` is a pure adapter. The role check lives in one wrapper (`tool()`, `src/restate/tools.ts`), the hand-maintained write list retired into handler metadata, and the same handler answers `/mcp`, the `POST /api/tools/<name>` route, and in-process callers (`docs/mcp-server.md` § "Entry points"). Discovery from the admin API means a new read tool is usable the day it ships.

**Retries and idempotency become primitives.** A duplicate report is absorbed by a Restate idempotency key rather than a bespoke single-use-token dance, and each migration flips its callback to verify-only (ADR 018 § Decision 4).

**The lifecycle becomes testable in seconds.** It used to be exercised only by a live run of about thirty minutes. Testcontainer scenarios now run in under sixty seconds per file, with forced replay and disabled retries surfacing the paths a live run reaches only by luck (`docs/restate.md` § "Testing").

SQLite stays the system of record throughout. Restate holds only workflow position, so the change is additive rather than a data-store swap (ADR 017 § Decision 2; ADR 018 § Decision 5).

## The costs, and the path forward for each

Each row below names the cost, whether it can become an advantage, and where the mechanism that turns it lives.

### State is heterogeneous during the transition — becomes a positive at the gate

Unmigrated run kinds consume single-use tokens; migrated kinds verify only and let a Restate idempotency key absorb a duplicate. Token handling is split while the migration runs (`docs/runner-callbacks.md` for the token flow).

The split is temporary by construction. ADR 018 § Decision 7 defines an evaluation gate after the second migration: the main pipeline either migrates the same way and the run-ledger program (AII-611) is cancelled or narrowed, or AII-611 proceeds first. When the gate resolves, token handling converges to one model everywhere. The interim is not drift; it is a bounded state that a written decision closes. **Net: a positive, once the gate is reached** — the split forces the end-state decision to be made on evidence instead of assumed up front.

### The journal is durable, readable storage — becomes a positive as enforced guardrails

`restate-server` records the bytes of every ingress request and response, and a journaled value outlives the call. That creates real new rules: no secret in a request body, encode every dynamic URL segment, treat an empty success body as success not a parse error.

These are written down and, more importantly, enforced in code rather than left as tribal knowledge. The ten rules are collected in `docs/restate.md` § "Working with Restate: patterns and pitfalls". Several of them are guardrails a future migration inherits for free: the response-reading helpers in the test harness (`src/__tests__/restate/harness.ts`) and `RestateRefreshAuthority.invoke` (`src/restate/operator-object.ts`) treat an empty 2xx body as success, the `tool()` wrapper handles the retried-error and the suspension-signal distinction (`src/restate/tools.ts`), `POST /api/tools/<name>`'s name regex plus `encodeURIComponent` closes the path-traversal class (`src/admin.ts`, `src/restate/tools-client.ts`), and a write only carries an idempotency key when the caller states one explicitly via `params._meta.idempotencyKey` (`/mcp`) or the `Idempotency-Key` header (`POST /api/tools/<name>`), never derived from per-connection counters (`src/mcp.ts`, `src/admin.ts`). **Net: a positive** — a rule enforced by a wrapper is a rule the next author cannot forget.

### Determinism discipline in workflow code — a real constraint, partly mitigated

A durable-execution workflow must be deterministic on replay: no wall clock, no ambient randomness, no nondeterministic branching. Restate replaces these with journaled equivalents — `ctx.date.now()`, `ctx.rand.uuidv4()` — as the `Operator` object already shows (`src/restate/operator-object.ts`). ADR 017 named this discipline as a cost when it weighed Temporal; it applies to any engine in the class.

The mitigation is that the constraint is localised and caught early. It applies only to code inside a handler, not to the orchestrator at large, and the test harness runs every scenario with `alwaysReplay: true`, so a nondeterministic handler fails its own test rather than a production run (`docs/restate.md` § "Testing"). **Net: stays a cost, but a bounded and test-visible one** — it is a new way to write one class of module, not a tax on the whole codebase.

### Registration couples a deploy to draining in-flight work — becomes a safety property

The SDK endpoint registers with the admin API without `force` at boot; a changed service set at the same URI answers a `META0004` conflict, and `force: true` can drive in-flight invocations into an unrecoverable state, so it is used only after in-flight work has drained (`src/restate/endpoint.ts`; `docs/restate.md` § "Working with Restate", the no-force rule). That couples a deploy to a drain.

That coupling is the same interlock the self-deploy path already runs, and it is a guarantee rather than a hazard: a replacement process cannot silently reland on top of running invocations. **Net: a positive** — the constraint encodes "never replace a process mid-run," which is behaviour the pipeline wanted anyway.

### One machine, one embedded store — a scaling ceiling, deferred by design

Restate runs as a sidecar on one Fly machine with its embedded store on the same volume (ADR 023). That is a single point of failure and a scaling ceiling: the partition count is fixed at first provision, and the design is one node.

For a one-operator system this is the right size, and the ceiling is explicit rather than discovered. ADR 017 § Alternatives records the trigger to revisit — a second tenant or cross-service durability — at which point Restate's own clustering and remote-storage options, or a move to Temporal, come back onto the table. **Net: stays a bounded limitation** — acceptable now, with a named condition for reopening it, not a surprise later.

### A new hard dependency and failure mode — and the path to fewer datastores

The refresh grant now needs the sidecar up, a dependency `verifyMcpToken` and every other SQLite-backed path do not share. An outage narrows to "nobody can refresh," answers `503` (retry) rather than `401` (re-authenticate), and access tokens keep working for their remaining hour (ADR 025 § Consequences; `docs/mcp-server.md` § "Failure behaviour"). The failure is now explicit and tested, where the old implicit coupling was neither — that alone is an improvement.

**The path to "one core datastore" after everything migrates.** Today there are two stores: SQLite is the system of record, Restate holds workflow position on the same volume. The question is whether that duality can collapse once every run kind has moved. Two honest answers:

* **Restate at the core, replacing SQLite: no.** Restate is a durable-execution engine, not a general database, and ADR 017 § Decision 2 and ADR 018 § Decision 5 deliberately keep run history and every non-position fact in SQLite. Restate never holds run history by design. "Restate as the datastore" is not a direction the architecture points at.
* **Postgres at the core, unifying both: possible, and a separate program.** The real convergence path is to move the orchestrator's own state from SQLite to Postgres and point Restate's backend at the same Postgres, turning two operational stores into one. That would fold the sidecar's durability into the same database the app already runs, so "a new dependency" becomes "one datastore instead of two." It is large, it changes the system of record, and it is gated well after the run-lifecycle migrations and their evaluation gate — a candidate for the post-gate roadmap, not a plan today. **Net: the dependency is bounded and degrades gracefully now; the long-run positive (one store) is reachable through Postgres, not through Restate.**

### The payoff is gated on evidence — this is the safety, not the weakness

ADRs 017, 018, 023, and 025 are all still Proposed. The AII-687 tree built the foundation but no run kind has migrated: the run-kind service set is empty and kg-refresh (AII-683) has not landed. Each migration lands as three slices — add, switch, delete — and the switch slice reverts alone, so a failure is local and reversible (ADR 018 § Decision 6). Each is judged against the six-criterion table in ADR 017 § Decision, and a failure moves the ADR to Rejected with the run kind shipping its pre-Restate design. **Net: contingent adoption is the disciplined way to take on an engine** — the project never bets the pipeline on an unproven dependency, and "not yet proven" is a statement about sequencing, not about risk taken.

### Licensing: no, do not relicense our own code

The concern is that depending on a Business Source License 1.1 component pressures AI-Implement toward BSL. It does not, and the split matters:

| Component | Licence | How we use it |
|---|---|---|
| AI-Implement, BuildDownAI/skills | Apache-2.0 | our own source |
| `@restatedev/restate-sdk` | MIT | imported into our code, shipped in our image |
| `@restatedev/restate-sdk-testcontainers` | MIT | test-only dependency |
| `@restatedev/restate-server` (v1.7.10) | BSL 1.1 | run unmodified as a sidecar binary |

The code we compile and distribute — the SDK — is MIT and imposes nothing. Only the server binary is BSL, and we run it unmodified as a separate process; we do not distribute a modified Restate server, which is what BSL's terms govern. A dependency's licence does not propagate to a project that merely runs it, and BSL 1.1 additionally converts to an open licence at its change date (Apache-2.0 for Restate; read the server's own `LICENSE` for the exact date and the additional-use grant). **Keep AI-Implement and the skills repo Apache-2.0.** There is no legal or practical reason to move our code to BSL, and doing so would give away the permissive terms our own users rely on for no benefit. The one thing worth doing is recording, in a dependency note, that the server binary is BSL and why that is acceptable — which is what ADR 017 already states.

## Where to read more

| Topic | Source |
|---|---|
| Why a durable-execution engine, and the six pass/fail criteria | `docs/adr/017-move-the-run-lifecycle-onto-a-durable-execution-engine.md` |
| Order of adoption, the three-slice rule, the evaluation gate | `docs/adr/018-adopt-restate-one-run-kind-at-a-time.md` |
| The sidecar deployment shape and its footprint | `docs/adr/023-run-the-restate-server-as-an-orchestrator-sidecar.md` |
| Tools as handlers, the Operator refresh object | `docs/adr/025-mcp-tools-are-restate-handlers-and-the-operator-object-is-the-refresh-authority.md` |
| Reads open, writes declared | `docs/adr/015-mcp-reads-open-writes-declared.md` |
| The engine reference: ports, testing, the Operator object, the tools service | `docs/restate.md` |
| The ten reusable rules for building on Restate | `docs/restate.md` § "Working with Restate: patterns and pitfalls" |
| The `/mcp` door, identity, entry points, failure behaviour | `docs/mcp-server.md` |
| The run tokens and callback verification | `docs/runner-callbacks.md` |
