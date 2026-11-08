---
target: orchestrator
auth: none
timeout_minutes: 15
---

# GitHub Actions opt-in reports unreadable workflows (AII-1752)

Manual: requires an admin sign-in and a disposable GitHub Actions project with valid configured-agent defaults and account profiles. Keep the project paused throughout.

## Steps

1. In `/admin#projects`, select a project that has not opted in. Record its Agents settings.
2. Temporarily point its repository to an inaccessible disposable repository so the GitHub App cannot read default-branch workflow files.
3. Open Agents, enable configured agents, and save. Inspect the PUT to `/api/mappings/<project-key>/agent-config` in browser developer tools.
4. Restore the repository. Run the project's existing workflow sync and merge its PR. With credentials and readiness otherwise valid, retry enabling configured agents.
5. Restore the original Agents settings and leave the project paused.

## Asserts

- The unreadable-workflow PUT returns 409 with code `delivery_unreadable`, backend `github-actions`, and action `Run the existing workflow sync for this project (/admin#projects) and merge its PR in the target repo; this API does not enable or rewrite workflows.`
- The UI says “The workflow files could not be read. Run the workflow sync and try again.” and displays the sync action. Reloading leaves opt-in disabled and the recorded settings unchanged.
- After workflow access and readiness are restored, the PUT returns 200 and opt-in remains enabled after reload.
