# Restate tests: the components, the fakes, and when to write one

A reference for the two test tiers that cover the Restate code under `src/restate/`. It walks one file, `src/__tests__/restate/tools.restate.test.ts`, component by component, explains what stands in for what in each tier, and gives the rule for choosing a Restate test over a unit test. `docs/restate.md` § Testing holds the operator rule and the CI wiring; this page is the reader's guide to the files themselves.

## The two tiers in one table

| | Unit tier | Restate tier |
|---|---|---|
| Where | `src/__tests__/<module>.test.ts` | `src/__tests__/restate/<module>.restate.test.ts` |
| Runs with | `npm test` (vitest, default config) | `npm run test:restate` (`vitest.restate.config.ts`) |
| Needs Docker | No | Yes (`@restatedev/restate-sdk-testcontainers` boots `restatedev/restate:1.7.10`) |
| Engine present | No. The handler is called as a plain function | Yes. A real `restate-server` journals the call and delivers it over HTTP/2 to the in-process SDK endpoint |
| What it proves | The branch logic, the error mapping, the wire shapes, the time boundaries | What the engine does with the handler: serialisation, retry, idempotency, suspension, discovery metadata, ingress serde |
| Cost | Milliseconds per test | About a second per scenario, plus one container boot per variant per file (seconds) |
| Type-check | `npm run typecheck` excludes `src/__tests__` | `npx tsc --noEmit --project tsconfig.restate-tests.json` (the `restate-tests` CI job runs it) |
| CI job | `unit-tests` in `.github/workflows/unit-tests.yml` | `restate-tests` in the same workflow, in parallel with `unit-tests`, on every PR to `testing`, `main`, and the grouping branches |

The default suite excludes `src/__tests__/restate/**` in `vitest.config.ts`, so a dispatched runner without Docker never sees these files.

## Walkthrough: `tools.restate.test.ts`

The file covers the `orchestratorTools` service (`src/restate/tools.ts`) and the `tool()` wrapper every handler is built with. Read it top to bottom as six components.

### 1. The harness import

```ts
import { VARIANTS, callService, startVariants, stopAll } from "./harness.js";
```

`src/__tests__/restate/harness.ts` is the only place a container, a variant, or a fetch helper is declared. A test file never declares its own. The harness exports:

| Export | What it is |
|---|---|
| `RESTATE_IMAGE_VERSION` | `"1.7.10"`, pinned to match `RESTATE_IMAGE_TAG` in the CI job, which keys its Docker image cache on the same value |
| `VARIANTS` | Two ways to configure the container: `alwaysReplay` and `disableRetries`. Each entry is a label plus a function that calls the matching `RestateContainer` method |
| `startVariants(services)` | Boots one container per variant with `RestateTestEnvironment.start`, registering exactly the services passed. Returns a `Map<label, environment>` |
| `stopAll(environments)` | Stops every container. Always called from `afterAll` |
| `callService`, `callObject`, `callWorkflow` | POST helpers that build the ingress URL the way `@restatedev/restate-sdk-clients` does (`/<service>/<handler>`, `/<object>/<key>/<handler>`) and read the response with the empty-body rule |

Why the variant functions exist: `RestateTestEnvironment.start` only translates `alwaysReplay` and `disableRetries` into container config in its own default container factory. Passing a custom `container` factory (needed to pin the image version) bypasses that wiring, so each variant's factory must call `container.alwaysReplay()` or `container.disableRetries()` itself.

**The empty-body rule.** A `void` handler answers a success with an empty 2xx body. The helper reads `response.text()` first and returns `undefined` for an empty string. A copy of this helper that called `response.json()` directly failed all thirteen `issue`/`revoke` scenarios once (AII-709). A non-2xx response throws with the status and body text in the message, which is how a scenario asserts an ingress-level 4xx.

### 2. The two variants, and why every scenario runs twice

`it.each(VARIANTS.map(([label]) => label))` runs each scenario once per variant:

