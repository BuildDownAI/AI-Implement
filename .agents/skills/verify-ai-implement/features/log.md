# Job history

## Sub-features

List jobs and request a bounded time window.

## How to get to it (user POV)

Use the documented bearer-token API at GET /api/log and append since and until in epoch milliseconds.

## Driving it with verify.py

Run `.agents/skills/verify-ai-implement/verify.py log` from the root after building. Both the full request and ?since=0&until=1 return 200 with empty arrays. Inspect http.jsonl in the printed evidence directory.

## Gotchas

Verifying inclusion or exclusion of a particular job requires seeded jobs. The empty-state journey cannot establish filter correctness.
