# 049. Claude subscription profiles hold a setup-token

**Status:** Accepted
**Date:** 2026-11-07
**References:** [ADR 041](041-codex-uses-chatgpt-plan-tokens-from-one-refresher.md), [AII-963](https://linear.app/eudoxus/issue/AII-963/provision-and-recover-hosted-claude-subscription-accounts), [AII-1530](https://linear.app/eudoxus/issue/AII-1530/move-every-project-to-managed-model-credentials), [model-account-operations.md](../model-account-operations.md)

## Context

Claude subscription profiles have no managed path today. ADR 041 decision 7 retained AII-963's reservation, checkpoint, and recovery design, but that lifecycle has not been built. The working legacy path supplies the long-lived value from `claude setup-token` as `CLAUDE_CODE_OAUTH_TOKEN`, without refresh or reservation. Standing rule 4 calls for wrapping this proven mechanism.

AII-1530's "Open decisions" raises the subscription-token storage compliance question, quoting Claude Code's Legal and compliance page. On 2026-11-07 the operator decided to store the setup-token for managed Claude subscription profiles. This records the operator's decision on that question; it does not claim legal clearance.

## Decision

1. **A managed Claude subscription profile holds a setup-token as a protected secret.** Store the `claude setup-token` value in `model_protected_secrets` through the same store that `secret-import` uses. The existing store's internal API-key representation for a string is distinct from the checkout kind.
2. **Checkout carries `{ kind: "claude-oauth-token", token }`.** The runner receives the token as `CLAUDE_CODE_OAUTH_TOKEN`, preserving the legacy mechanism without refresh.
3. **No reservation or owner generation.** Concurrent runs on one profile are allowed. There is no checkpoint or recovery lifecycle for this token.
4. **Local subscription runs are unchanged.** Local `local-login` runs keep the `session` checkout kind and `authDir`.

## Rejected alternative

Implement [AII-963](https://linear.app/eudoxus/issue/AII-963/provision-and-recover-hosted-claude-subscription-accounts)'s reservation, checkpoint, and recovery lifecycle. Rejected because it requires a multi-wave build while the legacy setup-token mechanism is already proven. A protected-secret wrapper preserves that mechanism without building session ownership and recovery machinery.

## Consequences

Managed runs will share the profile's stored setup-token and the account's usage limits. The operator imports or replaces the token through `secret-import`; a write-only credential field on Models & providers comes with D6. Protected-secret storage and its key-rotation requirements apply.

This ADR amends ADR 041 decision 7. It records the design only: checkout and resolver support, removal of the managed-run refusal, and the D6 field remain separate implementation work. Local `local-login` behavior stays unchanged.

Rollback: revert this decision and its documentation amendments. Observability: none.
