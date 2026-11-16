---
target: orchestrator
auth: admin
timeout_minutes: 5
---

# Check stored OpenRouter account keys (AII-1950)

Manual: requires an admin session and a valid OpenRouter API key. Keep keys out
of tool arguments, test output and evidence; store them only on Models & providers.

## Steps

1. On Models & providers, create two active OpenRouter accounts: one for Claude
   and one for Codex, both using `openrouter-api-key`. Note their profile IDs.
2. Store the valid OpenRouter key on each account using its write-only key field.
3. As admin, call `check_model_account_key` for each account with
   `{ "args": { "profileId": "<account-id>" } }` (MCP uses the inner arguments).
4. Store a deliberately wrong key on one account and call the tool again.
5. Restore that account's valid key and repeat the check; remove test accounts
   when finished if they are no longer needed.

## Asserts

- Each valid-key result has the requested `profileId`, `profile: "ok"`,
  `binding: "ok"`, `credential: "set"`, and `provider: "pass"`.
- With the wrong key stored, profile, binding and credential retain those states,
  and provider says `fail (key refused, status 401)` or
  `fail (key refused, status 403)`.
- Restoring the valid key restores `provider: "pass"`.
- Results contain only states and the profile ID, with no key, headers or response
  body. A user without the admin role is refused.
