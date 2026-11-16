---
target: orchestrator
auth: admin
timeout_minutes: 15
---

# OpenRouter live agent routes

1. In `/admin#projects`, open AII and ensure Secrets contains
   `OPENROUTER_TEST_API_KEY`. Do not expose its value.
2. Start a project AII run by adding `AI-Implement` to a suitable AII issue.
   Wait for the verify hook after an implement pass.
3. Read the runner log; use `get_session_machine` with `logLines` while the
   machine exists. Find these four passing lines (refusal evidence varies):

   - `openrouter-agent-live-check: claude pass`
   - `openrouter-agent-live-check: codex pass`
   - `openrouter-agent-live-check: claude wrong-key refused as expected (exit <code>): <evidence>`
   - `openrouter-agent-live-check: codex wrong-key refused as expected (exit <code>): <evidence>`

Later passes should print `openrouter-agent-live-check: skipped (ran before in this run)`.
A new run should perform all four calls again. Skips do not prove a live route.
Each call uses an empty temporary directory, the fixed OK prompt and a 120-second
limit. There are four small requests per run, two refused. See
`docs/live-checks.md` for model defaults, overrides and all result lines.
The hook is report-only: record failures as follow-up issues under AII-1949;
they do not fail the implementation run. Do not run this recipe in the offline
build sandbox.
