---
target: orchestrator
auth: none
timeout_minutes: 10
---

# Project account overrides must resolve (AII-1884)

Manual: requires an admin session and a configured test project whose workflow sync is ready. Use test profiles and restore the original configuration afterward.

## Steps

1. Save a working orchestrator default account for each stage. Record the project's current overrides.
2. Save a planning override with a nonexistent account profile ID through `PUT /api/mappings/:key/agent-config`.
3. Confirm the response is 400 and the project's stored configuration has not changed, even though its default planning account is usable.
4. Save a valid project planning account with matching agent, provider and model, distinct from the default account.
5. Inspect `GET /api/mappings/:key/agent-config/resolved` and confirm the project account is first and the default account follows it.
6. Disable the project planning account and inspect the resolved endpoint again.
7. Restore the profile status and the original project overrides.

## Asserts

- Invalid project accounts are refused at save; usable defaults do not make them valid.
- A valid project account resolves at index zero with the default account retained as a fallback.
- After disabling the project account, the resolved response reports `resolved: false`, retains both diagnostic entries, and reports the project entry's `resolution_failed` reason. It does not select the default account.
