---
target: orchestrator
auth: admin
timeout_minutes: 30
---

# Codex capacity failures show the terminal error

Manual recipe; requires a testing deployment with a Codex runner and a model currently returning capacity errors. Do not induce provider load to create this condition.

## Steps

1. Dispatch a test implementation using the affected model and record its dispatch id.
2. Confirm the runner log reports `Selected model is at capacity. Please try a different model.` with a non-zero exit, even if stderr also contains the PATH-alias warning.
3. Inspect the dispatch failure record and retry attempts. If capacity persists through the retry budget, inspect the tracker comment and configured Slack completion notification.

## Asserts

- The attempt failure is `transient/PROVIDER_OVERLOADED`, retryable, with the capacity error as its message.
- Existing request/stage retry policy applies (request retries may be skipped after tool use).
- Completion evidence shows the terminal capacity error rather than the PATH-alias warning.

Automated regressions: `src/__tests__/failure-classification.test.ts` and `src/__tests__/completion-classification.test.ts`.
