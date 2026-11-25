---
target: orchestrator
auth: none
timeout_minutes: 15
---

# Complete run steps and model comparison (AII-2099)

Manual: requires an authenticated operator session and a deployed test project.

## Steps

1. Run the same TEST issue with two different model selections. Let one complete with approval; stop the other while nested steps are running.
2. Inspect both runs' steps and open Reports for the same date window.
3. For a stopped non-serve run without invocation records, inspect the unknown-model row.
4. Read `get_fleet_report` through the existing authenticated tool entry point.

## Asserts

- Every final job has no running steps, including nested steps. Completed step details remain visible.
- Reports and the tool return the same model groups, distinct job counts, approval, passes, tokens, reported costs and call failures.
- Repeated calls increase calls but count the job once per model group.
- Approval rate divides approved jobs by all jobs in the group, including stopped jobs.
- Stopped jobs without calls appear as unknown model/agent/provider with zero calls and unknown usage/cost.
- Unknown measurements render as an em dash; measured zero remains zero. No public runner route is added.