- **`alwaysReplay`** makes the server suspend and replay the handler at every journal entry. A handler that reads the wall clock, calls `Math.random()`, or mutates outer state produces a different journal on replay and fails here. It is the determinism check.
- **`disableRetries`** makes a thrown handler error fail the invocation at once instead of retrying. It surfaces error paths without waiting out a backoff.

A scenario whose observable result must be the same under both is the normal case. A scenario that depends on retry (the raw-handler test in component 6) runs against `alwaysReplay` only, with a comment saying why.

### 3. The fixture services

Beside the real `orchestratorTools`, the file builds three tiny services inline. Each exists to prove one property of the `tool()` wrapper that the real handlers do not reach on their own:

| Service | Handler | Proves |
|---|---|---|
| `failingTools` | `always_throws`, built with `tool()`, throws `Error("boom")` | The wrapper's `try/catch` turns a thrown error into a completed `isError: true` result, so Restate does not retry a broken handler forever and `/mcp` is never held open |
| `suspendingTools` | `sleep_then_succeed`, built with `tool()`, awaits `ctx.sleep(50)` | The wrapper does not intercept Restate's own suspension signal. `ctx.sleep` is a durable timer that forces the attempt to suspend; the SDK throws internally to unwind, and the wrapper must rethrow that (`restate.internal.isSuspendedError`) instead of converting it to a false failure |
| `idempotentTools` | `throws_once_then_succeeds`, a raw handler with no `tool()` | Restate's retry plus idempotency-key primitive. `tool()` catches every throw, so no real write ever lets Restate retry; a raw handler is the only way to watch the engine retry once and then dedup a second keyed call |

This is the pattern for a fixture in the Restate tier: a service small enough that the assertion isolates one engine behaviour, registered next to the real service in the same container.

### 4. `beforeAll`: the process-side fakes

```ts
dedup.getDb();            // DEDUP_DB_PATH=":memory:" from vitest.restate.config.ts
initLogTable();           // dispatch_log, read by getInFlightJobs
initMappingsTable();      // mappings, read by list_projects / get_project_binding
initSettingsTable();      // settings, read by getRunnerMode
dedup.getDb().prepare("INSERT INTO mappings ...").run("BDS", "BuildDownAI", "skills", "claude.yml", "testing", '{"SUPER_SECRET":"leak-me"}');
setKgMemoryProvider(null);
environments = await startVariants([orchestratorTools, failingTools, suspendingTools, idempotentTools]);
```

Nothing here is a mock in the `vi.mock` sense. The handlers run their real code against real modules, and the environment around them is substituted:

- **The database** is an in-memory SQLite, created by the config's `env` block before any module imports. The `beforeAll` creates only the tables the handlers under test read.
- **One fixture row** carries a deliberately secret-looking `extra_env` value. Two scenarios assert the string never appears in a response, which is the leak check for `list_projects` and `get_project_binding`.
- **The memory provider** is set to `null`, so every `kg_*` handler takes its "no memory provider is configured" branch. A scenario asserts that exact text.
- **The container** starts last, after the tables exist, because the first scenario calls a handler that reads them. The hook has a 60 s cap.

`vitest.restate.config.ts` also loads `src/__tests__/setup/clear-runner-credentials.ts`, which deletes `RUN_TOKEN`, `RUNNER_CALLBACK_URL` and the other runner credentials before each test, so a suite running inside a dispatched runner can never reach a real callback endpoint.

### 5. The scenarios, by what only the engine can prove

