# Shared test helpers

The fixture builders, harnesses, service replies and subsystem fixtures the test suite shares: what each one does, how to use it, and where a new one goes. The rules every fixture and fake follows, whatever builds it (when a type gets a builder, what a builder guarantees, overriding a default, a state production can reach), are in [`docs/unit-tests.md` § Fakes and fixtures](../../../docs/unit-tests.md#fakes-and-fixtures).

| Path | Holds |
|---|---|
| `builders.ts` | The [fixture builders](#fixture-builders) |
| `test-db.ts`, `fake-fetch.ts`, `test-dir.ts` | The [harnesses](#harnesses) |
| `replies/` | One external service's [reply shapes](#service-replies) for `fakeFetch` |
| `fixtures/` | One subsystem's [shared fixtures](#subsystem-fixtures) |
| `__tests__/` | The helpers' own tests |

## Fixture builders

`builders.ts` has one function per commonly built type (`makeMapping`, `makeIssue`, `makeJob`, `makeContext`, `makeExecutor`, `makeProvider`, `makeRegistry`, `makeAppendLogEntry`, `makeFeedbackLoopOutputs`, and the rest): each returns a complete object with neutral defaults, overrides spread last.

**Where the defaults come from.** The defaults are literals, not the production `DEFAULT_*` constants: a test of what an unconfigured mapping gets calls the code that applies the default, not a builder. `__tests__/builders.test.ts` passes each default through the code that consumes it where one exists, such as storing a mapping and reading it back, so a default cannot describe a state production never produces.

Some defaults are not fixed literals. They change with each build, or they follow from other fields, as the real values do:

| Builder | Field | Its value |
|---|---|---|
| `makeJob` | `dispatchedAt` | The clock when the object is built |
| `makeReviewFixResult` | `deadlineAt` | An hour after the object is built |
| `makeReviewFixRunConfig` | The attempt's `deadlineAt` | An hour after the object is built |
| `makeReviewFixRunConfig` | The envelope's issue and PR number | The attempt it carries, as the review-fix worker derives them |
| `makeAppendLogEntry` | `dispatchId` | Fresh for each build, as each real dispatch gets one |
| `makeChatGptPlanRecord` | `savedAt` | The clock when the object is built |
| `makeChatGptPlanRecord` | `accessTokenExpiresAt` | An hour after `savedAt`, as sign-in sets it from the token's lifetime |
| `makeFeedbackLoopOutputs` | `passes`, `finalFeedback`, `terminationReason`, `failure` | `approved`, `iterations` and `terminationReason`: one pass per iteration, the last ending the way the step ends that kind of run (a `max_turns` pass is never reviewed, and a `provider_unavailable` run carries its `failure`) |

Two builds of a clock or fresh-id field can differ, so a test that compares builds freezes the clock with `vi.setSystemTime` or overrides the field. A derived field agrees with the fields it follows from, so overriding those still yields a consistent object; a test that overrides the derived field itself describes a different object and owns its consistency.

**Builders that are not plain data.** `makeProvider` returns a `TicketingProvider` whose every method is a spy typed by its own signature, and `makeExecutor` an `LLMExecutor` whose `invoke` is one, each with a safe default passed as the spy's implementation, so the default survives `mockReset`. `makeRegistry` returns a subclass of the real `ProviderRegistry` that overrides only `forMapping`: the class has private members, so no object literal satisfies its type without a cast, and the registry's other lookups still run their own code against the given providers. It takes either one `provider`, which every mapping resolves to, or `providers` keyed by tracker id, never both. A tracker missing from `providers` throws, as an unconstructable provider does in production, so the real `forAllMappings` skips it with a warning.

**Reading a builder's failure.** A new required field fails the builder's object with TS2322, or with TS2345 where the object is passed to a constructor or a spy (`makeContext`, `makeExecutor`). The error's first line prints the whole object type; the indented lines beneath name the field, as `Types of property '…' are incompatible` rather than missing, because the overrides could supply it. Give the field a default in the builder. A changed `ProviderRegistry` constructor fails at the `super(...)` call in `makeRegistry`'s subclass (TS2554), and a renamed `forMapping` at that subclass's `override` (TS4113).

## Harnesses

| Harness | Gives a test | Replaces |
|---|---|---|
| `testDir(prefix?)`, `test-dir.ts` | An empty directory under the OS temp directory | `mkdtempSync` plus a removal list in `afterEach` |
| `testTempRoot(prefix?)`, `test-dir.ts` | A `testDir` that the OS temp directory points at | Stubbing `TMPDIR`, `TEMP` and `TMP`, then restoring them by hand |
| `testDb(options?)`, `test-db.ts` | Its own database file with every table boot creates, and the modules it asked for, imported against that file | Setting `DEDUP_DB_PATH`, `vi.resetModules()`, dynamic imports and table creation in `beforeEach`, then `closeDb()` and a file delete in `afterEach` |
| `fakeFetch(routes)`, `fake-fetch.ts` | A `fetch` that answers from a route table and records every request | A per-file fake, or `vi.stubGlobal("fetch", vi.fn())` with queued replies |

**How a harness cleans up.** Each one registers its cleanup with vitest's `onTestFinished`, which runs after the test and its `afterEach` hooks whether the test passed or failed, so the caller writes no `afterEach`. Call a harness from a test or a `beforeEach`. vitest throws "can only be called inside a test" from a `beforeAll` or a `describe` body, because the cleanup must belong to one test.

**Naming.** A harness is named for what a test gets (`testDir`, `testDb`, `fakeFetch`), and the name says it belongs to a test, since it works only inside one. The `make*` prefix stays with the builders: plain data, buildable anywhere.

**`testDir`.** It returns an empty directory, removed with everything in it when the test finishes. `prefix` goes into the directory's name (`ai-implement-<prefix>-…`), which identifies a leaked one.

**`testTempRoot`.** For code that writes under `os.tmpdir()` itself rather than taking a directory, such as a background deploy's scratch directory or a container's secret env file. It creates a `testDir`, then points `TMPDIR`, `TEMP` and `TMP` at it, the variables `os.tmpdir()` reads first on POSIX and on Windows, so whatever the code creates there is removed with it. When the test finishes, each variable goes back to its earlier value, or is unset again, before the directory is removed. A `testDir` called after it lands inside it.

**`testDb`.** `dedup.ts` resolves its database path once, when it is first imported. A test therefore gets its own database only by setting `DEDUP_DB_PATH`, resetting the module registry, and importing every database module again; `testDb` does these in that order, with the file inside a `testDir`. A test passes the modules it needs as loaders and gets them back, typed (paths here as written from a test file in `src/__tests__/`):

```ts
const MODULES = { log: () => import("../log.js"), hold: () => import("../deploy-hold.js") };
let db: TestDb<typeof MODULES>;

beforeEach(async () => {
  db = await testDb({ modules: MODULES });
});
```

Import these modules only through loaders. A static import at the top of the test file binds once, to the database `dedup.ts` opened first, and a registry reset cannot rebind it. By default `testDb` creates every table `main()` in `src/index.ts` creates at boot, through `BOOT_TABLE_INITS`; `__tests__/harnesses.test.ts` fails when that list and `main()`'s calls differ, so a new table goes into both. It calls each table's init function on the real module, through `vi.importActual`, so a test file's `vi.mock` of one of those modules leaves table creation alone. A mock's factory runs once, and `vi.resetModules()` does not rebuild it. A mock that replaces the module has no init function for `testDb` to call. One that spreads the real module (`...(await importOriginal())`) hands out the functions of the copy its factory loaded, and that copy still uses the database `dedup.ts` had open at that moment, the same trap as a static import. Code under test that reaches any of those copied functions reads that database, not the test's. Two options cover the other cases:

- `tables: "none"` leaves the file unopened, for a test of code that meets a missing table, or of an upgrade from an older schema the test writes first. A test can call `testDb` again for this beside the database its `beforeEach` made.
- `db.reopen()` simulates a restart: it closes the database, resets the registry, creates the tables again, and returns freshly imported modules against the same file.

When the test finishes, the database is closed, the previous `DEDUP_DB_PATH` is restored, and the directory is removed along with any `-wal` and `-shm` files beside the database.

**`fakeFetch`.** A route key is `"<METHOD> <path>"`, matched against the request path without its query string. A reply is one of:

- `{ status?, json?, text?, headers? }`, built into a fresh `Response` for each request, with status 200 by default;
- a function of the recorded request that returns such an object or a `Response` it builds, for state kept between requests or a reply that depends on headers or the query. A function that throws makes `fetch` reject with what it threw, the way a network failure rejects; the request is still recorded, and the throw alone does not fail the test;
- `hangUntilAborted`, exported beside `fakeFetch`: a reply that never answers, and rejects with the abort's reason once the caller's signal fires, as `fetch` does. It proves a request is bounded by its timeout;
- a list of any of these, served one per request, in order.

Pass `fake.fetch` where a module takes `fetchImpl`, or call `fake.install()` when the code calls the global `fetch`; the original global comes back when the test finishes. `install()` returns the fake, so `const fake = fakeFetch(routes).install();` builds and installs it in one line, with no per-file helper. Each `install()` restores the global it replaced, and cleanups run last-registered first, so a test that installs a second fake over its `beforeEach`'s still ends on the original. Prefer `install()` to `vi.stubGlobal`, which stays in place until `vi.unstubAllGlobals()` because the vitest configs leave `unstubGlobals` off. `fake.calls` holds every request as received: method, URL, path, headers, body text, and the `AbortSignal` the caller passed, if any. A request no route matches, or one past the end of its route's list, throws to the caller and also fails the test when it finishes, naming the method and path. Production code often catches a failed `fetch`, and the test must not pass because it did.

## Service replies

A reply shaped like one service's API that several test files need lives beside `fakeFetch`, not in it, in `replies/<service>.ts`:

- `replies/github.ts`: `githubFile(text)` answers as GitHub's contents API does for a file, with the text base64-encoded; `githubError(status, message)` answers with the status and GitHub's error body (`message`, `documentation_url`, and the status as a string).
- `replies/fly.ts`: `flySecretsUpdated(version)` answers as the Machines API's `POST /v1/apps/{app_name}/secrets` does, with the new secrets version under both `version` and the deprecated `Version`.
- `replies/linear.ts`: `linearGraphql(...replies)` serves Linear's GraphQL endpoint one reply per request, each built with `linearData(data)`.

## Subsystem fixtures

A fixture one subsystem's tests share lives in `fixtures/<subsystem>.ts`, kept as one module so those tests build the subsystem's inputs the same way:

- `fixtures/configured-run.ts`: a resolved agent snapshot (`makeSnapshot`), a model-auth grant bound to it (`makeGrant`), the `launch` decision `prepareManagedDispatch` returns for such a grant on a dispatch backend, whose `takeBootstrap` hands the grant out once (`makeLaunchDecision`), the environment a configured run starts with (`envelopeEnv`), and a fake model-auth client that records its calls (`fakeClient`). Its clock is the fixed `NOW` it exports, and a grant expires 60 seconds after it, so wherever code checks a grant's expiry, the test injects that clock (`now: () => NOW`) or freezes the system clock there.
- `fixtures/gha-handoff.ts`: runs the real GitHub Actions bootstrap step script, then builds the Run step's environment from the workflow's own `env:` mapping and the bootstrap's outputs, so a missing handoff surfaces as a missing variable rather than one the fixture supplied.
- `fixtures/codex-composition.ts`: doubles for the external Codex boundary only, the `codex` child process and the planning protocol driver, with everything above them left as production code. A test file installs them from a passthrough `vi.mock` of `node:child_process` (for the `codex` command alone) and of `createCodexPlanningDriver`.
- `fixtures/workflow-input-contract.ts`: each synced workflow's exact `workflow_dispatch` inputs (ADR 032). A new input needs an entry with its reason here and an ADR update.

## Where a new helper goes

1. **A builder or harness any subsystem could use** goes at the top level: a builder in `builders.ts`, a harness in a file of its own beside the others.
2. **A reply shaped like one external service's API** goes in `replies/<service>.ts`.
3. **A fixture one subsystem's tests share** goes in `fixtures/<subsystem>.ts`.
4. **A helper's own tests** go in `__tests__/`.

**When a test needs more.** Use what the helpers offer first; a `fakeFetch` function reply covers most needs. Write the rest in the test file. A harness grows once three test files share the same new need, as a type gets a builder once three files build it. Two things override the count. A harness that breaks a promise it makes is fixed however few files hit it: `testDb` creates tables through the real modules because a test file's mock of a table's module left that table missing from the test's database. And many per-file workarounds around one harness are a sign it is missing something, so raise them rather than adding another. Growth keeps a harness general: what belongs to one service goes in `replies/`, and what one subsystem's tests share in `fixtures/`.
