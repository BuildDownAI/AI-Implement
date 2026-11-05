---
target: orchestrator
auth: none
timeout_minutes: 15
---

# Self-hosted provisioning recovery and sessions reruns (AII-1540)

Manual operator check. Use a disposable Fly organization and client configuration. Token creation and secret import change the disposable app. Never use production credentials.

## Steps

1. Prepare an existing disposable orchestrator with `FLY_SESSIONS_APP` seeded and its active sessions app saved on `/admin#settings`. Ensure `FLY_SESSIONS_TOKEN` is absent. Set the local client file's sessions app to a different, nonexistent name.
2. Run `npm run provision-client -- <slug>`. Keep existing secrets, then enter the active sessions app shown on `/admin#settings` at the explicit active app prompt. Decline deployment, waiting and remote checks.
3. Confirm the local sessions app was not created and neither sessions seed variable changed. Confirm the active app's token was minted and imported, without its value appearing in terminal output. Verify runner access through the orchestrator's setup checks.
4. Repeat in an environment without `flyctl` on PATH. Confirm setup exits with status 1 and prints the setup retry, full deploy command with source stamps, health URL command and remote setup-check command. No client file or Fly resource should change.
5. Restore `flyctl`, sign out of Fly in the disposable environment, then repeat step 4. Expect the same deferred commands and no writes. Sign in again after the check.
6. Remove the disposable resources and configuration.

## Asserts

- A rerun never creates the unrelated sessions app named in the local file.
- Missing sessions tokens require explicit selection of an existing active app.
- Missing tooling and failed initial authentication stop before mutations and print actionable deferred commands.
- No token, PEM or other credential appears in output or subprocess arguments. Only the optional break-glass code is shown once.
