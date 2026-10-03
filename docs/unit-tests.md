# Unit tests

How the default test suite runs, what isolates it from the machine it runs on, what type-checks it, and what CI runs. The Restate tier has its own reference, [restate-testing.md](restate-testing.md). The bug-fix pattern is [bug-fix-tests.md](bug-fix-tests.md).

## Where tests live

| Path | Holds | Run by |
|---|---|---|
| `src/__tests__/` | Orchestrator and runner tests, mostly one file per module, with `admin/` and `providers/` subdirectories | `npm test` |
| `src/__tests__/restate/` | Restate engine scenarios (`*.restate.test.ts`) | `npm run test:restate` only |
| `src/__tests__/setup/` | The setup files both vitest configs load, the environment allowlist, and their tests | — |
| `src/__tests__/helpers/` | Shared fixture builders and their tests | — |
| `src/__tests__/fixtures/` | Static fixture data | — |
| `src/admin-ui/__tests__/` | The admin SPA's modules: its pages, auth, router and drawer | `npm test` |

## What `npm test` runs

1. **The database isolation check.** `scripts/check-test-db-isolation.mjs` creates a SQLite file with a sentinel table, runs `src/__tests__/github-dispatch.test.ts` with `DEDUP_DB_PATH` pointed at that file, and fails when the run added a table or changed the sentinel row.
2. **`vitest run` with `vitest.config.ts`.** The config sets `DEDUP_DB_PATH` to `:memory:` through `test.env`, because `dedup.ts` reads the path at import time. It runs each test file in its own forked process (`pool: "forks"`), loads two setup files one after the other (`scrub-ambient-env.ts`, then `clear-runner-credentials.ts`; `sequence.setupFiles: "list"` states the order explicitly), includes `src/**/*.test.ts`, and excludes `src/__tests__/restate/**`. Tests and hooks time out after 30 seconds.

`npm run test:restate` uses `vitest.restate.config.ts`: the same database setting, the Restate tier's scrub (`scrub-ambient-env.restate.ts`) followed by `clear-runner-credentials.ts`, only `*.restate.test.ts` files, and 60-second timeouts.

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

The allowlists live in `src/__tests__/setup/ambient-env.ts`, as `EnvAllowlist` values with three parts: `names` kept as they are, `prefixes` that keep every variable starting with them, and `pinned` variables set to a fixed value whatever the machine set. Every entry carries its reason. `BASE_ENV_ALLOWLIST` serves the default suite: it keeps `PATH` and `DEDUP_DB_PATH`, and pins `NODE_ENV`, `TZ` and git's global and system configuration, so a developer's `~/.gitconfig` cannot sign or block a test's commits. `TZ` is the one preventive entry: no test depended on the time zone when it was pinned. `RESTATE_ENV_ALLOWLIST` extends the base, through `extendEnvAllowlist`, with the variables that locate the Restate tier's infrastructure — `RESTATE_TEST_RUNTIME`, which CI's `restate-tests-binary` job uses to force the binary runtime, and the Docker and testcontainers settings — none of which configures the code under test.

Three decisions shape it:

- **An allowlist, not a list of the variables the code reads.** Code reads the environment through `env` parameters, helper functions that take a name, prefixes (`RESTATE_*`), suffix patterns (`envSecrets()` collects every `_TOKEN`, `_KEY`, `_SECRET` and `_PASSWORD` value) and names that a value lists (`AI_IMPLEMENT_FORWARDED_SECRETS`). A list of names misses some of them and quietly lets each new one through. An allowlist covers every current and future read, and a missing entry fails a test on every machine rather than leaking on one.
- **Deleted, not stubbed.** A test that calls `vi.unstubAllEnvs()` restores stubbed values, which would put a deleted credential back. A deleted variable stays deleted.
- **At the setup file's top level, not in a `beforeEach`.** vitest runs a setup file's `beforeEach` after the test file's `beforeAll`, so a scrub there would delete every value a test file sets in `beforeAll`. Values a test file sets at its own top level, in `beforeAll` or in `beforeEach` all survive the top-level scrub.

A test that needs a variable sets it itself, at its top level or in a hook. An entry belongs in the allowlist only when tests need the machine's own value, and it goes in with the reason that shows it: a test that fails without it, or, for a preventive pin like `TZ`, the machine dependence it closes.

Each tier has a guard test that fails when a test sees any variable outside that tier's allowlist, and names each one.
- `src/__tests__/setup/ambient-env.test.ts` guards `BASE_ENV_ALLOWLIST` in the default suite; it also tests `scrubAmbientEnv` on an injected environment object and requires every entry to state its reason.
- `src/__tests__/restate/ambient-env.restate.test.ts` guards `RESTATE_ENV_ALLOWLIST` under the Restate config, because the default suite's guard never runs there.

The credential `beforeEach` in `clear-runner-credentials.ts` predates the scrub and stays: it deletes the five runner credentials again before every test. It runs after the test file's `beforeAll` hooks and before its `beforeEach` hooks, so a credential a test file sets in `beforeAll` is removed, while one it sets in its own `beforeEach` survives. It exists because a runner's own `npm test` once posted to the live orchestrator with the run's single-use token and consumed it; see [solutions/workflow-patterns/runner-test-suite-burned-the-run-token.md](solutions/workflow-patterns/runner-test-suite-burned-the-run-token.md).

### What the scrub does not reach

- **vitest's main process.** The scrub runs in each test worker. The main process, which collects files and runs reporters, still sees the full environment.
- **Production.** The scrub runs only under vitest. What the orchestrator and the runner pass to the processes they start is unaffected.
- **The machine beyond its environment variables.** Files a test reads through a fixed path, and the network, still differ between machines. The Restate tier's container runtime is the clearest case: it depends on the container being able to reach the test process over the host's network.

