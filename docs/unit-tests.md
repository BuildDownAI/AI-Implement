# Unit tests

How the default test suite runs, what isolates it from the machine it runs on, what type-checks it, and what CI runs. The Restate tier has its own reference, [restate-testing.md](restate-testing.md). The bug-fix pattern is [bug-fix-tests.md](bug-fix-tests.md).

## Where tests live

| Path | Holds | Run by |
|---|---|---|
| `src/__tests__/` | Orchestrator and runner tests, mostly one file per module, with `admin/` and `providers/` subdirectories | `npm test` |
| `src/__tests__/restate/` | Restate engine scenarios (`*.restate.test.ts`) | `npm run test:restate` only |
| `src/__tests__/setup/` | The setup files both vitest configs load, the environment allowlist, and their tests | — |
| `src/__tests__/helpers/` | Shared fixture builders and the test harnesses at the top; one service's reply shapes in `replies/`; one subsystem's shared fixtures in `fixtures/`; their tests in `__tests__/` ([README](../src/__tests__/helpers/README.md)) | `npm test` (`__tests__/`) |
| `src/__tests__/fixtures/` | Static fixture data: files a test reads or compares against | — |
| `src/admin-ui/__tests__/` | The admin SPA's modules: its pages, auth, router and drawer | `npm test` |

## What `npm test` runs

1. **The database isolation check.** `scripts/check-test-db-isolation.mjs` creates a SQLite file with a sentinel table, runs `src/__tests__/github-dispatch.test.ts` with `DEDUP_DB_PATH` pointed at that file, and fails when the run added a table or changed the sentinel row.
2. **`vitest run` with `vitest.config.ts`.** The config sets `DEDUP_DB_PATH` to `:memory:` through `test.env`, because `dedup.ts` reads the path at import time. It runs each test file in its own forked process (`pool: "forks"`), loads two setup files one after the other (`scrub-ambient-env.ts`, then `clear-runner-credentials.ts`; `sequence.setupFiles: "list"` states the order explicitly), includes `src/**/*.test.ts`, and excludes `src/__tests__/restate/**`. Tests and hooks time out after 30 seconds.

`npm run test:restate` uses `vitest.restate.config.ts`: the same database setting, the same two setup files in the same order, the `*.restate.test.ts` files plus the environment guard test, and 60-second timeouts.

A test file never opts into any of this. Whichever config collects it decides its environment, setup files and timeouts, so a Restate scenario named outside the `*.restate.test.ts` shape is either collected by neither config or run under the default suite's settings. `src/__tests__/restate-test-hygiene.test.ts` fails on both: a test file under `restate/` without that suffix, and a test file outside `restate/` that starts a Restate engine.

## Isolation from the machine

A test result must not depend on the machine that runs it — a laptop, a CI runner, a dispatched runner container or a Fly machine. Three mechanisms apply:

| What | Mechanism | Applies |
|---|---|---|
| The application database | `DEDUP_DB_PATH=:memory:` in both configs; the isolation check guards it | Every run |
| The ambient environment | The environment scrub deletes every variable its allowlist does not cover and pins a few values | Every run, in every environment |
| Runner credentials (`RUN_TOKEN`, `RUNNER_CALLBACK_URL`, `RUN_PROGRESS_TOKEN`, `RUN_PUBLICATION_TOKEN`, `GIT_KG_PUSH_TOKEN_FILE`) | `clear-runner-credentials.ts` deletes them again before each test | Every run |

### The environment scrub

Each config lists a scrub file first in `setupFiles`. vitest runs setup files inside each test file's worker, before it imports the test file, so the scrub's top-level code runs before any test or module under test reads `process.env`. The scrub deletes every variable the allowlist does not cover, then sets each pinned value.

The allowlist lives in `src/__tests__/setup/ambient-env.ts`, as an `EnvAllowlist` value with three parts: `names` kept as they are, `prefixes` that keep every variable starting with them, and `pinned` variables set to a fixed value whatever the machine set. Every entry carries its reason. `BASE_ENV_ALLOWLIST` serves both configs: it keeps `PATH` and `DEDUP_DB_PATH`, keeps the two operator switches a test reads (`CODEX_PINNED_PROOF` and `CAPTURE_FIXTURES`, so a run that sets one still reaches its test), and pins `NODE_ENV`, `TZ` and git's global and system configuration, so a developer's `~/.gitconfig` cannot sign or block a test's commits. `TZ` is the one preventive entry: no test depended on the time zone when it was pinned. The Restate tier needs nothing more: its engine is the `restate-server` binary from `node_modules`, which `binary-environment.ts` starts with an environment of its own.

