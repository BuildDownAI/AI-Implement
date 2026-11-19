---
name: verify-ai-implement
description: Drive AI-Implement's local orchestrator admin HTTP interface to verify operator login, project mapping inventory, and job history on a fresh database.
---

## Launch

From the repository root, use Node 24 with dependencies installed from the lockfile (npm ci on a fresh checkout), Python 3 and openssl. Run:

```sh
npm run check:node && npm run build
.agents/skills/verify-ai-implement/verify.py login
```

Each invocation launches the production dist/index.js entry point, SQLite initialization and embedded Restate in a new scratch directory. It generates a disposable admin code and GitHub App key. There are zero configured projects. The helper waits for /admin HTML and authenticates before reading data. Run one instance per host at a time. The helper checks ports 17941, 9070, 8081, 5122 and 9080 before starting. An occupied port requires a separate host or a later run.

## Doctor

With the current run's bearer token, GET /api/mappings must return HTTP 200 and an empty JSON object. The helper performs this read automatically. On startup failure inspect service.log in the printed directory.

## Drive

Run verify.py with a feature from [the map](features/README.md). Each invocation exercises the HTTP surface on its own instance. The browser admin dashboard, tracker-driven dispatch, MCP and runner workflows have additional behavior outside this map.

## Evidence

Keep the printed ai-implement-proof-* directory. http.jsonl records requests and resulting status and JSON with session tokens redacted. service.log captures boot and shutdown. Login proof requires using the issued session for a protected read. The inventory and history journeys assert the fresh database state through public APIs. For future write journeys, read back the changed resource and verify external effects separately. Use real user entry points and record both action and result. Substitute only at an existing external boundary and observe any effects claimed to be skipped.

## Cleanup

The helper stops its owned process group and removes scratch data in its teardown. Evidence lives in a sibling temporary directory and survives cleanup. Copy it to durable storage for long-term retention.

## Helpers

From the repository root run `.agents/skills/verify-ai-implement/verify.py login`, replacing login with mappings or log for the other journeys.
