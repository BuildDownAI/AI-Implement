---
target: orchestrator
auth: user
timeout_minutes: 5
---

# Spotter source read errors (AII-1976)

Manual: use an isolated test orchestrator with one mapped repository and tracker, an allowlisted user, and access to Restate invocation details. Use fresh source caches (restart the test orchestrator or wait for cache expiry).

## Steps

1. With valid source credentials, call `list_open_pulls` and `list_issue_statuses` through MCP. Confirm each returns a top-level JSON array.
2. Make the test repository unreadable to its GitHub installation, clear the source cache, and call `list_open_pulls` again.
3. Restore GitHub access. Make the test tracker credential invalid, clear the source cache, and call `list_issue_statuses` again.
4. Inspect both failed calls in Restate and restore the tracker credential.

## Asserts

- Each failed call returns `isError: true`, naming the tool and the source failure, rather than an empty or partial successful array.
- Each failed source-read step has one attempt and its invocation completes; it does not continue retrying after the caller leaves.
- Successful reads remain available to the allowlisted user.
