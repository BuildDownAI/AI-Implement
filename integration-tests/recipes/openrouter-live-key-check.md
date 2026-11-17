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

## Recorded observations

Run A (AII-1970, project AII): Fly app `ai-implement-testing-sessions`,
machine `84eee57cd13318`, region `iad`, on 2026-11-17. Tested revision:
`dceffd4a3177f71366850701cf14b74ea46a8768` (AII-1949 feature-branch head
under roll-up review in PR #1677). Pinned Codex: `0.159.2`
(`CODEX_CLI_VERSION` in `Dockerfile.session`); model:
`deepseek/deepseek-v4.1-flash-1017`.

The operator read these results from the Fly runner logs. Fly logs are not
retained, so there is no runner-log link; the app, machine ID, and UTC timestamps
identify the run. This is operator-supplied live evidence, not a sandbox run.

```text
2026-11-17T04:43:41Z openrouter-live-check: pass
2026-11-17T04:43:44Z openrouter-account-live-check: pass
2026-11-17T04:43:46Z openrouter-agent-live-check: codex pass
2026-11-17T04:43:53Z openrouter-agent-live-check: codex wrong-key refused as expected (exit 1): Reconnecting... 1/5 (unexpected status 401 Unauthorized: User not found., url: https://openrouter.ai/api/v1/responses, cf-ray: a5bc13925a41ee37-IAD)
2026-11-17T04:53:17Z openrouter-account-live-check: skipped (ran before in this run)
2026-11-17T04:53:26Z openrouter-agent-live-check: skipped (ran before in this run)
```

The two second-pass skips demonstrate the one-time-per-run rule; the first-pass
pass/refusal lines establish provider access and authentication refusal.
The stored-account result covers a temporary database and a substituted binding
write, not the deployed account database or live Restate.

Run B (AII-1969) independently confirmed the same four outcomes on machine
`48ee5d7b202218`, 2026-11-17 01:29–01:30 UTC. Its wrong-key authentication
refusal had cf-ray `a5baf8bcba5329b5-IAD`. Exact per-result timestamps,
revision, installed-version output, and model metadata for Run B were not
supplied; Run A is the primary evidence record.

The earlier trusted-directory failure and false wrong-key “refused as expected”
were addressed by [AII-1969](https://linear.app/eudoxus/issue/AII-1969)
([PR #1674](https://github.com/BuildDownAI/AI-Implement/pull/1674));
[PR #1672](https://github.com/BuildDownAI/AI-Implement/pull/1672) added
`--skip-git-repo-check`. An unrelated CLI refusal does not establish authentication
refusal. The live evidence requirement is now met for the tested revision;
publication and the subsequent roll-up review remain pipeline-owned.

See the shared [evidence record](../../docs/live-checks.md#live-observation-evidence-aii-1949).