**When a config needs more than the base.** Give it an allowlist of its own built from the base, so the base's entries stay in one place, and leave the other config's environment unchanged:

```ts
export function extendEnvAllowlist(base: EnvAllowlist, extra: Partial<EnvAllowlist>): EnvAllowlist {
  return {
    names: { ...base.names, ...extra.names },
    prefixes: { ...base.prefixes, ...extra.prefixes },
    pinned: { ...base.pinned, ...extra.pinned },
  };
}
```

Each added entry states its reason, like the base's. That config then gets a scrub setup file of its own, listed first in its `setupFiles`, and its guard test checks the new allowlist. The Restate tier worked this way while it could run its engine in a Docker container: its allowlist added `RESTATE_TEST_RUNTIME`, which chose the runtime, and the Docker and testcontainers settings that located the engine. AII-1195 removed that runtime, and the extra allowlist went with it.

Three decisions shape it:

- **An allowlist, not a list of the variables the code reads.** Code reads the environment through `env` parameters, helper functions that take a name, prefixes (`RESTATE_*`), suffix patterns (`envSecrets()` collects every `_TOKEN`, `_KEY`, `_SECRET` and `_PASSWORD` value) and names that a value lists (`AI_IMPLEMENT_FORWARDED_SECRETS`). A list of names misses some of them and quietly lets each new one through. An allowlist covers every current and future read, and a missing entry fails a test on every machine rather than leaking on one.
- **Deleted, not stubbed.** A test that calls `vi.unstubAllEnvs()` restores stubbed values, which would put a deleted credential back. A deleted variable stays deleted.
- **At the setup file's top level, not in a `beforeEach`.** vitest runs a setup file's `beforeEach` after the test file's `beforeAll`, so a scrub there would delete every value a test file sets in `beforeAll`. Values a test file sets at its own top level, in `beforeAll` or in `beforeEach` all survive the top-level scrub.

A test that needs a variable sets it itself, at its top level or in a hook. An entry belongs in the allowlist only when tests need the machine's own value, and it goes in with the reason that shows it: a test that fails without it, or, for a preventive pin like `TZ`, the machine dependence it closes.

A guard test, `src/__tests__/setup/ambient-env.test.ts`, fails when a test sees any variable outside the allowlist, and names each one. Both configs collect it, the Restate config by naming it in its `include`, so it checks the scrub each config loads. It also tests `scrubAmbientEnv` on an injected environment object and requires every entry to state its reason.

The credential `beforeEach` in `clear-runner-credentials.ts` predates the scrub and stays: it deletes the five runner credentials again before every test. It runs after the test file's `beforeAll` hooks and before its `beforeEach` hooks, so a credential a test file sets in `beforeAll` is removed, while one it sets in its own `beforeEach` survives. It exists because a runner's own `npm test` once posted to the live orchestrator with the run's single-use token and consumed it; see [solutions/workflow-patterns/runner-test-suite-burned-the-run-token.md](solutions/workflow-patterns/runner-test-suite-burned-the-run-token.md).

### What the scrub does not reach

- **vitest's main process.** The scrub runs in each test worker. The main process, which collects files and runs reporters, still sees the full environment.
- **Production.** The scrub runs only under vitest. What the orchestrator and the runner pass to the processes they start is unaffected.
- **The machine beyond its environment variables.** Files a test reads through a fixed path, and the network, still differ between machines.

## Type checking

- vitest removes types without checking them, so `npm test` passes test code that is not type-valid. The type check is what catches a test that no longer matches the code it tests.
- `npm run typecheck` runs two passes. The first is `tsc --noEmit` against `tsconfig.json`, which excludes `src/__tests__`. The second is `tsc --noEmit -p tsconfig.tests.json`, which extends it, includes every `.ts` file under `src/` and sets `"exclude": []`, so every test file is checked, the Restate tier's included.
- The empty `exclude` is required, because the base config's `exclude` still filters a derived config's `include`. Without it, a config that lists only test files fails with `TS18003: No inputs were found`, and a config that also lists a source file passes with exit code 0 while it silently drops the test files.
- Test files are held to the base config's options, `noUnusedLocals` and `noUnusedParameters` among them, so an unused import or variable in a test fails the check.
- A new test file needs no config of its own: the second pass's `include` already covers it. `tsc --noEmit --listFiles -p tsconfig.tests.json` shows the checked set.

## Fakes and fixtures

The shared builders, harnesses, service replies and subsystem fixtures live in `src/__tests__/helpers/`. [Its README](../src/__tests__/helpers/README.md) owns what each one does, how to use it, and where a new helper goes. This section holds the rules every fixture and fake follows, whatever builds it.

### Fixture builders

