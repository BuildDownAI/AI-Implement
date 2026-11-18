---
target: orchestrator
auth: admin session
timeout_minutes: 5
---

# Linear duplicate issue statuses (AII-1960)

Manual: use a disposable Linear issue in a test team's configured mapping.

## Steps

1. Give the issue the configured pickup label and the AI-Planning label.
2. Read the mapping's issue statuses through LinearProvider.listIssueStatuses;
   confirm the issue appears as planning.
3. Move the issue to a workflow state whose type is duplicate, retaining its labels.
4. Read the mapping's issue statuses again.

## Asserts

- The duplicate issue is absent from the returned statuses.
- The active GraphQL query excludes completed, canceled, and duplicate state types.
- Duplicate issues returned by either the active or recent query are omitted.
