---
target: orchestrator
auth: admin session and user MCP access
timeout_minutes: 5
---

# Spotter paused auto-merge (PR #1686)

Manual: use an isolated test orchestrator with an auto-merge-enabled mapping that
is paused and a nondraft child PR targeting a nondefault grouping branch. Its
latest finished implementation job must have a `runner_approved` conclusion,
with no running jobs, review queues, late reviews, parks, or exhausted PR budget.

## Steps

1. Call `list_open_pulls` through MCP as an allowlisted user.
2. Confirm the child appears with `workflow: { state: "settled", reason: "completed" }`.
3. Resume the mapping in the admin UI and call `list_open_pulls` again before
   the next auto-merge tick, while the PR remains open.

## Asserts

- Pausing does not hide the PR, and the paused child is not `auto-merge-pending`.
- After resuming, the child is `active` with reason `auto-merge-pending`.
- Mapping changes affect workflow even when the GitHub source cache is warm.
