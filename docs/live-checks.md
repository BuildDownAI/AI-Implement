# Live checks

The repository's `verify: scripts/ci/ai-verify.sh` hook runs
`scripts/openrouter-live-check.mjs` with Node after each implement pass. One run
can check more than once. It makes one token-free `GET` request to
`https://openrouter.ai/api/v1/key`, the OpenRouter
[key-information endpoint](https://openrouter.ai/docs/api/api-reference/api-keys/get-current-key),
using Bearer authentication. It sends only the test key, with no body, source
code, or issue text, and does not follow redirects or write files.

On `/admin#projects`, open project **AII**, then **Secrets**, and add
`OPENROUTER_TEST_API_KEY` with the key as its value. Do not use
`OPENROUTER_API_KEY`, put the key in Extra Env, or record it in an issue, comment,
or repository file. On Fly, the orchestrator stores it as
`AII_OPENROUTER_TEST_API_KEY` on the sessions app
`ai-implement-testing-sessions`; the next run's hook receives the bare name.
The orchestrator lists it in `AI_IMPLEMENT_FORWARDED_SECRETS` so that it is
removed from the model process environment. See [deployment](deployment.md#per-project-secrets-fly).

The result appears as one `openrouter-live-check: …` line in the **runner log**:

| Outcome | Result line |
| --- | --- |
| Absent or empty key (no request) | `openrouter-live-check: skipped (no key)` |
| HTTP 2xx | `openrouter-live-check: pass` |
| HTTP 401 or 403 | `openrouter-live-check: fail (key refused, status <code>)` |
| Another HTTP status | `openrouter-live-check: fail (status <code>)` |
| Network error or no answer within 20 seconds | `openrouter-live-check: fail (no answer)` |

The check is **report-only**: all these outcomes exit 0, so an OpenRouter failure
does not fail an unrelated issue run. It does not print response bodies,
exceptions, keys, or headers. Remove the project secret to return to skipping.
This is a key check, not a generation integration test.

If project AII runs on GitHub Actions (runner mode `gha` or a changed project
execution mode), its Fly project secret does not reach the run and the check
skips. The GitHub Actions forwarding rail is the repository Actions secret
`AI_IMPLEMENT_FORWARDED_ENV`, containing a `OPENROUTER_TEST_API_KEY=VALUE` line.
Set the value there through GitHub's secret UI, never in a repository file.

## Agent route check

After the key check, the hook uses `npx --no-install tsx` to run
`scripts/openrouter-agent-live-check.ts`. Once per pipeline run it makes four
small requests: `claude`, `codex`, `claude wrong-key`, and `codex wrong-key`.
The first two use the test secret; the last two use `sk-or-v1-invalid` and should
be refused. Cost is four small requests per run, two of them refused.

Each invocation starts in its own empty system temporary directory and receives
only `Reply with the one word OK.` on stdin. No source code or issue text is
sent. Claude uses the shared invocation environment and print mode; Codex uses
the shared environment and provider arguments with a read-only sandbox.
The default models are `anthropic/claude-haiku-5.5` and
`openai/gpt-5.1-codex-mini`. Optional hook inputs
`OPENROUTER_TEST_CLAUDE_MODEL` and `OPENROUTER_TEST_CODEX_MODEL` replace them.

Each call prints `openrouter-agent-live-check: <call> <result>` in the runner log:

| Outcome | Result |
| --- | --- |
| Binary absent | `skipped (binary not found)` |
| Good key, exit 0 and answer contains OK | `pass` |
| Good key, exit 0 without OK | `fail (no OK in the answer)` |
| Good key, other exit | `fail (exit <code>): <evidence>` |
| Wrong key, nonzero exit or error answer | `refused as expected (exit <code>): <evidence>` |
| Wrong key answers OK | `fail (wrong key was accepted)` |
| No end in 120 seconds (process stopped) | `fail (no answer)` |

A wrong key with no error and no OK is also `fail (no OK in the answer)`.
Evidence is the last nonempty error line, redacted before being limited to 300
characters; structured stdout errors supply evidence when stderr is empty.
Keys and authentication headers are never printed.

Without a key there is just `openrouter-agent-live-check: skipped (no key)`.
A temporary marker makes later passes print only
`openrouter-agent-live-check: skipped (ran before in this run)`.
The marker hashes the per-run session token (or runner token, GitHub run/attempt,
or dispatch envelope when available);
local invocations fall back to the hook's parent process identity. Markers are
outside the workspace and persist for the runner's temporary-directory lifetime.
Without the local tsx launcher the hook prints
`openrouter-agent-live-check: skipped (tsx not found)`.
The check is **report-only**, including unexpected script errors: the hook exits
0. A live failure is evidence for a follow-up issue under AII-1949. Unit tests
use fake processes; the first real result is from an AII run after merge.
