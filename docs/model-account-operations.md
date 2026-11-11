# Model account operations

A ChatGPT plan profile works on public and private repositories. Claude subscription profiles run managed stages from a stored setup-token resolved through a protected-secret reference, without reserving an account (ADR 049).

Operator procedures for hosted model accounts. The command is `src/model-account-cli.ts`, run on the orchestrator
machine as `node dist/model-account-cli.js <command> --profile <id>`.

## Add an account profile

On Models & providers an admin adds a profile with the form (`POST /api/model-accounts`). Add the profile first, then set its key or connect its plan account ([API credentials](#api-credentials), [ChatGPT plan accounts](#chatgpt-plan-accounts)). The form asks for:

| Field | Meaning |
|---|---|
| Name | A label for the account behind the profile, stored as `identity`. Nothing at run time depends on it, and it can be changed later |
| Agent | `claude` or `codex` |
| Provider | `anthropic`, `openai` or `bedrock` |
| Authentication | `anthropic-api-key`, `openai-api-key`, `codex-subscription`, `claude-subscription` or `bedrock` |

The page makes the profile ID from the Name: lowercase, each run outside `[a-z0-9._-]` replaced by `-`, leading and trailing hyphens removed, then leading punctuation removed so the ID starts with a letter or digit. It cuts the result to 64 characters and uses `account` when nothing is left. When an ID is loaded already, it adds `-2`, `-3`, …, shortening the base so the entire ID stays within 64 characters. If another admin creates the same ID before submission, the form shows the route's error message.

The ID is the profile's key and never changes. A caller of the route itself sends its own `profileId`; use lowercase letters, digits, `.`, `_` or `-`, starting with a letter or digit, because the fallback reference `model-account:<profileId>` is lowercase-only (`MODEL_ACCOUNT_REF_PATTERN`, `src/model-credentials.ts`).

## Edit an account profile

The table reads Name, Agent, Provider, Authentication, Status, Readiness and API key, with the immutable profile ID below the Name. For an admin, **Edit** changes the Name and status (`active`, `disabled` or `archived`); **Save** sends only changed `identity` and `status` fields to `PATCH /api/model-accounts/:id`, and **Cancel** discards the edit. Non-admins have no Edit action or add form. Name, Status, Save and Cancel are disabled while saving; a failed save keeps the draft available to retry. Stage edits, profile drafts and unsubmitted keys survive account refreshes, as do focus on profile editing controls and the Name selection.

The admin-only route may accept `identity`, `agent`, `provider`, `authMode`, `credentialRef` and `status`; any other key is a 400. It copies the current head, applies the body, and saves a new revision (`handlePatchModelAccount`, `src/admin.ts`). The credential reference is kept unless the body sets `credentialRef` to `null`. The profile ID is the path and cannot change: stage defaults, credential references and run attribution store it. The same validation as create applies (`validateProfileInput`, `src/agent-config-store.ts`).

- **Readiness.** Credential readiness comes from the profile's own credential status (`accountStatus`, `src/admin.ts`), whether or not any project uses it. Every active profile is usable by every project; disable or archive a profile to stop its use.
- **Every stage needs a profile.** A project that opts into configured runs needs a usable profile for each of planning, implementation and review (`STAGE_NAMES` loop in `resolveStageAgentConfig`, `src/agent-config.ts`). A stage with an unknown, disabled or archived profile, or one whose agent or provider does not match the stage, throws. A project that wants Codex only for review must still give planning and implementation a profile.

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
- **API-key, Claude subscription and Bedrock profiles resolve from encrypted storage.** `src/model-protected-secrets.ts` stores each credential in `model_protected_secrets`, sealed with AES-256-GCM under a key derived by HKDF from `RUNNER_TOKEN_SECRET` (info `ai-implement/model-protected-secret-key/v1`, distinct from the session and protection labels) and bound to the exact `model-account:` reference as authenticated data. An active profile whose reference has a stored row prepares as `ready`. A missing key, row or reference, a malformed value, a bad tag, a changed `RUNNER_TOKEN_SECRET` or a swapped reference is unavailable: the profile prepares as `authentication-required`, with a fixed failure code and no value in errors. There is never an ambient fallback key. Rotating `RUNNER_TOKEN_SECRET` requires re-importing the credentials. Import and delete are described in [API credentials](#api-credentials).
- **Scope of this slice.** Claude subscription profiles prepare from stored setup-tokens, Codex subscription profiles from plan records, and API-key and Bedrock profiles from protected secrets. No model account is reserved. A repo image override (`.ai-implement/image.yml`) is refused on Fly. No new environment variable is involved.

## API credentials

Import and remove API-key and Bedrock credentials with `secret-import` and `secret-delete` (AII-1422). The value enters only through stdin, never argv. Output is the reference and a fixed result (`ref=model-account:<name> secret-import ok`); failures print fixed text and never a value. Browser entry also exists (AII-1500): on Models & providers an admin can add a profile and, for `openai-api-key` and `anthropic-api-key` profiles, set or remove a write-only key, or for `claude-subscription` profiles, a write-only setup-token. It uses `PUT` / `DELETE /api/model-accounts/:id/credential` with body `{ "apiKey": "..." }`, writes through the same store as `secret-import`, uses the profile's `credentialRef` or else `model-account:<profileId>` (saved as a new revision), and answers `{ ref, result }` only. When the profile has no `credentialRef` and another profile already uses the fallback reference, `PUT` answers 409 and writes nothing, and `DELETE` is a no-op success. A failed revision save restores a row that existed before the request. `bedrock` is refused with 400, a profile id that does not fit the reference pattern is refused rather than transformed, and 503 means `RUNNER_TOKEN_SECRET` is unset. `GET /api/model-accounts` reports `credentialSet` and `credentialUpdatedAt`, never the reference or value.

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

Open the run's GitHub Actions log (the `implement` or `plan` job, step `Run pipeline` or `Run planning`) and search for `[model-auth]`. `src/run-autonomous.ts` prints one line per credential checkout, checkpoint and finish:

```
[model-auth] {"operation":"checkout","profileId":"anthropic-aii","status":"ok"}
[model-auth] {"operation":"checkout","stage":"review","profileId":"openai-codex","status":"ok"}
[model-auth] {"operation":"finish","stage":"review","profileId":"openai-codex","status":"ok"}
```

Each line is one JSON object:

- `operation` is `checkout`, `checkpoint` or `finish`.
- `profileId` is the account profile the credential came from. Compare it with the profile you configured for the stage (see [Add an account profile](#add-an-account-profile)). The log shows the id, not the provider or identity behind it.
- `status` is `ok` or `failed`. A `failed` line also carries a `category`.
- `stage` names the stage the credential was for, and appears only when exactly one stage binding in the run's grant uses that profile (the `review` lines above). A profile bound to several stages prints no `stage`, because the line cannot say which of them it served (the `anthropic-aii` line above). A line without `stage` therefore does not mean the main stage: to find which stage it served, check the stage bindings of the run's grant for that `profileId`.

`status: "ok"` on `checkout` means the credential reached the runner. It does not prove the provider accepted the key: a provider error, for example `401 Unauthorized`, appears later in the same log.

`[model-auth] finish failed: <category>` means returning one profile's credential failed. `[model-auth] dispose failed: <category>` is logged after every credential was returned, when closing the run's model-auth client fails. They print a category, never a value.

These lines appear only for hosted credentials, so an empty search does not mean no profile was used.

## Claude subscription accounts

[ADR 049](adr/049-claude-subscription-profiles-hold-a-setup-token.md) records the 2026-11-07 operator decision: a managed `claude-subscription` profile holds the long-lived value produced by `claude setup-token`. The orchestrator resolves the stored setup-token through the profile's protected-secret reference. Two runs can share the same profile; neither takes a reservation or reads historical session-store rows.

Import the token on the orchestrator with `node dist/model-account-cli.js secret-import --ref model-account:<name>`. Supply the token value on stdin, never in argv. Use the profile's configured `credentialRef` (for example, `model-account:<name>`); importing a secret does not configure that reference. This uses the existing protected-secret store in `model_protected_secrets`, with the same protection and rotation requirements as [API credentials](#api-credentials).

Admins can set, replace or remove the profile's setup-token using the write-only **Set key** / **Remove key** controls on **Models & providers**. The set/not-set badge reports whether a protected credential is stored; saved tokens are never read back into the field. Readiness requires a configured reference and a stored row; row presence does not prove that the provider accepts the token.

The supported setup-token checkout shape is `{ kind: "claude-oauth-token", token }`, delivered to the runner as `CLAUDE_CODE_OAUTH_TOKEN`. Managed checkout requires no owner generation; setup-tokens need no refresh. Missing secrets, decryption failures and an unset `RUNNER_TOKEN_SECRET` prepare as `authentication-required` with the fixed code `session_unavailable`. Local `local-login` subscription runs retain the `session` kind and `authDir`.

## Adopt an environment credential

The admin tool `import_environment_credential` (no arguments, through MCP or
`POST /api/tools/import_environment_credential` with `{ "args": {} }`) imports the
credential as an ordinary account profile named `Adopted environment credential`.
It does not change stage defaults, project grants, or project opt-ins. Repeating
the import returns `already-imported` without writing.

To also configure stage defaults, run `node dist/model-account-cli.js adopt-env`
on the orchestrator with no arguments.
It reads `CLAUDE_CODE_OAUTH_TOKEN` first, then `ANTHROPIC_API_KEY`. When both are
present, the token wins and the command reports that the key was ignored. Bedrock
is outside this migration. `RUNNER_TOKEN_SECRET` must be set before adoption can write.

The command creates `adopted-env-claude-subscription` or
`adopted-env-anthropic-api-key`, stores the value encrypted at the matching
`model-account:<profile-id>` reference, and configures planning, implementation
and review with that profile, agent `claude`, provider `anthropic` and the built-in
`DEFAULT_MODEL`. Each stage uses 90 minutes because configured stages require a
timeout. It creates no project grants and opts no project into configured runs.

Output lists each stage and profile id, never the credential. Existing configured
defaults are a no-op, including when the environment no longer has the credential;
the output reports their existing profile ids. A legacy defaults row is replaced
with a configured revision. An active compatible adopted profile is reused without
another profile revision; a disabled or archived adopted profile is refused, including
when existing defaults reference it. Identifier or reference collisions fail without
changes. Adoption writes are atomic.

Verify with authenticated `GET /api/agent-defaults`: `configured` is true, `mode`
is `configured`, and all three stages name the adopted profile. Projects still
need their own explicit opt-in. To roll back, revert the defaults and delete the
profile on Models & providers; remove its encrypted credential with `secret-delete`
if it is no longer needed. Rotating `RUNNER_TOKEN_SECRET` requires re-importing it
with `secret-import` or the profile's credential editor. The one-time
`import_environment_credential` tool does not repair existing credentials.
When replacing legacy defaults, `adopt-env` repairs a missing or unreadable
credential from the environment before configuring the stages.

## Adopting existing projects

Existing projects remain legacy until an operator runs `adopt-projects`:

```bash
npx tsx --env-file-if-exists=.env src/model-account-cli.ts adopt-projects --dry-run
npx tsx --env-file-if-exists=.env src/model-account-cli.ts adopt-projects --project PROJECT_KEY
```

Run `adopt-env` first to establish configured defaults. Each project line reports the outcome and each stage's model and source. Adoption reads `.ai-implement/config.yml`, `WORKFLOW.md` and `PLANNING.md` at one commit resolved from the configured dispatch branch (`mapping.defaultBranch`). Implementation and review prefer `models.implement` / `models.review`, then observable `mapping.extraEnv.CLAUDE_MODEL` on Fly/local, then WORKFLOW front matter. Planning prefers that mapping model on Fly/local, then PLANNING front matter. Legacy GitHub Actions does not receive mapping Extra Env, so adoption ignores it on that backend. Shadow implementation/review must resolve the same model on both backends; a difference reports `model_conflict` with the stage, backend values and sources, and skips the project without writes. Shadow planning uses GitHub Actions only. Stages without a repository model retain the legacy `DEFAULT_MODEL` fallback (shown as `DEFAULT_MODEL` in the report). Each effective legacy model becomes a stage override when it differs from configured defaults; matching models need no override. If repository reads fail, the report says “model not carried” and all stages inherit defaults.

Runner-only environment settings (for example, Fly secrets, image environment, or GitHub Actions variables/secrets) are not observable through these readers. Adoption cannot preserve those unknown model overrides; inspect the preview against your runner configuration before opting in. The command does not read credentials or guess their values.

Readiness must pass for every effective execution backend, including both shadow backends. Failed checks are reported by code. Dry-run performs the same inspection without writes. Already configured projects and explicit legacy opt-outs are skipped. After readiness, adoption rechecks that branch head before synchronously revalidating local inputs and writing. An observed push or disappeared branch reports `inputs_changed`; retry to inspect the new snapshot. A failed final revision check reports `repository_unavailable` without writing or replacing the checked candidate. Dry-run uses the same guard. This last GitHub observation does not lock remote pushes: a push after it is a later repository change. Repeating the command is safe; changes during inspection refuse the guarded write. Every active account profile remains usable by every project; adoption changes no profiles or credentials.

After adoption, gap-fill runs read the snapshot, not config.yml at the PR head. Repository model changes no longer select a configured run's model. To roll back, write an explicit legacy row on the project's **Agents** tab; future adoption runs preserve that opt-out.
