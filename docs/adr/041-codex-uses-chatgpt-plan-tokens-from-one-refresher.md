# 041. Codex uses ChatGPT plan tokens from one refresher

**Status:** Accepted
**Date:** 2026-10-13
**References:** [OpenAI: token sharing for open-source apps](https://developers.openai.com/siwc/token-sharing-open-source), ADR 025, ADR 037, ADR 039, [AII-718](https://linear.app/eudoxus/issue/AII-718/refresh-grant-checks-the-allowlist-before-the-operator-rotates-the), [AII-1193](https://linear.app/eudoxus/issue/AII-1193/hide-model-credentials-from-the-codex-shell-environment), `docs/chatgpt-plan-sign-in.md`

## Context

The current `codex-subscription` mode copies Codex's own `auth.json` into each runner. The runner's Codex refreshes it, and the runner writes it back to the orchestrator. Reservations, owner generations, and recovery holds exist because a runner can lose a rotated refresh token.

OpenAI documents a different path for open-source, self-hosted apps (the URL above):

- The app registers itself at sign-in with `client_id=dynamic_agent_client`, an `agent_name_hint`, and a stable `ext_agent_host_id`. OpenAI issues a `client_id` bound to the user and workspace.
- The browser callback must go to an HTTP loopback address on `127.0.0.1`.
- The access token lives 1 hour. The refresh token lives 30 days and rotates on each refresh. Reuse returns `refresh_token_reused`. OpenAI says: "Serialize refreshes for the same session."
- Inference goes to `https://api.openai.com/v1/responses` with `Authorization: Bearer <access token>`.
- Codex uses a custom provider with `env_key`; renewal means restart with the new token and resume the thread.

A live test on 2026-10-09 (Codex 0.159.2, runner image, model `gpt-6-luna`) proved the path:

| Check | Result |
| -- | -- |
| Dynamic registration and scope `chatgpt.tokens.use.direct` | granted |
| `GET /v1/models` | lists `gpt-6-luna`; body shape is `{ "models": [{ "slug": … }] }`, not `data[].id` |
| `codex exec`, workspace-write, `--output-schema` | pass |
| `codex exec`, read-only, strict nullable review schema | pass |
| `codex exec resume <thread>` in a new process | pass |
| `codex app-server` with a dynamic tool, `--strict-config` | pass |
| refresh before `earliest_refresh_at` | accepted; access and refresh tokens both rotated |
| `auth.json` written | never |
| tools for `gpt-6-*` | sent in an `additional_tools` input item; no `tool_search` |
| shell env of model commands, default policy | sees `CODEX_API_KEY`, `CODEX_HOME`, and the token variable (fixed by AII-1193) |

## Decision

**1. The mode literal stays `codex-subscription`.** Its credential becomes the ChatGPT plan record. `src/dedup.ts` holds the auth modes in a CHECK constraint, and 15 non-test files (11 source files and 4 workflow files) contain the literal (counted on 2026-10-13 under `src`, `scripts`, `workflows`, and `.github`). The admin UI label is "ChatGPT plan".

**2. One refresher holds the refresh token.** On a local run it is the host-side credential port. On a hosted run it is one Restate Virtual Object per account profile. Runners receive only an access token and its expiry, through a new checkout secret kind `chatgpt-access-token`.

**3. "Renew" is another checkout.** The hosted checkout route and the local bridge `/load` already accept repeated calls for the life of a grant, so a runner that needs a fresh token checks out again.

**4. Hosted ChatGPT plan accounts take no reservation and no owner generation.** Concurrent hosted runs on one account are allowed. Usage limits surface as `subscription_sharing_usage_limit_exceeded`. Local runs keep the exclusive local session lease, which also serializes local refreshes.

**5. The hosted refresher calls OpenAI and writes the encrypted record inside one `ctx.run` step, which returns no token.** The Restate journal never holds a plaintext token (ADR 037 gives the same reason for env). A token that rotates and is not saved loses the session; that is the failure class of AII-718.

**6. Codex starts with a custom provider** (`model_provider="chatgpt_plan"`, `env_key="CHATGPT_PLAN_ACCESS_TOKEN"`, `wire_api="responses"`, `requires_openai_auth=false`, `supports_websockets=false`) **and with the credential names in `shell_environment_policy.exclude`.**

**7. Claude subscription accounts keep the current reservation, checkpoint, and recovery design.** This ADR does not change Claude.

**8. Scope: personal and self-hosted use of the operator's own plan.** A hosted service for other people's plans needs OpenAI's interest form and is out of scope. Customer OpenAI runs use API keys.

## Alternatives considered

- **Keep the `auth.json` copy.** Rejected: the refresh token reaches every disposable runner and needs recovery holds.
- **Add a new mode name.** Rejected: it needs a migration of the CHECK constraint and a 15-file census for no behavior gain.
- **Codex app-server `chatgptAuthTokens` login.** Rejected: it targets the ChatGPT backend, and the SIWC docs say not to use `backend-api`.

## Consequences

The refresh token stays in one place per account, so a lost runner loses nothing but an hour-long access token, and the reservation and recovery machinery is not needed for ChatGPT plan accounts. Concurrent hosted runs share one plan's usage limit and can hit it. Nothing calls the `chatgpt-access-token` kind, the Restate refresher object, or the `chatgpt_plan` provider yet; later issues in this build-up implement them. Until then `codex-subscription` behaves as before.
