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
- `RestateTestEnvironment.start` hosts the services on its own endpoint. `src/restate/endpoint.ts` (`startRestateEndpoint`, `register`, `RESTATE_SERVICES`) is not exercised by this tier; `register()` is unit-tested against a faked admin API only.

## Coverage as of the AII-687 tree (2026-09-17)

What the Restate tier proves today: exclusive-handler serialisation, the in-window grace path, unknown-hash and expired handling, `revoke`, `describe`, replay determinism across both variants, the `tool()` wrapper's role, error, and suspension behaviour over the real wire, the migrated read handlers through the ingress, the ingress serde 4xx, discovery metadata and projected schemas for reads and writes, a user refused a write over the wire, idempotency-key dedup on `pause_project`, and engine retry on a raw handler. The write tools' business logic has a full fake-backed unit tier.

Known gaps, for the next issue that touches the area:

| Gap | Why it matters |
|---|---|
| `refresh` with a stale previous hash (outside the grace window) never runs against a real or fake context; only `decideRefresh` is tested for that branch | The `if (decision.clear) ctx.clearAll()` line is the theft-revocation path. Deleting it passes the suite |
| `startRestateEndpoint()` and the `RESTATE_SERVICES` list have no test | Dropping a service from the list passes every test; in production `register()` succeeds against an endpoint that does not serve it |
| `register()` has never met a real admin API | A Restate release that changes the `META0004` code or the no-op semantics leaves the unit tests green |
| `RestateRefreshAuthority` has never met a real ingress | The production client's URL, body, and empty-body handling are checked against a faked `fetch` only |
| `describe` during an in-flight exclusive `refresh` | The `shared` handler's non-blocking claim is asserted nowhere |
| The real `restate-server` binary is never spawned in a test | The `RESTATE_*__*` env keys are verified by hand with `--dump-config`, not by a test |
| `restate-tests` is not a required check on `testing` | A red job does not block a merge until an operator marks the check required |
