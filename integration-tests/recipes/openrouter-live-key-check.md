---
target: orchestrator
auth: admin
timeout_minutes: 15
---

# OpenRouter live stored-key check

1. In `/admin#projects`, open AII and ensure Secrets contains
   `OPENROUTER_TEST_API_KEY` (never copy its value into a log or issue).
2. Start a run of project AII by adding its pickup label `AI-Implement` to a
   suitable AII issue. Wait for an implement pass to reach the verify hook.
3. Read the runner log. While the machine exists, use `get_session_machine`
   with `logLines` to retrieve the log and find `openrouter-live-check:`.

Pass: `openrouter-live-check: pass`. The key check may repeat after each pass.
A skip is not proof of live authentication. Any fail line records the provider
or connectivity result for follow-up; this check is report-only and exits 0.
No generation request is made by this recipe's key check.
