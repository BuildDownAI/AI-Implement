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
3. Set the test project configured with `set_project_agent_mode`, supplying `{"teamKey":"<key>","mode":"configured"}` in `args`. Then send `{"stages":{"planning":{"model":"test-model"}}}` to `PUT /api/mappings/:key/agent-config`.
4. Save `{"mode":"legacy"}` through `PUT /api/agent-defaults`.
5. Read `GET /api/mappings/:key/agent-config/resolved`.
6. Restore the original defaults and project configuration.

## Asserts

- The resolved endpoint returns HTTP 200 with `enabled: true`, `mode: "configured"` and `resolved: false`.
- The error code is `resolution_failed` and its message is `project is configured for stage agents but the orchestrator stage defaults are off`.
- Each stage has an empty `entries` array and `fallbacksDropped: false`; constructing diagnostics does not throw.
