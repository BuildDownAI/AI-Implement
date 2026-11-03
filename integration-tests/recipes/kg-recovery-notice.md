---
target: orchestrator
auth: admin
timeout_minutes: 15
---

# KG recovery notification survives delivery failures

Manual recipe for an isolated testing orchestrator with KG and a controllable notification webhook.

## Steps

1. Deploy with the KG unavailable until the boot notice reports "KG sidecar not serving".
2. Restore the KG and let the next health check send the recovery notice.
3. Repeat with the webhook accepting a recovery connection but withholding its response.
4. Restore the webhook after recovery delivery attempts finish, then run another health check.

## Asserts

- A normal recovery posts exactly one "✅ KG sidecar serving again" notice.
- A stalled recovery request is aborted within the existing canary deadline per attempt; after three failed attempts the exclusive health handler releases and subsequent checks answer normally.
- Restate suspension or invocation cancellation preserves the pending notice rather than journaling a discard.

Automated coverage: `src/__tests__/kg-sidecar-health.test.ts` bounds both the warning-order wait and the recovery send with injected deadlines; `src/__tests__/restate/kg-sidecar-health.restate.test.ts` covers cancellation, replay, retry exhaustion, and subsequent checks.