`src/__tests__/helpers/builders.ts` holds one builder for each commonly built fixture type. Build a test's fixtures with them rather than a new per-file copy.

**When a type gets a builder.** Once it is hand-built as a fixture, an input whose values do not matter to the test, in three or more test files. A value under test, such as a step a pipeline test runs or a failure record a classifier classifies, stays inline however often it repeats.

**What a builder guarantees.** A builder returns a complete object of its type with neutral defaults, takes overrides for the fields a test cares about, and returns its type without a cast, so a field added to the type fails the type check at the builder wherever test files are type-checked ([§ Type checking](#type-checking)).

**Overriding a default.** Override a field only when the test depends on it: removing the override fails one of its tests, or leaves the fixture contradicting other data in the same test, such as a mapping whose repository differs from the job looked up under it.

**A state production can reach.** Removing an override shows only that a test needs it, not that the fixture could exist. Check each fixture a test builds against the code that produces its values, and check all of it, not only the fields the test sets:

- **Each value is one production can produce.** An issue identifier's team prefix matches the provider that sets `scopeKey`, a field production fills with a commit holds a commit rather than a branch name, and a status code is one the route actually sends.
- **Values production derives from one another agree.** An implementation branch is named from the issue's identifier and title (`buildIssueBranchName`), a step's inputs carry the context fields the pipeline copies into them (`pipeline-loader.ts`), and a repository matches the row it is looked up for.
- **Fields production always sets are present.** A fixture that leaves one out can send the code down a branch production never takes, and a test of that branch is not a test of production's path.

The same holds for a fake's replies: each must be one the real API or module can return, such as a vended token with the `expires_at` its route always sends.

**Per-file helpers.** A test file keeps a builder of its own only for what no other file shares. A wrapper fixes the values every test in one file uses and passes the rest to a shared builder, as `acmeBilling` in `review-fix-drain.test.ts` does over `makeMapping`; its fields still come from the shared builder, so a change to the type is still made in one place. A builder for a type only one file builds stays in that file, such as `makeKgPrCheck` in `webhook.test.ts`, and moves into `builders.ts` once a third file needs it. Type neither with `as unknown as <Type>`, which compiles whatever the type becomes.

### Fakes

- **Injected seams.** Many modules that call a network or a client take an implementation parameter, such as `fetchImpl` or `getInstallationTokenImpl`, and tests pass a fake. For `fetchImpl`, pass a `fakeFetch` ([§ Harnesses](#harnesses)). For the others, reuse the fake in the module's existing test file before you write a new one ([bug-fix-tests.md](bug-fix-tests.md), step 1). Several functions that read the environment take it the same way, as an `env` parameter defaulting to `process.env`.
- **The stateful fake provider.** `FakeProvider` in `src/__tests__/providers/fake.ts` implements `TicketingProvider` in memory: it holds issues, moves them through the lifecycle verbs, and records comments and, when asked, calls. `src/__tests__/providers/contract.ts` is the contract suite it passes. Use it when a test needs a tracker that remembers; use `makeProvider` when a test controls or asserts individual calls.
- **Module mocks.** `vi.mock` replaces a whole module. The test then exercises the mock, not the real module.

### Harnesses

A builder makes a value a test passes in. A harness makes something the code under test reaches for by itself, a temporary directory (`testDir`), a database (`testDb`) or an HTTP API (`fakeFetch`), and removes it when the test finishes. Use one rather than setting that up and tearing it down by hand; the [helpers README](../src/__tests__/helpers/README.md#harnesses) covers how each one is used and what it guarantees.

**Per-file helpers.** A test file keeps a helper over a harness for what only it needs, most often a function that installs `fakeFetch` with the routes one service answers in that file, each with the reply production's handler sends, such as `commentTriggerApi` in `webhook.test.ts`. `MockRequest` and `MockResponse`, a request and response pair for calling an HTTP handler directly, are still copied across the files that do so; they are not a harness yet.

## CI

`.github/workflows/unit-tests.yml` runs on each pull request into `testing`, `main`, `ai-implement/feature/**` and `ai-implement/multi-issue/**`:

| Job | Runs |
|---|---|
| `unit-tests` | `npm ci`; `npm test`; `npm run typecheck` (both passes, so every test file is type-checked) |
| `restate-tests-binary` | `npm run test:restate`, once in each of three parallel passes |

No job unsets anything before running tests: the scrub gives CI the same environment as every other machine.

The `testing` and `main` rulesets do not require these checks, so a red check does not block a merge. Auto-merge of a child PR into a grouping branch does wait: `autoMergeRepo` in `src/auto-merge.ts` skips a PR whose checks failed and holds one whose checks are pending.
