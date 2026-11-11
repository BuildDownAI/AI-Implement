---
target: orchestrator
auth: none
timeout_minutes: 15
---

# Stage configuration diagnostics with unavailable defaults (AII-1570)

Manual: requires an admin session and a disposable orchestrator because this changes global defaults.

## Steps

1. Save the existing orchestrator defaults and a test project's stage configuration using the authenticated admin API.
2. Configure valid flat defaults for all three stages, using an active account profile.
3. Opt the test project in with `PUT /api/mappings/:key/agent-config`, supplying `{"enabled":true,"stages":{"planning":{"model":"test-model"}}}`.
4. Save `{"mode":"legacy"}` through `PUT /api/agent-defaults`.
5. Read `GET /api/mappings/:key/agent-config/resolved`.
6. Restore the original defaults and project configuration.

## Asserts

- The resolved endpoint returns HTTP 200 with `enabled: true`, `mode: "configured"` and `resolved: false`.
- The error code is `resolution_failed` and its message is `project opted into stage configuration but orchestrator defaults are not configured`.
- Each stage has an empty `entries` array and `fallbacksDropped: false`; constructing diagnostics does not throw.