## Type checking

- `npm run typecheck` runs `tsc --noEmit` against `tsconfig.json`, which excludes `src/__tests__`. `src/admin-ui/__tests__` is not excluded, so those tests are type-checked.
- vitest removes types without checking them. `npm test` passes test code that is not type-valid.
- **Per-file test configs.** Each root-level `tsconfig.*-tests.json` extends `tsconfig.json`, lists the files it checks in `include` (mostly named test files; some add the source files under test, and `tsconfig.restate-tests.json` uses globs), and sets `"exclude": []`. The empty `exclude` is required, because the base config's `exclude` still filters a derived config's `include`. Without it, a config that lists only test files fails with `TS18003: No inputs were found`, and a config that also lists a source file passes with exit code 0 while it silently drops the test files. Confirm the checked set with `tsc --listFiles` when you write a new config.
- CI runs six of these configs: `tsconfig.review-fix-ports-tests.json`, `tsconfig.dispatch-admission-tests.json`, `tsconfig.review-fix-attempt-store-tests.json`, `tsconfig.review-fix-finalize-tests.json` and `tsconfig.aii-806-tests.json` in the `unit-tests` job, and `tsconfig.restate-tests.json` in the `restate-tests` job. The others are not run anywhere.
- The current convention, stated in `CLAUDE.md` § Running tests and [bug-fix-tests.md](bug-fix-tests.md) § Which tier: type-check a new test file with a throwaway config.

## Fakes and fixtures

### Fixture builders

`src/__tests__/helpers/builders.ts` holds one builder for each commonly built fixture type. Build a test's fixtures with them rather than a new per-file copy.

**When a type gets a builder.** Once it is hand-built as a fixture, an input whose values do not matter to the test, in three or more test files. A value under test, such as a step a pipeline test runs or a failure record a classifier classifies, stays inline however often it repeats.

**What a builder guarantees.** A builder returns a complete object of its type with neutral defaults, takes overrides for the fields a test cares about, and returns its type without a cast, so a field added to the type fails the type check at the builder wherever test files are type-checked (§ Type checking).

**Reading a builder's failure.** A new required field fails the builder's object with TS2322, or with TS2345 where the object is passed to a constructor or a spy (`makeContext`, `makeExecutor`). The error's first line prints the whole object type; the indented lines beneath name the field, as `Types of property '…' are incompatible` rather than missing, because the overrides could supply it. Give the field a default in the builder. A changed `ProviderRegistry` constructor fails at the `super(...)` call in `makeRegistry`'s subclass (TS2554), and a renamed `forMapping` at that subclass's `override` (TS4113).

**Where the defaults come from.** The defaults are literals, not the production `DEFAULT_*` constants: a test of what an unconfigured mapping gets calls the code that applies the default, not a builder. `builders.test.ts` passes each default through the code that consumes it where one exists, such as storing a mapping and reading it back, so a default cannot describe a state production never produces.

**Builders that are not plain data.** `makeProvider` returns a `TicketingProvider` whose every method is a spy typed by its own signature, and `makeExecutor` an `LLMExecutor` whose `invoke` is one, each with a safe default passed as the spy's implementation, so the default survives `mockReset`. `makeRegistry` returns a subclass of the real `ProviderRegistry` that overrides only `forMapping`: the class has private members, so no object literal satisfies its type without a cast, and the registry's other lookups still run their own code against the given provider.

**Per-file copies.** Many test files still define their own builders for the same types, under `make*` names and others such as `mapping`, and the copies do not all share a signature. They move onto the shared builders file by file. Many are typed with `as unknown as <Type>`, and such a fixture compiles whatever the type becomes, so it cannot show drift.

### Fakes

- **Injected seams.** Many modules that call a network or a client take an implementation parameter, such as `fetchImpl` or `getInstallationTokenImpl`, and tests pass a fake. Reuse the fake in the module's existing test file before you write a new one ([bug-fix-tests.md](bug-fix-tests.md), step 1). Several functions that read the environment take it the same way, as an `env` parameter defaulting to `process.env`.
- **The stateful fake provider.** `FakeProvider` in `src/__tests__/providers/fake.ts` implements `TicketingProvider` in memory: it holds issues, moves them through the lifecycle verbs, and records comments and, when asked, calls. `src/__tests__/providers/contract.ts` is the contract suite it passes. Use it when a test needs a tracker that remembers; use `makeProvider` when a test controls or asserts individual calls.
- **Module mocks.** `vi.mock` replaces a whole module. The test then exercises the mock, not the real module.

### Harnesses

Many test files build their own fresh database for each test: they point `DEDUP_DB_PATH` at a temporary file, call `vi.resetModules()`, and import the modules again, so each module reads the new path. Many also build their own fake `fetch` or temporary directories. No shared harness exists.

## CI

`.github/workflows/unit-tests.yml` runs on each pull request into `testing`, `main`, `ai-implement/feature/**` and `ai-implement/multi-issue/**`:

| Job | Runs |
|---|---|
| `unit-tests` | `npm ci`; `npm test`; `npm run typecheck`; five per-file test configs |
| `restate-tests` | `npm run test:restate`, which picks the container runtime because the runner has Docker; `tsconfig.restate-tests.json` |
| `restate-tests-binary` | `npm run test:restate` with `RESTATE_TEST_RUNTIME=binary`, three passes |

No job unsets anything before running tests: the scrub gives CI the same environment as every other machine.

The `testing` and `main` rulesets do not require these checks, so a red check does not block a merge. Auto-merge of a child PR into a grouping branch does wait: `autoMergeRepo` in `src/auto-merge.ts` skips a PR whose checks failed and holds one whose checks are pending.
