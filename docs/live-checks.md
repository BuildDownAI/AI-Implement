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

## Stored OpenRouter account check

After the key check, the hook runs `npx --no-install tsx
scripts/openrouter-account-live-check.ts`. This is also **report-only**: the
hook exits 0 even if tsx or the script throws. No operator step is needed once
the project test secret is configured.

The check creates a temporary directory in the system temporary directory,
sets a process-local `DEDUP_DB_PATH` and a fresh random `RUNNER_TOKEN_SECRET`,
and performs these steps in order:

1. **create**: the real in-process admin `POST /api/model-accounts` route creates
   `openrouter-live-check`, agent `codex`, provider `openrouter`, auth mode
   `openrouter-api-key`.
2. **store**: the real credential `PUT` route seals the test key in that database.
3. **binding**: verifies the stored `key_bindings` destination is
   `openrouter/openrouter-api-key`. Only the Restate binding call is substituted
   with a local row writer.
4. **list**: the real account list route must report `credentialSet: true`
   without returning the key.
5. **resolve**: the real `resolveModelCredential` reads and decrypts the stored
   credential for the account's revision.
6. **provider**: sends the resolved key to the constant host
   `https://openrouter.ai/api/v1/key` using GET and Bearer authentication, no body,
   manual redirects, and a 20-second timeout. It sends no other application data.

It stops on the first failure, closes SQLite, removes the temporary directory
on success or failure, and restores its process environment. It writes no file
in the workspace. The exported `createAndResolveOpenRouterAccount` helper
performs steps create through resolve and returns the resolved key after cleanup
for the subsequent agent check; use it once in a dedicated process because the
application database module caches its path.

Every result has the prefix `openrouter-account-live-check: `:

| Outcome | Result after the prefix |
| --- | --- |
| Missing or empty key; no steps | `skipped (no key)` |
| Marker exists for this run; no steps | `skipped (ran before in this run)` |
| tsx unavailable | `skipped (tsx not found)` |
| All steps succeed | `pass` |
| Create returns unexpected status | `fail (create: status <code>)` |
| Store returns unexpected status | `fail (store: status <code>)` |
| Binding absent | `fail (binding: missing)` |
| Binding has wrong destination | `fail (binding: mismatch)` |
| Account not marked as having a credential | `fail (list: credential not set)` |
| List includes the key | `fail (list: key in answer)` |
| Resolver fails | `fail (resolve: <failure code>)` |
| Provider returns 401 or 403 | `fail (provider: key refused, status <code>)` |
| Provider returns another non-2xx status, including redirects | `fail (provider: status <code>)` |
| Provider throws or times out | `fail (provider: no answer)` |

Unexpected local exceptions use fixed failure text (status 0 for create/store,
missing binding, credential not set, or `secret_unavailable` for resolve).
Neither exception text, response bodies, headers, nor any part of the key is
printed. Marker files in the system temporary directory contain only a timestamp.
Their names hash the GitHub run ID and attempt, or on Linux the parent pipeline
process's PID/start record and boot ID supplied by the hook. This keeps repeated
verify passes in one pipeline from running the check again, including after a
failed attempt. A new pipeline process gets a fresh identity. When neither
identity is available (for example direct local invocation), deduplication is
omitted so a previous unrelated run cannot suppress a check.

This proves the account code with the real key in a **temporary database**.
It does not create an account on the deployed orchestrator or call the
`KeyBinding` Restate object; Restate tests cover that object. Fail lines are
observations to investigate under AII-1949. The first live result is obtained
from the next AII run after merge; build/unit tests use fake fetch only.
