---
target: orchestrator
auth: none
timeout_minutes: 15
---

# Account fallback attribution in Reports (AII-1825)

Manual: requires an admin session, a test project with configured agents, a Codex account at its usage limit and a working Claude account. Requires a deployed runner and orchestrator with account fallback support.

## Steps

1. On Models & providers, save an implementation stage list with the limited Codex profile first and the Claude profile second. Set a model supported by each agent and note the Claude profile's revision.
2. Dispatch a test implementation run. Confirm the usage limit produces one `[account-fallback]` line and the next attempt runs on Claude.
3. Open the run in Reports and inspect its invocation rows.
4. Repeat with a managed review-fix attempt using the same stage configuration.
5. Restore the original stage configuration.

## Asserts

- Both runs retain the Claude invocation with the fallback profile id, stored revision, Claude agent, Anthropic provider, configured auth mode and fallback model.
- The fallback invocation has verified attribution, no mismatch fields and its reported usage, including when usage is unavailable.
- The managed attempt accepts the fallback row instead of dropping it as a primary-account mismatch.
- No credential value appears in Reports or the switch log.
