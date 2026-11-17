---
target: orchestrator
auth: admin
timeout_minutes: 30
---

# OpenRouter agent live check (AII-1953)

Uses AII's configured `OPENROUTER_TEST_API_KEY` through a temporary stored
account and the pinned Codex with the open model
`deepseek/deepseek-v4.1-flash-1017`. No per-run operator step is needed.

## Steps

1. Start an implementation run of project **AII** by adding its configured
   pickup label (normally `AI-Implement`) to a suitable test issue. Use a runner
   containing this hook and wait for a verify pass.
2. Read the **runner log**. While the session machine exists, call
   `get_session_machine` for the run with `logLines` covering verify output.
   Capture the log before the machine is removed.
3. Find both agent-check lines. Subsequent verify passes should report
   `openrouter-agent-live-check: skipped (ran before in this run)`.

## Asserts

- Pass: `openrouter-agent-live-check: codex pass` and
  `openrouter-agent-live-check: codex wrong-key refused as expected (exit <code>): <evidence>`.
  Evidence must show authentication refusal (401/403, unauthorized, invalid API
  key, or authentication failed/required/error). An exit-0 JSON error counts only
  with that evidence; CLI and network failures do not prove key refusal.
- Skips are not evidence of successful model access. Fail lines are report-only
  findings for follow-up under AII-1949; they do not fail the run.
- Logs contain no key, key fragment, or request header.
- Each call sends only the fixed prompt from an empty temporary directory.
  The host is selected by OpenRouter and is not pinned. Cost is one small
  request plus one refused request per run. `OPENROUTER_TEST_MODEL` can override
  the model. See [live checks](../../docs/live-checks.md) for every result line.



## Recorded observations

No actual Codex live result or captured runner-log excerpt is available in
this checkout for either key. The pass and refusal assertions above are expected
outcomes, not observed provider responses.

Live verification remains incomplete. See the shared [evidence status](../../docs/live-checks.md#live-observation-evidence-aii-1949)
for the available source and missing capture requirements. No live failure or
linked fix issue has been established from the available evidence.