| Scenario | Engine behaviour under test |
|---|---|
| Admin caller gets the health payload | The ingress deserialises `{ caller, args }` through the zod serde and the handler's JSON text result round-trips back |
| `caller.role: null` refused | The role assertion runs inside the wrapper on the real wire, not only in the unit tier's direct call |
| Admin API lists `mcp.type: tool`, `mcp.role: user` | The metadata `tool()` attaches reaches the deployment record `discoverTools()` reads. Note: the record appears only after the handler has been invoked once against that environment, so every discovery scenario calls the handler first |
| Throwing handler answers 200 `isError` | Restate saw a completed invocation, not a retryable failure |
| `ctx.sleep` handler completes | The suspension round-trip (suspend, timer fires, resume, complete) works through the wrapper |
| Read handlers (`get_runner_mode`, `list_projects`, `get_project_binding`, `get_issue_dispatch_status`) | Real handler bodies against the fixture tables, through the ingress. `get_project_binding` also reads a settings row written mid-test, proving the handler reads live state |
| `identifier: 5` is refused with 4xx | The zod serde rejects before the handler body runs; `callService` surfaces the status in the thrown error |
| Write metadata and discovered JSON schema | `trigger_kg_refresh` declares `dryRun`/`acceptNewBaseline` booleans and `add_project` declares the `reviewers` shape, as the admin API projects them. This is the schema an MCP client sees |
| User refused a write tool | The `admin` role gate holds over the real ingress and the action never runs |
| `pause_project` with one idempotency key, called twice with opposite `paused` | Restate attaches the second call to the first result; the handler never sees the second `args`. The assertion reads `getMappings()` from the fixture DB, an observable effect, not a journal internal |
| Raw handler throws once, then succeeds, then a keyed repeat does not run again | The engine's own retry (attempt count reaches 2) and the keyed dedup (count stays 2) |

The last two scenarios are the ones the issue AII-713 was about. They cannot exist in the unit tier because the unit tier has no engine to retry or to dedup.

### 6. What the companion file adds

`operator-object.restate.test.ts` follows the same shape against the `Operator` Virtual Object and adds the properties a Virtual Object is for:

- Two concurrent `refresh` calls presenting the same current hash both succeed with the identical new pair. Only an `exclusive` handler queue can prove this.
- A presentation of the previous hash inside the grace window returns the same pair the rotation produced.
- Unknown hash, expired family, `revoke`, sign-in after revoke, and `describe` each assert the state through a shared read, never a journal read.
- One scenario runs the same sequence against both variants and asserts the two results are equal, which is the replay-determinism check for handlers that use `ctx.rand.uuidv4()` and `ctx.date.now()`.

The exact grace-window boundary is not here. A real container can only reach it with a 30 s wait, so `decideRefresh` was factored out as a pure function of state and time and is unit-tested in `src/__tests__/operator-object.test.ts` on both sides of the boundary.

## How the fakes work in the unit tier

The unit tier for the same modules, `src/__tests__/tools.test.ts` and `src/__tests__/operator-object.test.ts`, substitutes the engine itself:

| Fake | What it replaces | How |
|---|---|---|
| `fakeContext(handlerName)` | `restate.Context` | An object with only `request()` returning `{ target: { handler } }`, because that is the one context call the `tool()` wrapper makes. `restate.handlers.handler` returns a plain callable, so the test calls `myTool(fakeContext("my_tool"), { caller, args })` directly |
| `vi.mock("../admin.js")` | The five admin action functions the write tools call | Mocked wholesale so a write scenario asserts the action was called with the right arguments and the handler mapped its return to the right result text |
| `vi.mock("../report-card.js")`, `vi.mock("../config.js")` (partial) | Report and mapping reads | Return values set per test |
| A faked `fetch` passed through `deps` | The Restate admin API and ingress | `discoverTools()` and `callTool()` take `fetchImpl` in their deps, so the test hands them canned responses: a metadata body, a 4xx, a 5xx, an empty body, a connection error |
| `UNROUTABLE_INGRESS` (`http://127.0.0.1:59999`) | A down sidecar | Nothing listens there, so `RestateRefreshAuthority` gets a fast `ECONNREFUSED` and the test asserts the `unavailable` mapping |
| `decideRefresh(family, presentedHash, now)` | The `refresh` handler's branch logic | A pure function called with a hand-built `FamilyState` and an explicit `now`, so the 30 s boundary costs nothing |
| A temp SQLite file per test | The orchestrator DB | `DEDUP_DB_PATH` pointed at a fresh file in `beforeEach`, tables created by `initMcpOAuthTables()` |
| `vi.mock("../access-entries.js")`, `vi.mock("../mcp-auth-events.js")` | Allowlist and audit sink | Default to "admit", overridden by the scenarios that test the re-check and the revoke |

