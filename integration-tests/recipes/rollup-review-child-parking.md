---
target: orchestrator
auth: admin
timeout_minutes: 10
---

# Closed roll-up children leave pickup before dispatch (AII-1865)

Use a disposable tracker parent and feature-branch roll-up PR in a test project.

## Steps

1. Let a blocking review-only result create a `[roll-up-review]` child under the parent. Keep the child pickup-ready with no run started (pause the project while preparing the fixture if needed).
2. Close the roll-up PR without merging, then enable polling for the project.
3. Wait for one poll. Confirm the child is parked for a person and has a comment asking for the fix to be re-filed against the base branch.
4. Confirm no planning or implementation run was dispatched for that child in the poll that parked it.
5. Repeat with a planning-ready child and with a merged roll-up whose feature branch has been deleted.

## Asserts

- Both planning and implementation pickup omit the parked child in the same poll.
- The log contains `[roll-up-review] Parked` for the child.
- Subsequent polls do not repeat the handoff comment or dispatch the parked child.
