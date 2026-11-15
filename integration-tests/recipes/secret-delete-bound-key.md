---
target: orchestrator
auth: admin
timeout_minutes: 5
---

# Bound model keys refuse CLI deletion (AII-1941)

Manual: use an isolated test orchestrator and a disposable model account. Keep all credential values out of command arguments and captured output.

## Steps

1. Create an API-key account on Models & providers and save a disposable key there. Record its account id and credential reference, without recording the key.
2. On the orchestrator host, run `node dist/model-account-cli.js secret-delete --ref <reference>`. Expect exit 1 and guidance to remove the key on Models & providers or with `DELETE /api/model-accounts/:id/credential`.
3. Confirm the account still reports its credential as set. Send authenticated `DELETE /api/model-accounts/:id/credential` for the account; expect success. Confirm a provider/auth mode change is now allowed.
4. Import a disposable unbound key with `secret-import`, supplying its value through stdin. Delete that reference with `secret-delete`; expect exit 0. Repeat deletion; expect exit 0 again.

## Asserts

- CLI refusal preserves the bound credential and never prints a key value.
- Admin credential removal clears the binding so the account destination can change.
- Unbound deletion remains idempotent.