The unit tier never proves that Restate would call the handler this way. It proves what the handler does once called. That split is deliberate: the Restate tier holds the engine facts, the unit tier holds the branches.

## When to write a Restate test, and when a unit test

Ask one question about the assertion: **if Restate were removed from the picture, would the assertion still mean something?**

- **Yes: unit test.** Parsing, formatting, a state-table branch, an error-to-status mapping, an exact time boundary, a wire shape the code builds, a fake-able I/O outcome. Every dispatched runner runs `npm test` with no Docker, so this tier is where the bulk of the assertions belong.
- **No: Restate test.** The assertion is about what the engine does with the handler.

The engine facts that need the Restate tier, with the scenario that shows each:

| Engine fact | Example scenario |
|---|---|
| `exclusive` handlers serialise callers on one key | Two concurrent `refresh` calls converge on one pair |
| The engine retries a thrown handler error | `throws_once_then_succeeds` reaches attempt 2 |
| An idempotency key attaches a repeat call to the first result | `pause_project` twice with one key |
| A suspension (`ctx.sleep`, `ctx.call`, awakeables) resumes and completes | `sleep_then_succeed` answers `done` |
| Replay is deterministic for this handler | The same sequence is equal under `alwaysReplay` and `disableRetries` |
| The ingress serde rejects bad input before the handler | `identifier: 5` answers 4xx |
| Handler metadata reaches the admin API's deployment record | `mcp.type` / `mcp.role` and the projected JSON schema |
| A wrapper property holds on the real wire, not only in a direct call | Role refusal and `isError` conversion through the ingress |

Three rules the files follow:

1. **Assert an observable effect, never a journal internal.** A returned value, a state read through a shared handler, a call count on a fixture, a row in the fixture DB.
2. **Register only the services the scenario needs**, and build a fixture service when a real handler cannot reach the property under test.
3. **Keep the slow boundary in the unit tier.** Anything that needs a real 30 s wait is factored into a pure function and tested there.

An issue that adds or changes Restate behaviour writes the unit tests first, then the Restate scenarios, and states the order in its acceptance criteria. An issue with no Restate surface says "unit tests only" so the absence is a decision (`docs/restate.md` § "How an issue adds Restate tests").

## Running and debugging

```bash
npm run test:restate
npx tsc --noEmit --project tsconfig.restate-tests.json
```

Docker must be running. The first run pulls `restatedev/restate:1.7.10`. Things that trip a first-time author:

- A deployment's handler metadata is empty until a handler has been invoked once in that environment. Call the handler, then read `GET <adminAPIBaseUrl>/services/<name>`.
- The `disableRetries` variant fails a throwing handler at once. A scenario that needs a retry to succeed runs against `alwaysReplay` only, with a comment.
- Module-level setters (`setKgMemoryProvider`, `setActiveKgRefresh`, `setProviderRegistry`, `setRefreshAuthority`) are process globals. Set them in `beforeAll` or the test, and reset them in `afterEach` where a test changes them.
- `RestateTestEnvironment.start` hosts the services on its own endpoint and is what every other file in this folder uses. `src/restate/endpoint.ts` (`startRestateEndpoint`, `register`, `RESTATE_SERVICES`) is the one exception: `endpoint.restate.test.ts` (AII-727, below) manages its own `RestateContainer` specifically so it can call those functions directly, rather than going through the harness's own internal registration.

## Container-to-host reachability for a real `startRestateEndpoint()` / `register()` test (AII-727)

`endpoint.restate.test.ts` is the one file in this folder that does not call `startVariants()` — it needs to invoke `startRestateEndpoint()` and `register()` itself, against a container it manages directly, and `RestateTestEnvironment.start()` offers no way to boot a container without also auto-registering its own internal endpoint. This surfaces a reachability problem none of the other files hit: `restate-server`, running inside the container, must open an HTTP/2 connection back out to this process's SDK endpoint to complete registration (the admin API's `POST /deployments` runs service discovery against the given URI synchronously), and a loopback bind on the host side is not reachable from inside a container's own network namespace.

