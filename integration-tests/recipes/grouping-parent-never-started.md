---
target: orchestrator
auth: none
timeout_minutes: 15
---

# Never-started grouping parents fail instead of merging (AII-1922)

Manual lifecycle check on a sandbox project using Restate implementation runs and Fly Machines. Requires operator access to the sandbox tracker and Fly sessions app.

## Steps

1. Dispatch a sandbox grouping parent with no PR. Before its runner starts or reports a callback, destroy its Fly machine. Retain the machine event evidence that it never started.
2. Allow the implementation workflow's finish step to process the ended machine.
3. Inspect the dispatch row and sandbox parent issue. Expect status `failed`, conclusion `fly_machine_never_started`, and failure finalization. The parent must not be marked merged or Done by no-work finalization.
4. Retry the finish step against the persisted failed row. Expect the same failure conclusion and no no-work finalization.
5. As a control, let a grouping parent start and report a legitimate no-work result. Expect the existing no-work completion behavior.

## Asserts

The dispatch row preserves `failed` / `fly_machine_never_started` across retry, and the never-started parent remains unmerged. The control completes as no-work.

Automated decision-path coverage: `npx vitest run src/__tests__/implementation-run-finish.test.ts`.
