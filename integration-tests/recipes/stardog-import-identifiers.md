---
target: orchestrator
auth: admin session
timeout_minutes: 30
---

# Stardog import identifiers (AII-2122)

Manual: use a testing orchestrator configured for base-mode KG refresh and a test Stardog database. This refresh replaces that database's imported graph.

## Steps

1. Start a base-mode KG refresh, let ingest finish, and accept its hold if required.
2. With Stardog returning identifiers containing punctuation (for example `builddown-kg:0.2.0` and `a1b2/c3.d4@x+y`), inspect the refresh job's steps and final result.
3. Inspect the recorded baseline after verification completes.

## Asserts

- `stardog-import` succeeds and the run reaches `stardog-wait`.
- The events request succeeds with each identifier percent-encoded as a path segment.
- `stardog-verify` checks the expected triple count and `baseline` records the report's part counts.
- No credentials appear in the job log or error details.

Unsafe response validation and the exact encoded path are covered deterministically by `src/__tests__/stardog-client.test.ts`; this recipe requires a Stardog deployment returning the relevant identifier format.
