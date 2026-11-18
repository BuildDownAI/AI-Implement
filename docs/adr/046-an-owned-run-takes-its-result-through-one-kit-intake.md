# 046 — An owned run takes its result through one kit intake

Status: accepted

## Context

Consuming a callback token before a best-effort accounting write loses usage when the process crashes. PlanningRun, ImplementationRun, ReviewFixAttempt and KgRefresh already accept optional sanitized usage through the owned-run kit.

## Decision

For every Restate-owned result, the callback checks the credential without consuming it and forwards `toRecordedUsage(body)` to the owning workflow. Token expiry remains the run deadline plus grace. The kit intake journals `record-usage` before resolving the report promise; SQLite accounting is its idempotent projection. The callback never calls `recordUsage` for an owned result.

Planning and implementation forward after their existing outcome and tracker handling, because their finish steps still read that outcome from `dispatch_log`. A persisted `callback_lifecycle_completed_at` marker on the job suppresses those lifecycle effects on retry independently of workflow closure. The callback stamps it after lifecycle handling and before forwarding, including when that forward fails. Terminal rows also suppress lifecycle handling for compatibility. This does not make external provider calls atomic with SQLite: a crash during lifecycle handling can still repeat partial effects. Review-fix retains its separate cycle evidence handling.

Planning, implementation and KG use the dispatch id as the transport idempotency key. Review-fix retains its attempt and body hash key, including sanitized usage. Accepted and duplicate forwards answer 2xx; conflicts answer 409; unavailable or missing forwarding clients answer 503, leaving the token usable.

Legacy results continue consuming their token and writing accounting directly.

## Consequences

A failed forward can be retried without losing usage. Only the workflow owns accounting writes. Old runners may omit usage.

Restate caches the first response for a transport idempotency key regardless of the body. Planning, implementation and KG report handlers therefore return a SHA-256 fingerprint of their accepted JSON payload (recursively sorted object keys, preserved array order). Their ingress clients compare this fingerprint with the submitted payload, including sanitized usage. A changed replay receives 409 even when Restate serves the cached acknowledgement for the dispatch key; no second accounting write occurs. Identical retries retain 2xx. Review-fix uses its existing body-sensitive attempt key so changed usage reaches the workflow's conflict detection. A usage-bearing forward without a fingerprint answers 503 rather than acknowledging an unverifiable cached response; updated workflow handlers must be deployed with the clients.
