---
target: orchestrator
auth: none
timeout_minutes: 15
---

# Linear merge cleanup preserves terminal states (AII-330)

Manual: requires an operator's Linear and GitHub access and a sandbox project with merge reconciliation enabled.

## Steps

1. Use a sandbox Linear issue linked to an open implementation PR. Apply `Ready for Review` and `Plan-Complete`, plus an unrelated label such as `bug`.
2. Move the issue to Done before merging the PR, then merge the PR. Allow merge reconciliation to process it.
3. Repeat with a second issue moved to a canceled state before its PR merges.
4. Repeat with a third issue still In Progress when its PR merges.

## Asserts

- Both terminal issues lose `Ready for Review` and `Plan-Complete`, retain `bug`, and keep their original states.
- The active issue moves to the team's completed state (preferring Done), loses both cleanup labels, and retains `bug`.
- A subsequent reconciliation leaves the cleaned terminal issues unchanged.

Use disposable sandbox issues and PRs; no historical label backfill is part of this check.
