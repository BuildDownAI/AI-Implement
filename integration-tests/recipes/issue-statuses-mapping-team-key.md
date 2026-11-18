---
target: orchestrator
auth: admin session
timeout_minutes: 5
---

# Stored mapping team keys in issue statuses (AII-1977)

Manual: use a configured test tracker mapping with working credentials and a
known active issue carrying the configured pickup label.

## Steps

1. Save the test team's mapping through the admin UI and record its team key.
2. Call `list_issue_statuses` through the authenticated MCP tools endpoint.
3. If another test team is configured, repeat with a labeled issue in that team.

## Asserts

- The tool succeeds without a missing-team-key error.
- Each known issue appears with its mapping's `teamKey`, tracker kind, identifier,
  and normalized state.
- Issues from distinct configured teams retain their respective team keys.

Successful tracker reads are cached for 60 seconds; allow that cache to expire
before checking subsequent tracker changes.
