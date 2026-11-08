---
target: orchestrator
auth: admin
timeout_minutes: 10
---

# Settings runner backend source (AII-1748)

Use a browser on a test instance. Mock `GET /api/settings` responses in the browser's request interception tool, retaining the other response fields. No settings writes are needed.

## Steps

1. Sign in and open `/admin#settings`.
2. For each row below, override `runnerBackendSource` and `flySessionsApp.runtimeValue` in the settings response, then reload the page.
3. Check `#settings-sessions-app-source.textContent` equals the expected text exactly.

## Asserts

| runnerBackendSource | flySessionsApp.runtimeValue | Expected text |
| --- | --- | --- |
| `not-loaded` | `sessions-test` | Restate has not answered yet |
| `not-loaded` | `null` | Restate has not answered yet |
| `restate` | `sessions-test` | Active: sessions-test (source: restate) |
| `restate` | `null` | Not configured — add a sessions app name to enable Fly dispatch |
