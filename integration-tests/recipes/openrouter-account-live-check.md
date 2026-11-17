---
target: orchestrator
auth: admin
timeout_minutes: 30
---

# OpenRouter stored account live check (AII-1952)

Creates an account through the real admin routes in a temporary database, seals the project test key, checks its binding and safe list projection, resolves it, and validates the resolved key with OpenRouter. It does not use the deployed orchestrator database or the KeyBinding Restate object. This check is report-only, needs no per-run operator step,
and uses the project secret `OPENROUTER_TEST_API_KEY` already configured on AII.

## Steps

1. Start an implementation run of project **AII** by adding its configured
   pickup label (normally `AI-Implement`) to a suitable test issue in AII.
   Use a runner containing this hook and wait for a verify pass.
2. Read the **runner log**. While the session machine still exists, call
   `get_session_machine` for that run with `logLines` set to include the verify
   output. Capture the result before the machine is removed.
   Retain a sanitized log link, run identifier, UTC timestamp, tested revision
   (the final combined parent feature-branch SHA), actual `codex --version`,
   selected model, and exact result lines in the shared evidence section and
   this recipe. Record any observed failure with its actual fix-issue link.
3. Find the exact result line below. No OpenRouter request should be run from
   the build-agent sandbox; the real evidence comes from this AII run.

## Asserts

- Pass: `openrouter-account-live-check: pass`.
- A skipped line means the check did not run; it is not evidence of key validity.
- A fail line records a live finding for follow-up under AII-1949 and does not
  fail the pipeline. See [live checks](../../docs/live-checks.md) for all results.
- Logs contain no key, key fragment, request header, response body, or exception text.

## Recorded observations

Run A (AII-1970, project AII): Fly app `ai-implement-testing-sessions`,
machine `84eee57cd13318`, region `iad`, on 2026-11-17. Tested revision:
`dceffd4a3177f71366850701cf14b74ea46a8768` (historical AII-1949
feature-branch revision, before the terminal-status fixes in PR #1677).
Pinned Codex: `0.159.2`
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

The two second-pass skips demonstrate the one-time-per-run rule at that
revision; the first-pass pass/refusal lines establish historical provider access
and authentication refusal. The good-key pass used exit code and OK text only;
it did not inspect `CodexStreamParser.terminalStatus`. It therefore does not
verify the current successful-terminal-event requirement.
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
refusal.

**Current revision: live verification pending.** Run A predates commits
`97daf4f8` and `656f0bf0`, which added the good-key terminal-status gate.
Neither Run A nor Run B establishes that a real successful Codex/OpenRouter
stream passes that gate. The AII-1949 live-evidence requirement remains unmet
for the revision under review; unit tests with synthetic streams cannot close
this gap.

A fresh AII verify-hook run must exercise the final combined revision with the
project's real `OPENROUTER_TEST_API_KEY`, pinned Codex, and the specified open
model. Retain its tested SHA, actual `codex --version`, selected model, run and
machine identifiers, UTC timestamps, and sanitized result lines for the key,
account, good-key agent, and wrong-key agent checks. The good-key line must be
`openrouter-agent-live-check: codex pass` from the script containing the
terminal-status gate; the wrong-key line must include authentication-refusal
evidence. Record failures and their fix issues rather than treating skips or
historical results as current success. The existing per-run markers suppress
repeat calls, so another verify pass in an already checked run cannot supply
this evidence. Publication and roll-up review remain pipeline-owned.

See the shared [evidence record](../../docs/live-checks.md#live-observation-evidence-aii-1949).
