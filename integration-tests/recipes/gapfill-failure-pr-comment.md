---
target: orchestrator
auth: none
timeout_minutes: 20
---

# Failed gap-fill reports on its PR (AII-1689)

Manual check using a sandbox PR and its mapped tracker issue.

## Steps

1. Post a new `/ai-implement` instruction on the sandbox PR that produces a change the reviewer rejects through the iteration limit.
2. Wait for the run to report failure. Inspect the PR, tracker issue and run record.
3. Replay the authenticated result callback twice using the same dispatch credential and payload in the sandbox test harness.
4. Repeat with GitHub comment posting made unavailable in the harness while report intake remains available.

## Asserts

- The PR gets one run autopsy with final reviewer feedback, the unchanged-PR statement and guidance for a new `/ai-implement` comment with a changed instruction. No discarded diff is posted or pushed.
- The tracker retains the original autopsy.
- Callback replays add no PR comment; reports still reach intake.
- A GitHub posting failure produces a callback warning and HTTP 200; the job remains failed with its reported code and intake receives the report.
