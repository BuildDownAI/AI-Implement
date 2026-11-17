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
supplied; Runs A and B are historical evidence only.

The earlier trusted-directory failure and false wrong-key “refused as expected”
were addressed by [AII-1969](https://linear.app/eudoxus/issue/AII-1969)
([PR #1674](https://github.com/BuildDownAI/AI-Implement/pull/1674));
[PR #1672](https://github.com/BuildDownAI/AI-Implement/pull/1672) added
`--skip-git-repo-check`. An unrelated CLI refusal does not establish authentication
refusal.

**Current revision: live-evidence requirement met by Run C under the operator's
explicit acceptance in AII-1971.** Runs A and B remain historical; Run C records
operator-attested final-code execution with the successful-terminal-event gate
in `CodexStreamParser.terminalStatus`.

This is an issue-specific acceptance of the supplied evidence, not a claim that
Run C satisfies every recipe metadata requirement. The actual `codex --version`
output and separate pipeline run ID remain unavailable; the pinned version is
not a substitute for observed version output. Future runs must still capture
all metadata required by the recipes. Run B has no tested revision or model
metadata and cannot be tied to the terminal-status gate; Run C supplies that
revision and model, plus the operator's explicit final-code attestation. Its
acceptance does not make Run B evidence for the current gate.

Run C (project AII): the review-fix run on
[PR #1677](https://github.com/BuildDownAI/AI-Implement/pull/1677)
([run review](https://linear.app/eudoxus/review/ai-implement-feature-branch-ready-for-review-0edd771067da)),
Fly app `ai-implement-testing-sessions`, machine `8111939a510158`, region `iad`.
Tested revision: `ceaf3986b787923981d4078be87e6db7e3829753`, the
feature-branch head after [PR #1678](https://github.com/BuildDownAI/AI-Implement/pull/1678)
merged, including the terminal-status gate. Pinned Codex: `0.159.2`
(`CODEX_CLI_VERSION` in `Dockerfile.session`); selected model:
`deepseek/deepseek-v4.1-flash-1017`.

The operator supplied these sanitized results on 2026-11-17 after reading the
Fly runner log; this is live runner evidence using the configured project key,
not a sandbox run. The supplied version is the runner's pinned version; a
literal `codex --version` output line and a separate pipeline run ID were not
supplied. The review link, app, machine, and UTC timestamps identify Run C.

```text
2026-11-17T07:02:32Z openrouter-live-check: pass
2026-11-17T07:02:45Z openrouter-account-live-check: pass
2026-11-17T07:03:04Z openrouter-agent-live-check: codex pass
2026-11-17T07:03:16Z openrouter-agent-live-check: codex wrong-key refused as expected (exit 1): Reconnecting... 1/5 (unexpected status 401 Unauthorized: User not found., url: https://openrouter.ai/api/v1/responses, cf-ray: a5bcdfb0ea679d25-IAD)
```

The good-key `codex pass` proves that a real Codex/OpenRouter stream passed the
successful-terminal-event gate. The wrong-key result includes HTTP 401
Unauthorized authentication refusal. All four checks passed; no failure was
seen and no new fix issue is needed. The stored-account check still covers a
temporary database and substituted binding writer, not the deployed account
database or live Restate.

The operator reports that only these four documentation files changed between
Run C's tested revision and `eaf5a25a`; no script or test changed. The requested
`git diff --stat ceaf3986 eaf5a25a` comparison could not be independently
repeated in this shallow checkout because `ceaf3986` is absent and `.git` is
read-only. Run C is the operator-attested evidence for the final runtime code.

This run's pipeline also executes the verify hook on its own head. Any differing
results must be recorded alongside Run C; no results from that later hook are
available in this evidence update. Skips and repeated verify passes are not
replacement live evidence because per-run markers suppress repeat account and
agent calls. Publication, merge into the parent's feature branch, and renewed
roll-up review remain pipeline-owned.

See the shared [evidence record](../../docs/live-checks.md#live-observation-evidence-aii-1949).
