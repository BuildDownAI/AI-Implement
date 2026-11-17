---
target: orchestrator
auth: admin session
timeout_minutes: 5
---

# Malformed filesystem status timestamps (AII-1985)

Manual: use an isolated, paused filesystem test mapping with a writable task
root. Keep it paused so the dispatcher does not change the fixture.

## Steps

1. Create an active markdown task with a title in the test mapping's root.
2. Write its `.state/<teamKey>/<identifier>.json` sidecar with `version: 1`,
   `status: "implementing"`, empty `comments` and `prUrls` arrays, and
   `updatedAt: "invalid"`.
3. With no dispatch log row for that identifier, call `list_issue_statuses`
   through the authenticated MCP tools endpoint.
4. Using the isolated test database fixture, insert a dispatch log row with
   that `issue_identifier` and known finite `dispatched_at` and `completed_at`
   values. Call the tool again.
5. Remove the task, sidecar, and fixture dispatch row.

## Asserts

- Both calls retain the active task with state `implementing`.
- Without a job, `changedAt` is `null`.
- With a job, `changedAt` equals its `completed_at` value.

Successful provider reads are cached for 60 seconds; let the cache expire if
reusing a mapping whose task fixture has changed.
