---
target: orchestrator
auth: none
timeout_minutes: 15
---

# Closed Jira issue statuses (AII-2110)

Manual: use disposable Jira issues in a testing mapping and an authenticated operator session for `list_issue_statuses`.

## Steps

1. Create issues matching the mapping JQL and repository field. Set their AI-Implement Status to `PR Ready`, `Planning Failed`, and `Implementation Failed`.
2. Move each issue to a native status in category `done`, then call `list_issue_statuses` for the mapping.
3. Move the `PR Ready` issue to category `indeterminate` and list again. Set its custom field to `Merged`, move it to category `new`, and list again.
4. In Jira's search UI, run the listing JQL against an existing matching native Done issue last updated more than seven days ago.
5. Restore the disposable environment.

## Asserts

- Native Done with `PR Ready` reports `merged`, null phase, and workflow state `PR Ready`.
- Both explicit failure values retain `failed` and their respective planning or implementation phase.
- `PR Ready` with category `indeterminate` reports `pr-ready`; `Merged` with category `new` reports `merged`.
- The search excludes the old Done issue using `((<field> not in ("Merged","Planning Failed","Implementation Failed") AND statusCategory != Done) OR updated >= -7d)`.

Automated coverage: `npx vitest run src/__tests__/providers/jira.test.ts src/__tests__/issue-statuses-contract.test.ts`.
