---
target: orchestrator
auth: admin
timeout_minutes: 10
---

# Roll-up findings retain the strongest severity (AII-1979)

Use a disposable feature-branch roll-up PR with two selected reviewers.

## Steps

1. Arrange for both reviewers to report the same path, line, and finding body, with the first reporting `minor` and the second `medium`.
2. Run a roll-up review and inspect its verdict comment.
3. Repeat with the reviewer severities reversed, then with `blocking` in either position.

## Asserts

- The finding appears once in the verdict's finding list with both reviewer IDs.
- The displayed severity is `medium` for the minor/medium pair and `blocking` whenever either reviewer reports blocking.
- The verdict identifies the reviewed head and explains merge and follow-up child behavior.
