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
