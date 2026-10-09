# ChatGPT plan sign-in

`src/chatgpt-plan-login.ts` signs an operator in with ChatGPT and saves a ChatGPT plan record (`ChatGptPlanRecordV1`, `src/chatgpt-plan-token.ts`). The local refresher reads that record, and the hosted import command uploads it.

## When to use it

Use it to connect your own ChatGPT plan to the `codex-subscription` mode. It follows [OpenAI's sign-in for open-source apps](https://developers.openai.com/siwc/token-sharing-open-source/sign-in).

**Scope limit (ADR 038).** This is for personal and self-hosted use of your own plan. Do not use it to pool, share, or resell plan access. The ADR 038 file is not yet in `docs/adr/` on this branch; link it when it lands.

## The 127.0.0.1 rule

OpenAI redirects the browser to `http://127.0.0.1:<port>/auth/callback` (default port 1455). The browser and the command must run on the same machine, so a remote orchestrator cannot receive the callback. Sign in on a laptop, then import the record. The command prints the authorize URL as well as opening it, in case no browser opens. It gives up after 10 minutes. `--port <n>` changes the port; the same value is used for the authorize and token calls.

## Commands

```bash
npm run build
node dist/chatgpt-plan-login.js login  --record ~/.ai-implement/chatgpt-plan/credentials.json
node dist/chatgpt-plan-login.js status --record ~/.ai-implement/chatgpt-plan/credentials.json
node dist/chatgpt-plan-login.js logout --record ~/.ai-implement/chatgpt-plan/credentials.json
```

| Command | Effect |
|---|---|
| `login` | Signs in and writes the record. The first run registers a client (`dynamic_agent_client`, `agent_name_hint=AI-Implement`); later runs reauthorize with the saved `clientId`, `id_token_hint`, and `login_hint`. |
| `status` | Prints email, subject, the first 10 characters of the client id, host id, scopes, and seconds left. Never a token. A signed-out record prints `signed out`. |
| `logout` | Revokes the refresh token, then removes `accessToken`, `refreshToken`, and `idToken`. Everything else stays, including `clientId` and `extAgentHostId`. If revocation is not confirmed the tokens are still removed, and you can disconnect the app in ChatGPT settings. |

`login` writes nothing unless every check passes: `state`, issued client id, token exchange, ID token signature (RS256, against the JWKS from OpenAI's OpenID configuration), `iss`, `aud`, `exp`, `nonce`, the same `sub` as the saved record, and the `chatgpt.tokens.use.direct` scope.

## Where the record lives

Recommended: `~/.ai-implement/chatgpt-plan/credentials.json`, mode `0600`, written atomically (temp file, then rename). Next to it, `host-id` holds `urn:uuid:<uuidv4>`, created with mode `0600` on first use and reused after. It is random, never derived from an email or user id.

A signed-out record has no tokens, so it does not pass `parseChatGptPlanRecord`. Consumers must treat it as "needs login".

No token appears on argv, in stdout, or in an error message.
