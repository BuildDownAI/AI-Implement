---
target: orchestrator
auth: none
timeout_minutes: 15
---

# Restate review-fix parks at the PR dispatch budget (AII-1765)

Manual: requires an admin session and a disposable PR on a sandbox project.

## Steps

1. Select a sandbox project using the Restate review-fix lifecycle and a supported execution backend. Set **PR Dispatch Budget** to 1.
2. On a disposable PR linked to a sandbox tracker issue, request a blocking review fix and let its run finish. Submit another blocking finding to request another automatic fix within 24 hours.
3. Check `/admin#runners`: the issue is parked. Check the PR: one budget notice says **Needs Human**. Check the tracker: one budget notice appears, unless a breaker trip already posted its notice there.
4. Wait through at least two 30-second retry intervals and submit another blocking finding. Verify no further automatic fix launches and no duplicate budget notices appear.
5. Repeat with a PR that has no resolvable tracker identity. Verify the PR notice and park exist under `repository#prNumber`, with no tracker comment or provider error.
6. Unpark the disposable issues and restore the project's budget setting after testing.

## Asserts

- A budget refusal parks the issue and posts one PR notice per park.
- Tracker delivery uses the linked issue, skips a previously delivered breaker notice, and is omitted when no tracker issue can be resolved.
- Further automatic fixes remain blocked while parked; repeated refusals post no duplicate notice.
