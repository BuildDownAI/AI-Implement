---
target: orchestrator
auth: none
timeout_minutes: 15
---

# GitHub Actions stage save reports unreadable workflows (AII-1752)

Manual: requires an admin sign-in and a disposable GitHub Actions project with valid configured-agent defaults and account profiles. Keep the project paused throughout.

## Steps

1. In `/admin#projects`, select a saved disposable project. Record its repository, mode and Agents stage overrides. Keep it paused.
2. As an admin, call `set_project_agent_mode` with `teamKey` set to the project key and `mode` set to `configured`. This validates configuration resolution without checking workflow readiness. Reload the project.
3. Temporarily point its repository to an inaccessible disposable repository so the GitHub App cannot read default-branch workflow files. Save the mapping.
4. Open Agents, change a stage model override to another valid model, and click Save agent settings. Inspect the PUT to `/api/mappings/<project-key>/agent-config` in browser developer tools.
5. Restore the repository and save the mapping. Run the project's existing workflow sync and merge its PR. With credentials and readiness otherwise valid, reload Agents, make the same stage override change and save again.
6. Restore the original stage overrides on Agents, restore the original mode with `set_project_agent_mode`, and leave the project paused.

## Asserts

- The unreadable-workflow PUT contains only `stages` and returns 409 with code `delivery_unreadable`, backend `github-actions`, and action `Run the existing workflow sync for this project (/admin#projects) and merge its PR in the target repo; this API does not enable or rewrite workflows.`
- The UI says “The workflow files could not be read. Run the workflow sync and try again.” and displays the sync action. Reloading leaves the mode configured and the recorded stage overrides unchanged.
- After workflow access and readiness are restored, the PUT returns 200 and the changed override remains after reload. The mode stays configured.
