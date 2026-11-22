---
target: orchestrator
auth: none
timeout_minutes: 15
---

# Workflow sync writes the mapping's custom file names (AII-738)

Manual until the AII-474 executor can save a mapping: the steps need an admin sign-in. The asserts read GitHub with the operator's `gh` login.

## Steps

1. Confirm the testing orchestrator is on a build that contains AII-738 (`get_deploy_posture`, or the Deployments page).
2. On `/admin#projects`, open **New project**. Ticketing: Linear team **Sandbox** (key `SAN`). Source: owner `BuildDownAI`, repo `AI-Implement-Sandbox`, default branch `main`, **Workflow File** `claude-implement-2.yml`, branch prefix blank. Provider: planning enabled, **Planning Workflow File** `claude-plan-2.yml`. Execution: GitHub Actions.
3. Save. Wait until the sync status shows completed and a PR link.
4. **Pause** the SAN project on its row so the poll loop does not dispatch any SAN issue during the test.
5. Negative check: edit the SAN mapping, set Workflow File to `../x.yml`, save. Expect a 400 error with body `workflowFile must be a bare file name ending in .yml or .yaml`; the mapping keeps `claude-implement-2.yml`. Repeat with `dir/x.yml` and `x.txt`.
6. Run the asserts.
7. Clean up: close the sync PR without merging (or merge it if the Sandbox should keep the `-2` files), and leave the SAN project paused or delete it.

## Asserts

```bash
gh api "repos/BuildDownAI/AI-Implement-Sandbox/contents/.github/workflows/claude-implement-2.yml?ref=sync/ai-implement" --jq .name >/dev/null
```

```bash
gh api "repos/BuildDownAI/AI-Implement-Sandbox/contents/.github/workflows/claude-plan-2.yml?ref=sync/ai-implement" --jq .name >/dev/null
```

```bash
R=repos/BuildDownAI/AI-Implement-Sandbox/contents/.github/workflows
for f in claude-implement.yml claude-plan.yml; do
  a=$(gh api "$R/$f?ref=main" --jq .sha); b=$(gh api "$R/$f?ref=sync/ai-implement" --jq .sha)
  [ "$a" = "$b" ] || { echo "$f changed on the sync branch"; exit 1; }
done
```

```bash
gh pr list --repo BuildDownAI/AI-Implement-Sandbox --head sync/ai-implement --state open --json body --jq '.[0].body' | grep -q 'claude-implement-2.yml'
```

Design reference: [AII-738](https://linear.app/eudoxus/issue/AII-738/workflow-sync-writes-the-mappings-workflow-file-and-planning-workflow) (planning parent), [AII-472](https://linear.app/eudoxus/issue/AII-472/integration-test-recipe-format-and-first-recipes) (recipe format), [AII-441](https://linear.app/eudoxus/issue/AII-441/integration-testing) (integration testing).
