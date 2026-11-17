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
| Good key, exit 0, successful terminal event, answer contains OK | `pass` |
| Good key, exit 0, terminal error | `fail (terminal error): <evidence>` |
| Good key, exit 0, no terminal event | `fail (no successful terminal event)` |
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

Run A (AII-1970, project AII): Fly app `ai-implement-testing-sessions`,
machine `84eee57cd13318`, region `iad`, on 2026-11-17. Tested revision:
`dceffd4a3177f71366850701cf14b74ea46a8768` (historical AII-1949
feature-branch revision, before the terminal-status fixes in PR #1677).
Pinned Codex: `0.159.2`
(`CODEX_CLI_VERSION` in `Dockerfile.session`); model:
`deepseek/deepseek-v4.1-flash-1017`.

| Check | Run A observed result (UTC, 2026-11-17) | Evidence identity |
| --- | --- | --- |
| Key (AII-1907) | 04:43:41 — `openrouter-live-check: pass` | `ai-implement-testing-sessions` / `84eee57cd13318` |
| Stored account (AII-1952) | 04:43:44 — `openrouter-account-live-check: pass` | Same Run A; temporary database |
| Codex, good key (AII-1953) | 04:43:46 — `openrouter-agent-live-check: codex pass` | Same Run A; pinned Codex and model above |
| Codex, wrong key (AII-1953) | 04:43:53 — `refused as expected (exit 1)` with HTTP 401 | Same Run A; exact authentication evidence below |
| Second verify pass | 04:53:17 account and 04:53:26 agent — `skipped (ran before in this run)` | Same Run A; deduplication evidence |

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
