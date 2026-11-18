---
target: orchestrator
auth: none
timeout_minutes: 10
---

# Gap-fill admission refusals stop after three ticks (AII-1981)

Use a sandbox mapped PR and its tracker issue. Inspect the orchestrator database
read-only; create fixture admissions and queue items through the test harness.

## Steps

1. Enqueue an automatic roll-up review for the PR with its issue already parked.
2. Invoke four drain ticks explicitly, inspecting the queue row after each tick.
3. Repeat with a fresh automatic row, an unparked issue, and a released PR
   admission that exhausted the configured PR dispatch budget.
4. Repeat with an in-flight dispatch-log row for the issue.

## Asserts

- Parked and budget-exhausted rows count one refusal per tick, become `skipped`
  on the third tick, and remain unchanged on the fourth. No ImplementationRun
  is submitted. The last reason is `parked` or `budget_exhausted` respectively,
  and the log includes that reason and `3/3, skipped`.
- Budget exhaustion parks the issue and posts one budget notice. The park does
  not prevent subsequent refusals from being counted.
- In-flight work remains pending without consuming refusals until it ends.
