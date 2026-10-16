# Model account operations

Operator procedures for hosted model accounts. The command is `src/model-account-cli.ts`, run on the orchestrator
machine as `node dist/model-account-cli.js <command> --profile <id>`.

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

### 3. Check status

```bash
fly ssh console -a <orchestrator-app> -C "node dist/model-account-cli.js chatgpt-status --profile <id>"
```

Prints email, subject, the first 10 characters of the client id, host id, seconds left on the access token, and the
refresher's last outcome. It never prints a token.

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
- **API-key and Bedrock profiles resolve from encrypted storage.** `src/model-protected-secrets.ts` stores each credential in `model_protected_secrets`, sealed with AES-256-GCM under a key derived by HKDF from `RUNNER_TOKEN_SECRET` (info `ai-implement/model-protected-secret-key/v1`, distinct from the session and protection labels) and bound to the exact `model-account:` reference as authenticated data. A permitted profile whose reference has a stored row prepares as `ready`. A missing key, row or reference, a malformed value, a bad tag, a changed `RUNNER_TOKEN_SECRET` or a swapped reference is unavailable: the profile prepares as `authentication-required`, with a fixed failure code and no value in errors. There is never an ambient fallback key. Rotating `RUNNER_TOKEN_SECRET` requires re-importing the credentials. Operator import and delete commands are a separate follow-up ([AII-1422](https://linear.app/eudoxus/issue/AII-1422/import-and-remove-hosted-api-credentials)).
- **Scope of this slice.** Only `codex-subscription` and API-key profiles prepare. No `claude-subscription` account is reserved, GitHub Actions does not prepare, and a repo image override (`.ai-implement/image.yml`) is refused on Fly. No new environment variable is involved.

## Claude subscription accounts

To be filled by [AII-963](https://linear.app/eudoxus/issue/AII-963/provision-accounts-and-recover-held-subscription-sessions).