The fix carries no change to `src/restate/endpoint.ts`: this process's SDK endpoint keeps the production bind, `127.0.0.1` (`restateBindAddress()`'s default — ADR 023's loopback-only rule is never relaxed for this test), and the test calls `TestContainers.exposeHostPorts(port)` before starting the container. That is the same `"testcontainers"` service-endpoint-access mode `@restatedev/restate-sdk-testcontainers`'s own `RestateTestEnvironment.start()` offers (its other mode, `"docker-host"`, is the default every other file in this folder uses indirectly, via the harness) — it starts a small proxy container and tunnels `host.testcontainers.internal:<port>`, as seen from any container in the test run, back to `127.0.0.1:<port>` on the host.

One wrinkle remains, specific to calling `register()` directly: `restateBindAddress()` supplies both this process's bind address and, inside `register()`, the registered `uri` — a single value serving two different purposes here (the interface this process listens on, and the address the container must be told to dial). The test's `tunnelingFetch` helper rewrites that one literal `host:port` substring in the outgoing request body, from the real bind address to the tunnel address, using the `fetchImpl` seam `register()` already exposes for testing — nothing in `src/restate/endpoint.ts` changes. The same rewrite also fixes up the internal `/query` call `queryNonCompletedInvocations()` makes on a conflict, since its SQL embeds the identical `uri` text in a `WHERE endpoint = '...'` clause that must match whatever `register()` actually sent to the admin API.

This mechanism runs in the `restate-tests` CI job like every other file in this folder (Docker required); it was not exercised against a live container in the session that wrote it, for lack of a local Docker daemon — see the file's own header comment for the full reasoning trail.

## Coverage as of the AII-727 tree (2026-09-25)

What the Restate tier proves today: exclusive-handler serialisation, the in-window grace path, unknown-hash and expired handling, `revoke`, `describe`, replay determinism across both variants, the `tool()` wrapper's role, error, and suspension behaviour over the real wire, the migrated read handlers through the ingress, the ingress serde 4xx, discovery metadata and projected schemas for reads and writes, a user refused a write over the wire, idempotency-key dedup on `pause_project`, and engine retry on a raw handler. The write tools' business logic has a full fake-backed unit tier.

AII-727 closes five of the gaps this section used to list:

