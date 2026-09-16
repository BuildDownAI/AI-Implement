# Restate in the orchestrator

Restate is the durable-execution engine that holds workflow position for the run kinds migrated under ADR 017 and ADR 018. It does not replace the orchestrator: workflow code runs inside the Node process, and SQLite stays the system of record. Restate holds the journal and drives the handlers.

## What runs where

| Piece | Where | Owner |
|---|---|---|
| `restate-server` | A sidecar child process of the orchestrator on the same machine (ADR 023) | AII-627 documents it below |
| The SDK endpoint | An HTTP listener inside the orchestrator process, `src/restate/endpoint.ts`, on `127.0.0.1:9080`. The server calls it (push model); nothing else does | AII-612 |
| Workflows | One module per run kind under `src/restate/`, registered in the endpoint | one per migration |

## The endpoint module

`src/restate/endpoint.ts` builds the SDK endpoint with the registered service set and exposes the bind address. The service set is empty until the first workflow registers. It binds to localhost only: the server and the orchestrator share a machine, and the SDK endpoint must never be reachable from outside it.

## Testing

`npm run test:restate` runs the `src/__tests__/*.restate.test.ts` files and nothing else. The default `npm test` excludes them in `vitest.config.ts`, so the default suite needs no Docker on any machine or inside a dispatched runner, where the agent runs `npm test` during implement passes. CI runs them in the `restate-tests` job of `.github/workflows/unit-tests.yml`, which inherits the `pull_request` triggers including `ai-implement/feature/**`.

A test starts one Restate container per file with `RestateTestEnvironment.start` from `@restatedev/restate-sdk-testcontainers` and registers the services it needs directly. Container boot takes seconds; a file is capped at 60 seconds. `alwaysReplay: true` forces replay at every suspension and is on for every scenario; `disableRetries: true` surfaces error paths at once. Tests run disarmed: the suite setup clears `RUN_TOKEN`, `RUNNER_CALLBACK_URL`, and `RUN_PROGRESS_TOKEN`, and an armed fixture points at an unroutable host (AII-567).

### How an issue adds Restate tests (operator rule, 2026-09-16)

Every issue that adds or changes Restate behavior writes its tests in this order and states the order in its acceptance criteria:

1. Unit tests first, in the default suite (`src/__tests__/<module>.test.ts`), for every pure part: parsers, formatters, state-table branches with the Restate client injected as a fake. They run with no Docker, inside every dispatched runner.
2. Restate scenarios second, in `src/__tests__/<module>.restate.test.ts`, a sibling of the unit file, run by `npm run test:restate` and the `restate-tests` CI job after `unit-tests`. Register exactly the services the scenario needs (`services: [...]`), one environment with `alwaysReplay: true` for the happy paths and one with `disableRetries: true` for the error paths. Each scenario asserts an observable effect, never a journal internal: a call count on a fake, a state read through a shared handler, a returned value.
3. Type-check the Restate file explicitly (a throwaway tsconfig); `typecheck` excludes `src/__tests__`.

An issue with no Restate surface says so in the same place ("unit tests only"), so the absence is a decision and not an omission. The AII-688 tree is the first set of issues that carries this rule.

## Deployment and operations

Written by AII-627.

## Writing a workflow for a run kind

Written by the delete slice of the first case, after the first workflow is real.
