---
target: orchestrator
auth: admin
timeout_minutes: 30
---

# OpenRouter live key check (AII-1907)

Validates the project test key directly using the OpenRouter key-information endpoint. This check is report-only, needs no per-run operator step,
and uses the project secret `OPENROUTER_TEST_API_KEY` already configured on AII.

## Steps

1. Start an implementation run of project **AII** by adding its configured
   pickup label (normally `AI-Implement`) to a suitable test issue in AII.
   Use a runner containing this hook and wait for a verify pass.
2. Read the **runner log**. While the session machine still exists, call
   `get_session_machine` for that run with `logLines` set to include the verify
   output. Capture the result before the machine is removed.
3. Find the exact result line below. No OpenRouter request should be run from
   the build-agent sandbox; the real evidence comes from this AII run.

## Asserts

- Pass: `openrouter-live-check: pass`.
- A skipped line means the check did not run; it is not evidence of key validity.
- A fail line records a live finding for follow-up under AII-1949 and does not
  fail the pipeline. See [live checks](../../docs/live-checks.md) for all results.
- Logs contain no key, key fragment, request header, response body, or exception text.