- **The stale-hash `clearAll` branch** now runs against the real `refresh` handler (`operatorObject.object.refresh`, called through a fake `ObjectContext` — the SDK's own public `VirtualObjectDefinition` type only declares `name`; the registered handler functions live on a runtime-only `object` property) in `operator-object.test.ts`, one tick past `GRACE_MS` and again exactly at the boundary. Deleting `if (decision.clear) ctx.clearAll()` fails this suite.
- **`startRestateEndpoint()` and `RESTATE_SERVICES`** are exercised end to end against a real server 1.7.10 in `endpoint.restate.test.ts` (both bound services answer through the container ingress after a real registration), plus a static unit-tier pin in `restate-endpoint.test.ts` (`RESTATE_SERVICES.map(s => s.name)`).
- **`register()` itself has met a real admin API.** `endpoint-registration.restate.test.ts` (AII-721, already in the tree before this issue) proved the drain-check helper, `queryNonCompletedInvocations()`, against a real admin API in isolation — zero, a suspended-plus-queued pair, and persistent Virtual Object state not counting. `endpoint.restate.test.ts` (AII-727) is what proves `register()`'s own orchestration around that already-proven helper: an unchanged re-registration stays success, and a changed service set at the same URI is `declined-conflict` while a non-completed invocation is pinned to the old deployment and `registered-drained-force` once it drains — using a genuinely in-flight invocation (the `refresh` test seam below), not a fake invocation count.
- **`RestateRefreshAuthority` has met a real ingress**: `operator-object.restate.test.ts` runs `rotate()` with the allowlist mocked to deny, against the real container — `denied`, exactly one `POST .../revoke` (a spy wrapping the real `fetchImpl`), and a subsequent `describe` returning all-null.
- **`describe` during an in-flight exclusive `refresh`**: `operator-object.restate.test.ts` starts a `refresh` call carrying a new, test-only `sleepMs` field (`src/restate/operator-object.ts`) that makes the handler durably sleep — still holding the exclusive lock — before deciding; a concurrent `describe` on the same key answers well before the sleep's own deadline. `sleepMs` is inert whenever omitted, which is every production call path, so it never touches `decideRefresh`'s branch or the alwaysReplay-vs-disableRetries equivalence check in the same file.

Known gaps, for the next issue that touches the area:

| Gap | Why it matters |
|---|---|
| The real `restate-server` binary is never spawned in a test | The `RESTATE_*__*` env keys are verified by hand with `--dump-config`, not by a test. (`endpoint.restate.test.ts`'s container runs the Docker *image*, not the `@restatedev/restate-server` platform binary `RestateSidecar` spawns in production — a different artifact) |
| `restate-tests` is not a required check on `testing` | A red job does not block a merge until an operator marks the check required |

## `review-fix-pilot.restate.test.ts`: the production-composition fault matrix (AII-813)

`review-fix-attempt.restate.test.ts` (AII-796) and `review-fix-pr.restate.test.ts` (AII-800)
prove the durable workflow and PR coordinator against fully in-memory `store`/`worker`/
`finalizer` doubles — fast, but they never exercise `SqliteReviewFixAttemptStore`'s real
admission SQL, `review-fix-finalize.ts`'s real approval-effect idempotency, `review-fix-inbox.ts`'s
real delivery ledger, or `GithubReviewFixWorker`/`createReviewFixGithubAdapter`'s real
reconciliation logic. `review-fix-pilot.restate.test.ts` composes those production modules for
real — the same `createReviewFixPR` / `createReviewFixAttempt` / `SqliteReviewFixAttemptStore` /
`createReviewFixFinalizer` / `GithubReviewFixWorker` / `createReviewFixGithubAdapter` /
`ReviewFixDeliveryPump` a live pilot would run — and fakes only the external GitHub transport,
the GitHub REST fetch layer, and the PR coordinator's admission-eligibility/pending-feedback
reads (the same seams `review-fix-production.ts` itself calls out to GitHub for). Both files stay
in the tree; this one does not re-prove the fixed 5-second coalescing window's exact timing,
which AII-800's suite already covers precisely against a faster-to-assert fake.

**What this file's assertions are proof of, by claim type:**

| Claim | Kind | Where |
|---|---|---|
| Admission SQL (capacity, PR budget, pause, 30-finding cap, re-admission of a re-reported finding) is race-free and idempotent under real `dispatch_admissions`/`dispatch_budget_entries`/`review_fix_attempts` writes | Real engine + real SQLite | every "Admission:" scenario |
| A crashed `ctx.run` step (admission commit before journal, result commit before ACK) converges to exactly one durable effect on engine retry | Real engine + real SQLite | the two `alwaysReplay`-only "crash window" scenarios, `crashAfterFirstCall` |
| A crashed inbox delivery (HTTP ack lost after the real handler ran) redelivers to exactly one outcome | Real engine + real SQLite + real `ReviewFixDeliveryPump`/facade | "inbox commit before ACK" |
| Authenticated runner activity enforces the 16 KiB event and 10 MiB attempt caps, records sequence gaps/final markers, and still accepts cycle evidence after the stream limit | Real callback validator + real SQLite activity/evidence stores; admission uses the real engine, while runner payloads are simulated | "authenticated activity intake preserves gaps" |
| Authenticated runner result intake commits one durable inbox delivery, acknowledges identical retries, and records conflicting retries without approval | Real callback validator + real SQLite result/inbox stores + real delivery pump and engine; runner result payloads are simulated | "authenticated result ingress commits one inbox delivery" |
| A crashed approval-effect write reconciles via `retryApprovalEffect` without a second GitHub write | Real engine + real SQLite + real finalizer, simulated GitHub write (fake `fetch`) | "final approval effect before acknowledgement" |
| Cancellation whose accepted GitHub stop response is lost preserves occupancy across SDK endpoint and Restate container restart until the exact run is verified stopped | Real engine + real SQLite, simulated GitHub Actions cancel/status API | "a lost cancellation acknowledgement and endpoint restart" |
| Launch response loss, uncertain-launch reconciliation (including the two-minute-equivalent unknown-launch alert actually firing), definitive rejection, duplicate/conflicting result intake, a stale result delivered after the attempt's final outcome (alerts, never rewrites the recorded outcome), GitHub-success-without-result, cancel/closed-PR/unverifiable-termination | Real engine + real SQLite + real worker/finalizer adapters, simulated GitHub Actions API (fake transport/fetch) | the matching named scenarios |
| GitHub-success-without-result specifically never approves *before* the deadline, not just *at* it | Real engine + real SQLite, checked directly against `review_fix_attempts.terminal_outcome_json`/`accepted_result_json` and `dispatch_admissions.released_at` partway through a real (short) deadline window — `RestateTestEnvironment` has no virtual-clock/timer-control API to fast-forward past the wait instead (confirmed against its type declarations), so this mid-window SQLite read, not a simulated clock, is the deterministic "not yet" proof | "GitHub success without a stored result never approves and stops without approval at the deadline" |
| A restart (replaced SDK endpoint + restarted, disk-backed Restate container) resumes the same attempt from the same SQLite row and the same journal | Real engine + real SQLite, across a genuine container restart | the final "restart" scenario |
| GitHub's actual dispatch/reconcile/check-run/review/merge-policy behavior, its actual rate limits, and its actual eventual consistency (e.g. `workflow_dispatch` run-listing lag) | **Not proven here** — simulated by hand-built fixtures | needs live evidence |
| The literal two real minutes of `REVIEW_FIX_UNKNOWN_LAUNCH_ALERT_MINUTES` elapsing in production | **Not proven here** — `review-fix-attempt.ts`'s workflow now accepts an optional `unknownLaunchAlertMs` override (defaulting to the real two minutes; production composition leaves it unset), and this suite's shared `attemptWorkflow` supplies a one-second value so the uncertain-launch scenario asserts the `alert-unknown-launch` callback actually fires (reason including "launch identity still unresolved") without a 120s+ test. This proves the alert-firing code path — the same comparison and callback production uses — end to end against the real engine; it does not independently exercise the production constant's literal value, which is a one-line arithmetic input to that same path | a long-running live/soak test is the only way to observe the real two-minute constant elapse; not required for AII-813 |
| Deployment drain (`register()`'s conflict/force-registration path) and the workflow/journal/idempotency retention configuration | Already proven elsewhere, not duplicated here | `endpoint.restate.test.ts` / `endpoint-registration.restate.test.ts` (drain); `REVIEW_FIX_RETENTION_MS` metadata assertion in `review-fix-attempt.restate.test.ts` (retention) |
| Real Fly Machines/GitHub Actions runner container behavior under the pilot | **Not proven anywhere in this repo's test tree** | needs live evidence — this is the same class of gap the "real `restate-server` binary" row above already names for the engine itself |

This file was authored in a session with no local Docker daemon (`docker info` failed), the same
constraint `endpoint.restate.test.ts` (AII-727) recorded in its own header comment and in this
doc's "Container-to-host reachability" section above. CI has since run `npm run test:restate`
against pinned server 1.7.10; this is container evidence, not a live pilot rollout, and
its pass/fail there — not this document — is the authoritative evidence for AII-813's "both
container variants and SDK boundary suite pass" acceptance criterion. `npx tsc --noEmit --project
tsconfig.restate-tests.json` passes as of the commit that added this section.
