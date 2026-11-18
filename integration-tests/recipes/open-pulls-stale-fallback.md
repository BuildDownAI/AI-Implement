---
target: orchestrator
auth: user
timeout_minutes: 10
---

# Open pull requests survive a transient GitHub failure (AII-2007)

Manual: use a disposable orchestrator with two sandbox repository mappings and a controllable GitHub read failure. Keep the process running so its in-memory cache survives.

## Steps

1. Open pull requests in both repositories, including linked and unlinked PRs. Call `list_open_pulls` successfully and record the list and read completion time.
2. Make GitHub listing fail for one repository. At two minutes after the good read, call `list_open_pulls` again.
3. While listing is unavailable, merge one linked PR and close another without merging. Deliver their normal webhooks so their stored link outcomes update. Call the tool again before the original copy reaches five minutes.
4. Call again at least five minutes after the original successful read, then restore GitHub access and retry. Restore the disposable environment afterward.

## Asserts

- The two-minute response succeeds and includes both repositories' PRs. The fallback logs one line naming the failed repository and its copy age.
- Subsequent fallback omits merged and closed-unmerged linked PRs, retaining open-linked and unlinked PRs.
- Fallback does not extend the cache age. At five minutes the tool returns `isError: true`, rather than a partial list.
- Restoring GitHub access produces a successful, refreshed list.
