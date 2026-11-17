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
observations to investigate under AII-1949. Build/unit tests use fake fetch only;
see the evidence status below for live verification.

## OpenRouter agent check

After the account check, the hook runs `npx --no-install tsx
scripts/openrouter-agent-live-check.ts` once per pipeline run, using a separate
system temporary marker with the same run identity described above. It resolves
the test credential with the account helper, then starts two pinned Codex calls:
`codex` uses that credential; `codex wrong-key` uses the fixed invalid key
`sk-or-v1-invalid`. Each starts in a fresh empty temporary directory, with the
shared model environment and OpenRouter provider arguments, a read-only sandbox,
and only `Reply with the one word OK.` on stdin. Each has a 120-second limit;
timeout kills its process group. Temporary working directories are removed.
No source code or issue text is sent and no workspace file is written.
Codex starts outside a git repository on purpose, using `--skip-git-repo-check`.

The default model is `deepseek/deepseek-v4.1-flash-1017`; the optional hook input
`OPENROUTER_TEST_MODEL` overrides it. This is not an orchestrator setting.
OpenRouter selects the model host; the host is **not pinned**. The test key and
fixed prompt go to OpenRouter and its selected host. Cost per run is one small
request and one refused request. No per-run operator step is needed.

The runner log contains the following results. The first three skips produce
one line only, with no Codex call. Otherwise each call prints its own line with
`openrouter-agent-live-check: <call> ` as the prefix, where `<call>` is `codex`
or `codex wrong-key`.

| Outcome | Result |
| --- | --- |
| Missing/empty secret | `openrouter-agent-live-check: skipped (no key)` |
| Already attempted this run | `openrouter-agent-live-check: skipped (ran before in this run)` |
| Account helper failed | `openrouter-agent-live-check: skipped (no test account)` |
| tsx unavailable in hook | `openrouter-agent-live-check: skipped (tsx not found)` |
| Binary missing for a call | `skipped (binary not found)` |
| Either call's error output contains `--skip-git-repo-check` or `Not inside a trusted directory` | `fail (not sent): <evidence>` |
| Good key, exit 0, answer contains OK | `pass` |
| Good key, exit 0, no OK | `fail (no OK in the answer)` |
| Good key, nonzero exit | `fail (exit <code>): <evidence>` |
| Wrong key, nonzero exit or JSON error with authentication refusal | `refused as expected (exit <code>): <evidence>` |
| Wrong key, nonzero exit or JSON error without authentication refusal | `fail (no authentication refusal, exit <code>): <evidence>` |
| Wrong key answers OK | `fail (wrong key was accepted)` |
| Wrong key exits 0 without OK or an error | `fail (no OK in the answer)` |
| Call exceeds 120 seconds | `fail (no answer)` |
| Unexpected spawn failure | `fail (could not start)` |

Authentication evidence must contain HTTP 401/403, unauthorized, invalid API key,
or an authentication failed/required/error message. A CLI or network failure alone
does not prove that the provider refused the key.

Authentication refusal checks inspect both stderr and the Codex JSON error,
and use a matching authentication-error line as evidence for the wrong-key call.
Otherwise evidence is the last nonempty stderr line (or the Codex JSON error
when stderr is empty). Keys and authorization headers are redacted before
cutting to 300 characters. Answer text is read from completed agent-message events,
not a search of raw JSON. This check is **report-only**: outcomes and script
exceptions do not change the hook's exit code of 0. A fail is a live finding for
follow-up under AII-1949. Unit tests use fake processes; they do not establish
provider access. See the evidence status below.

## Live observation evidence (AII-1949)

Completion is **blocked on captured runner-log evidence**. The following records
separate the historical observation supplied in the
[AII-1949 issue](https://linear.app/eudoxus/issue/AII-1949) from results that have
not been observed. Expected result lines in the tables above are specifications,
not execution records.

| Check | Observed result | Evidence available in this checkout |
| --- | --- | --- |
| Key (AII-1907) | The parent issue reports `openrouter-live-check: pass` on 2026-11-14. | Issue report only; no captured runner log or run identifier supplied. Not independently verified here. |
| Stored account (AII-1952) | No live observation available. | No captured runner log supplied. Temporary-account unit tests do not prove provider acceptance. |
| Codex (AII-1953) | No live observation available for either the real-key or wrong-key call. | No captured runner log supplied. Fake-process tests do not prove pinned Codex or model compatibility. |

To close this evidence gap, retain a sanitized runner-log excerpt for each check
and link it here and in its recipe. Include the run identifier, timestamp,
pinned Codex version, selected model, tested revision (the final combined parent
feature-branch SHA), and exact result lines. Record failures
with their actual fix-issue links under AII-1949; a skip or unrelated process
failure cannot establish provider access or authentication refusal. No live
provider defect or linked fix issue can be asserted from the evidence currently
available. This evidence requirement remains unmet; merging code alone does not
satisfy it.

### AII-1970 local verification attempt (blocked)

On 2026-11-17 at 04:44 UTC, `sh scripts/ci/ai-verify.sh` was executed in the
implementation sandbox against revision
`dceffd4a3177f71366850701cf14b74ea46a8768`, using Node `v24.22.3`.
The locally installed binary reported `codex-cli 0.159.2`; no Codex model was
invoked and no authorized AII runner identifier or runner-log link was available.
The hook exited 0 with these exact results:

```text
openrouter-live-check: skipped (no key)
openrouter-account-live-check: skipped (tsx not found)
openrouter-agent-live-check: skipped (tsx not found)
```

`OPENROUTER_TEST_API_KEY` was absent. The hook's tsx probe also failed:
`npx --no-install tsx --version` reported tsx `v4.23.12`, then an `EPERM`
error when opening its IPC socket in this sandbox. Thus “tsx not found” here
does not mean the dependency is absent. These skips establish neither provider
acceptance nor authentication refusal. No live provider defect or fix issue
was established. Completion still requires the authorized runner observations
and sanitized log links above; this local attempt does not close AII-1970.
