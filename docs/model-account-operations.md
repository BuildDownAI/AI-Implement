# Model account operations

Operator procedures for hosted model accounts. The command is `src/model-account-cli.ts`, run on the orchestrator
machine as `node dist/model-account-cli.js <command> --profile <id>`.

## Add an account profile

On Models & providers an admin adds a profile with the form (`POST /api/model-accounts`). Add the profile first, then set its key or connect its plan account ([API credentials](#api-credentials), [ChatGPT plan accounts](#chatgpt-plan-accounts)). The form has six fields:

| Field | Meaning |
|---|---|
| Profile ID | The profile's name. Use lowercase letters, digits, `.`, `_` or `-`. The create route also accepts uppercase, but the fallback API-key reference `model-account:<profileId>` is lowercase-only (`MODEL_ACCOUNT_REF_PATTERN`, `src/model-credentials.ts`), so a mixed-case id cannot take a key unless the profile has its own `credentialRef` |
| Identity | A label for the account behind the profile |
| Agent | `claude` or `codex` |
| Provider | `anthropic`, `openai` or `bedrock` |
| Authentication | `anthropic-api-key`, `openai-api-key`, `codex-subscription`, `claude-subscription` or `bedrock` |
| Permitted projects | Which projects may use the profile (below) |

- **Permitted projects.** Three cases, stored in `allowedProjectKeys`:
  - **Blank in the form = every project.** The form sends `["*"]` (`mpAddAccount`, `src/admin-ui/pages/models-and-providers.ts`). `*` is `ALL_PROJECTS_KEY`, and `isProjectPermitted` (`src/agent-config.ts`) accepts a project when the list holds its key or `*`.
  - **A comma-separated list of keys = only those projects.**
  - **An emptied list = no project.** An empty list never widens to all projects: it matches neither the key nor `*`. It is how to revoke a profile, and only `PATCH` can set it on an existing profile. The form cannot send one, but a plain `POST` that omits `allowedProjectKeys` also stores `[]` (a revoked profile), so a blank field is form behaviour only. Scripts that call the API must send `["*"]` for every project.
- **Readiness probe.** Credential readiness is project-scoped (`accountStatus`, `src/admin.ts`). A `*` profile is probed against a mapped project (no mappings, no probe), a listed profile against its first key. An empty list reads `unknown`, which is not a credential fault.
- **Every stage needs a profile.** A project that opts into configured runs needs a usable, permitted profile for each of planning, implementation and review (`STAGE_NAMES` loop in `resolveStageAgentConfig`, `src/agent-config.ts`). A stage with an unknown profile, or one the project may not use, throws. A project that wants Codex only for review must still give planning and implementation a profile.
- **Editing permitted projects.** Use `PATCH /api/model-accounts/:id` with the full `allowedProjectKeys` list; there is no UI for it yet. A disabled or archived profile cannot gain new grants (409 `profile_not_active`); grants can only be removed or kept.

## ChatGPT plan accounts

A `codex-subscription` profile uses a ChatGPT plan record. The profile must exist and be active. Following OpenAI's
self-hosted VM procedure, you sign in on a laptop and copy the record to the orchestrator over SSH. The orchestrator
keeps its own host id and owns all later refreshes.

### 1. Sign in on a laptop

```bash
node dist/chatgpt-plan-login.js login --record ./chatgpt-plan.json
```

The browser opens OpenAI's sign-in. The record is saved to the path you gave.

### 2. Copy the record and import it

The record goes over stdin, never argv. The command refuses a record on the command line.

```bash
fly ssh console -a <orchestrator-app> -C "node dist/model-account-cli.js chatgpt-import --profile <id>" < ./chatgpt-plan.json
```

Import validates the record (shape and the `chatgpt.tokens.use.direct` scope), replaces `extAgentHostId` with the
orchestrator's host id (the `settings` row `chatgpt_plan_host_id`, created on first use; a host id in the file is
ignored), stores it encrypted, and requests one refresh. It writes nothing when the profile is unknown, not
`codex-subscription`, or not active. Delete the laptop file afterwards.

The session key derives from `RUNNER_TOKEN_SECRET`. If it is unset, import exits non-zero and names the variable.
**Rotating `RUNNER_TOKEN_SECRET` makes stored records unreadable: sign in again and import again.**

### 2b. Or connect with a pairing code (AII-1501)

Instead of steps 1 and 2, an admin can open Models & providers, press **Connect ChatGPT plan** on the `codex-subscription` row, and run the command it shows on the laptop (`node dist/chatgpt-plan-login.js connect --orchestrator https://<host> --record <path>`). The helper asks for the code without echo (a terminal is required; the code never goes in argv), signs in, uploads the record, and removes the laptop's tokens **without revoking them**. Revoking would kill the orchestrator's copy, and tokens kept on the laptop would be refreshed there, so the orchestrator would see a reused refresh token and report `reauth_required`. `clientId`, `extAgentHostId` and `host-id` stay, so the next `login` reauthorizes the same client. `--orchestrator` must be `https://` (`http://` only for `localhost`).

- **Mint.** `POST /api/model-accounts/:id/chatgpt-pairing` (admin-only, needs an active `codex-subscription` profile and `RUNNER_TOKEN_SECRET`) returns `{ code, expiresAt, command }` once. The table `chatgpt_pairing_codes` keeps the SHA-256 hash, profile id, expiry (15 minutes), and used time. Minting again invalidates that profile's unused codes.
- **Upload.** `POST /api/chatgpt-pairing/upload` takes `Authorization: Bearer <code>` and the record JSON (64 KB limit). It sits outside the admin session gate; the code is its only authentication. The code is marked used in the lookup statement, before the body is read or the import runs, so **any refused upload (bad JSON, failed validation, wrong profile state, oversize) spends the code** and the operator mints another. Unknown, expired, used and superseded codes all get the same 401. At upload time the profile must still be active and `codex-subscription`. The import is the same function `chatgpt-import` uses, and the response carries only the `chatgpt-status` fields: `email`, `secondsLeft`, `lastRefresh`. If the refresh request fails, the record is still stored and `lastRefresh` is `not requested`.
- **If the response is lost** after a successful upload, the laptop still holds tokens the orchestrator now owns. Run `logout` on the laptop or delete the record file; do not refresh it.
- **Status.** `GET /api/model-accounts/:id/chatgpt-status` (admin-only) returns `{ connected, email, secondsLeft, lastRefresh }` and never a token; a store failure answers 500 with a fixed error.
- Sign-out stays on the CLI (`chatgpt-logout`).

### 3. Check status

```bash
fly ssh console -a <orchestrator-app> -C "node dist/model-account-cli.js chatgpt-status --profile <id>"
```

Prints email, subject, the first 10 characters of the client id, host id, seconds left on the access token, and the
refresher's last outcome. It never prints a token.

Admins can read the same state over HTTP: `GET /api/model-accounts/:id/chatgpt-status` (admin-only) returns `{ connected, email, secondsLeft, lastRefresh }`, never a token.

### 4. Sign out

```bash
fly ssh console -a <orchestrator-app> -C "node dist/model-account-cli.js chatgpt-logout --profile <id>"
```

Revokes the refresh token at OpenAI's `revocation_endpoint`, then stores a record without tokens. The tokens are
removed whether or not revocation succeeds; the output says `revocation confirmed` or `revocation not confirmed`.

Sign-out and status also work on a disabled or archived profile, so you can revoke the session of a retired account. Import requires an active profile.

If it was not confirmed, disconnect the app in ChatGPT settings.

### `reauth_required`

The refresher reports `reauth_required` when OpenAI rejects the refresh token (revoked, reused, or expired), the stored
record is corrupt, or it was sealed under another `RUNNER_TOKEN_SECRET`. Nothing can recover it on the orchestrator:
sign in again on the laptop (step 1), then import again (step 2).

## Hosted-run dependencies

`src/model-auth-runtime.ts` composes the dependencies a hosted (configured) run needs. Three facts matter to an operator:

- **Protection key.** The Fly protection key is derived, not a new secret: HKDF-SHA256 over `RUNNER_TOKEN_SECRET`, salt `ai-implement`, info `ai-implement/model-auth-protection-key/v1`, 32 bytes (`deriveModelAuthProtectionKey`, `src/model-session-keys.ts`). The info label differs from the hosted session key's (`ai-implement/model-session-key/v1`), as ADR 009 requires, so the two keys are never equal. It travels base64url-encoded. With `RUNNER_TOKEN_SECRET` unset there is no key. Rotating the secret changes both keys.
- **API-key and Bedrock profiles resolve from encrypted storage.** `src/model-protected-secrets.ts` stores each credential in `model_protected_secrets`, sealed with AES-256-GCM under a key derived by HKDF from `RUNNER_TOKEN_SECRET` (info `ai-implement/model-protected-secret-key/v1`, distinct from the session and protection labels) and bound to the exact `model-account:` reference as authenticated data. A permitted profile whose reference has a stored row prepares as `ready`. A missing key, row or reference, a malformed value, a bad tag, a changed `RUNNER_TOKEN_SECRET` or a swapped reference is unavailable: the profile prepares as `authentication-required`, with a fixed failure code and no value in errors. There is never an ambient fallback key. Rotating `RUNNER_TOKEN_SECRET` requires re-importing the credentials. Import and delete are described in [API credentials](#api-credentials).
- **Scope of this slice.** Only `codex-subscription` and API-key profiles prepare. No `claude-subscription` account is reserved. A repo image override (`.ai-implement/image.yml`) is refused on Fly. No new environment variable is involved.

## API credentials

Import and remove API-key and Bedrock credentials with `secret-import` and `secret-delete` (AII-1422). The value enters only through stdin, never argv. Output is the reference and a fixed result (`ref=model-account:<name> secret-import ok`); failures print fixed text and never a value. Browser entry also exists (AII-1500): on Models & providers an admin can add a profile and, for `openai-api-key` and `anthropic-api-key` profiles, set or remove a write-only key. It uses `PUT` / `DELETE /api/model-accounts/:id/credential` with body `{ "apiKey": "..." }`, writes through the same store as `secret-import`, uses the profile's `credentialRef` or else `model-account:<profileId>` (saved as a new revision), and answers `{ ref, result }` only. When the profile has no `credentialRef` and another profile already uses the fallback reference, `PUT` answers 409 and writes nothing, and `DELETE` is a no-op success. A failed revision save restores a row that existed before the request. `bedrock` is refused with 400, a profile id that does not fit the reference pattern is refused rather than transformed, and 503 means `RUNNER_TOKEN_SECRET` is unset. `GET /api/model-accounts` reports `credentialSet` and `credentialUpdatedAt`, never the reference or value.

- **Import.** Over Fly SSH, pipe the value in. An API key is the whole of stdin; one trailing newline is dropped and nothing else is trimmed:

  ```bash
  printf '%s' "$KEY" | fly ssh console -a <orchestrator-app> -C "node dist/model-account-cli.js secret-import --ref model-account:team-key"
  ```

  A Bedrock credential is a JSON object on stdin with `region`, `accessKeyId`, `secretAccessKey` and optional `sessionToken`. Stdin that parses as a JSON object is always read as a bundle, so an API key that is itself JSON object text cannot be imported. The reference must match `model-account:` followed by lowercase letters, digits, `.`, `_` or `-`. A bad reference or value, or an unset `RUNNER_TOKEN_SECRET`, fails before anything is written.
- **Replace.** Importing again to the same reference overwrites the stored value.
- **Delete.** `node dist/model-account-cli.js secret-delete --ref model-account:team-key` removes the row and succeeds when none exists. Afterwards the profile prepares as `authentication-required`.
- **Backup and restore.** Rows are sealed under a key derived from the current `RUNNER_TOKEN_SECRET` and bound to their reference. A restored database works only under the same secret, and a row copied to another reference fails authentication.
- **Rotation.** Rotating `RUNNER_TOKEN_SECRET` orphans every stored credential. Re-import each one after the rotation.

### API keys and Codex stages

An `openai-api-key` profile works for every Codex stage, including review and planning, which run `codex app-server`. The invocation env carries the key as `CODEX_API_KEY`. `codex exec` reads that variable directly. The app-server path has no `auth.json`, and its built-in `openai` provider does not read the variable, so the executor selects a provider named `openai_api_key` whose `env_key` is `CODEX_API_KEY` (`base_url` is `OPENAI_BASE_URL` when the invocation sets an allowed one, else `https://api.openai.com/v1`). The provider is chosen the same way in the view's `config.toml`, the argv and the thread request. `CODEX_API_KEY` stays in the shell-environment exclusion list, so the Codex process has the key and the commands the model runs do not. A run without `CODEX_API_KEY` in its env keeps the built-in provider.

## Check which profile a run used

Open the run's GitHub Actions log (the `implement` or `plan` job, step `Run pipeline` or `Run planning`) and search for `[model-auth]`. `src/run-autonomous.ts` prints one line per credential checkout and finish:

```
[model-auth] {"operation":"checkout","profileId":"anthropic-aii","status":"ok"}
[model-auth] {"operation":"checkout","stage":"review","profileId":"openai-codex","status":"ok"}
[model-auth] {"operation":"finish","stage":"review","profileId":"openai-codex","status":"ok"}
```

Each line is one JSON object:

- `operation` is `checkout` or `finish`. A `checkpoint` line can also appear.
- `profileId` is the account profile the credential came from. Compare it with the profile you configured for the stage (see [Add an account profile](#add-an-account-profile)). The log shows the id, not the provider or identity behind it.
- `status` is `ok` or `failed`. A `failed` line also carries a `category`.
- `stage` appears only when exactly one stage's grant uses that profile, so a profile that serves several stages prints none (the `anthropic-aii` line above).

`status: "ok"` on `checkout` means the credential reached the runner. It does not prove the provider accepted the key: a provider error, for example `401 Unauthorized`, appears later in the same log.

`[model-auth] finish failed: <category>` and `[model-auth] dispose failed: <category>` report a failure to return the credential. They print a category, never a value.

These lines appear only for hosted credentials, so an empty search does not mean no profile was used.

## Claude subscription accounts

To be filled by [AII-963](https://linear.app/eudoxus/issue/AII-963/provision-accounts-and-recover-held-subscription-sessions).
