# Claude PR Reviews Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add automated Claude Code reviews to PRs in this public repo, auto-running for same-repo PRs and gated behind a maintainer comment for fork PRs, without exposing secrets to fork-supplied code.

**Architecture:** A single GitHub Actions workflow at `.github/workflows/claude-review.yml` uses `anthropics/claude-code-action` under `pull_request_target` (so it has write access to comment) plus `issue_comment` for on-demand re-runs. Same-repo PRs auto-trigger on `opened`/`ready_for_review` (not `synchronize`, to control cost). Fork PRs only run when a maintainer (OWNER/MEMBER/COLLABORATOR) posts `/claude-review`. The workflow checks out the PR head with `persist-credentials: false` and never executes PR-supplied scripts (no install, no build, no tests). A repo-level setting requires maintainer approval before any fork workflow runs at all, providing defense-in-depth.

**Tech Stack:** GitHub Actions, `anthropics/claude-code-action@v1`, `actionlint` for workflow validation.

---

## File Structure

- **Create**: `.github/workflows/claude-review.yml` — the review workflow
- **Modify**: `README.md` — document the `/claude-review` command and the one-time repo-setting requirement
- **Modify**: `CLAUDE.md` — note the new workflow under the project structure block

No source code changes. No tests required (workflow is validated via `actionlint` and a real PR smoke test).

---

### Task 1: Add the Claude review workflow

**Files:**
- Create: `.github/workflows/claude-review.yml`

- [ ] **Step 1: Write the workflow file**

Create `.github/workflows/claude-review.yml` with this exact content:

```yaml
name: Claude PR review

on:
  pull_request_target:
    types: [opened, ready_for_review]
  issue_comment:
    types: [created]

permissions:
  contents: read
  pull-requests: write
  issues: write

jobs:
  review:
    # Auto-run on same-repo PRs (opened/ready_for_review only — not synchronize,
    # to control cost during iterative pushes). For fork PRs and re-runs, a
    # maintainer must post `/claude-review` as a comment.
    if: |
      (github.event_name == 'pull_request_target' &&
       github.event.pull_request.head.repo.full_name == github.repository &&
       github.event.pull_request.draft == false) ||
      (github.event_name == 'issue_comment' &&
       github.event.issue.pull_request != null &&
       contains(github.event.comment.body, '/claude-review') &&
       (github.event.comment.author_association == 'OWNER' ||
        github.event.comment.author_association == 'MEMBER' ||
        github.event.comment.author_association == 'COLLABORATOR'))
    runs-on: ubuntu-latest
    steps:
      - name: Resolve PR head SHA
        id: pr
        uses: actions/github-script@v7
        with:
          script: |
            if (context.eventName === 'pull_request_target') {
              core.setOutput('sha', context.payload.pull_request.head.sha);
              core.setOutput('number', context.payload.pull_request.number);
              return;
            }
            const pr = await github.rest.pulls.get({
              owner: context.repo.owner,
              repo: context.repo.repo,
              pull_number: context.payload.issue.number,
            });
            core.setOutput('sha', pr.data.head.sha);
            core.setOutput('number', pr.data.number);

      # Checkout PR head WITHOUT credentials so any malicious post-checkout
      # script can't exfiltrate the GITHUB_TOKEN. We never run install/build/test
      # steps on this checkout — Claude only reads the diff.
      - uses: actions/checkout@v4
        with:
          ref: ${{ steps.pr.outputs.sha }}
          persist-credentials: false
          fetch-depth: 0

      - name: Run Claude review
        uses: anthropics/claude-code-action@v1
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
          trigger_phrase: "/claude-review"
          track_progress: true
          prompt: |
            REPO: ${{ github.repository }}
            PR NUMBER: ${{ steps.pr.outputs.number }}

            Review the diff for this PR. Focus on:
            - Correctness, edge cases, and likely bugs
            - Security issues (especially around the GitHub Actions / secrets surface,
              SQLite usage, GraphQL inputs, and shell escaping)
            - Style consistency with the rest of the codebase (see CLAUDE.md)
            - Test coverage gaps

            Post a single sticky top-level comment with your review. Use inline
            comments only for specific code-line issues. Be concise — skip praise
            unless something is genuinely well-done. If the diff looks fine, say so
            briefly.
          claude_args: |
            --allowedTools "mcp__github_inline_comment__create_inline_comment,Bash(gh pr comment:*),Bash(gh pr diff:*),Bash(gh pr view:*)"
```

Permissions block needs `id-token: write` for the action's OIDC handshake — update the top-level `permissions:` block accordingly:

```yaml
permissions:
  contents: read
  pull-requests: write
  issues: write
  id-token: write
```

- [ ] **Step 2: Lint the workflow with actionlint**

Run: `docker run --rm -v "$(pwd):/repo" -w /repo rhysd/actionlint:latest -color .github/workflows/claude-review.yml`
Expected: No output (success). If `docker` is unavailable, run: `npx -y @rhysd/actionlint .github/workflows/claude-review.yml` or `brew install actionlint && actionlint .github/workflows/claude-review.yml`.
Acceptable: zero errors. Warnings about expression complexity are fine.

- [ ] **Step 3: Verify YAML parses**

Run: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/claude-review.yml'))"`
Expected: No output, no error.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/claude-review.yml
git commit -m "Add Claude PR review workflow"
```

---

### Task 2: Document the workflow in README

**Files:**
- Modify: `README.md` (file tree block + new "PR reviews" section)

- [ ] **Step 1: Update the file tree to list the new workflow**

Find this block in `README.md`:

```
.github/workflows/    deploy-clients.yml, sync-workflow.yml, build-runner.yml
```

Replace with:

```
.github/workflows/    deploy-clients.yml, sync-workflow.yml, build-runner.yml,
                      claude-review.yml
```

- [ ] **Step 2: Add a "PR reviews" section**

Append this section to `README.md` immediately before the `## Status` heading:

```markdown
## PR reviews

Claude reviews PRs automatically via `.github/workflows/claude-review.yml`:

- **Same-repo PRs**: review runs once when the PR is opened or marked ready for review. To re-run after pushing changes, comment `/claude-review` on the PR.
- **Fork PRs**: a maintainer (owner, member, or collaborator) must comment `/claude-review` to trigger a review. GitHub's "Require approval for outside collaborators" setting (Settings → Actions → General → Fork pull request workflows) gates the workflow run on top of that.

The workflow checks out the PR head with `persist-credentials: false` and never executes PR-supplied scripts — only the diff is read. Set the `ANTHROPIC_API_KEY` repo secret to enable it; the workflow is a no-op without it.
```

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "Document Claude PR review workflow in README"
```

---

### Task 3: Note the workflow in CLAUDE.md

**Files:**
- Modify: `CLAUDE.md` (project structure block)

- [ ] **Step 1: Add the workflow to the project structure listing**

Find this block in `CLAUDE.md`:

```
.github/workflows/
  deploy-clients.yml — matrix deploy to all clients on push to main
  sync-workflow.yml  — sync workflow templates to target repos
```

Replace with:

```
.github/workflows/
  deploy-clients.yml — matrix deploy to all clients on push to main
  sync-workflow.yml  — sync workflow templates to target repos
  claude-review.yml  — Claude reviews PRs (auto for same-repo, /claude-review for forks)
  build-runner.yml   — build and push the session runner image to GHCR
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "List claude-review and build-runner workflows in CLAUDE.md"
```

---

### Task 4: Manual configuration steps (out of code, in repo settings)

These are not code changes but must be completed for the workflow to function safely. Document completion in the PR description.

- [ ] **Step 1: Add the `ANTHROPIC_API_KEY` repository secret**

Browser: Go to `https://github.com/BuildDownAI/AI-Implement/settings/secrets/actions` → New repository secret → Name `ANTHROPIC_API_KEY`, value is an Anthropic API key scoped to this workflow's expected spend. Set a monthly spend limit on the key in the Anthropic Console.

Verify: The secret appears in the list (value masked).

- [ ] **Step 2: Require approval for outside-collaborator workflow runs**

Browser: Go to `https://github.com/BuildDownAI/AI-Implement/settings/actions` → "Fork pull request workflows from outside collaborators" → select **Require approval for all outside collaborators** → Save.

Verify: The selected radio is "Require approval for all outside collaborators".

- [ ] **Step 3: Confirm workflow permissions allow the action to comment**

Browser: Same page (`/settings/actions`) → "Workflow permissions" → confirm **Read and write permissions** is selected, OR confirm the workflow's job-level `permissions:` block grants what's needed (it does: `pull-requests: write`, `issues: write`). Default repo setting "Read repository contents and packages permissions" is fine because the workflow declares its own permissions.

Verify: Either the global setting is read-write, or the job-level permissions are present (they are, per Task 1).

---

### Task 5: Smoke test on a real PR

- [ ] **Step 1: Create a trivial PR from the same repo**

Run:

```bash
git checkout -b smoke-test-claude-review
echo "" >> README.md
git commit -am "smoke test: trigger claude review"
git push -u origin smoke-test-claude-review
gh pr create --title "Smoke test: Claude review" --body "Verifying the claude-review workflow auto-fires on same-repo PRs."
```

Expected: PR opens; within ~1–2 minutes the `Claude PR review` workflow appears on the PR Checks tab and starts running.

- [ ] **Step 2: Verify the review comment posts**

Run: `gh pr view --comments` (in the smoke-test branch directory)
Expected: A comment from the `github-actions` bot containing Claude's review of the diff. If the workflow fails, check `gh run list --workflow=claude-review.yml` and `gh run view <run-id> --log-failed`.

- [ ] **Step 3: Test the `/claude-review` re-trigger**

Run: `gh pr comment --body "/claude-review"`
Expected: A new workflow run starts within ~30 seconds; a second review comment appears.

- [ ] **Step 4: Close the smoke-test PR and clean up**

Run:

```bash
gh pr close --delete-branch
git checkout main
```

- [ ] **Step 5: Verify fork-PR gating manually (optional, but recommended once)**

If you have a personal fork, push a trivial change there, open a PR against `BuildDownAI/AI-Implement`, and confirm:
1. No workflow runs automatically.
2. After you (as a maintainer) comment `/claude-review`, GitHub prompts for workflow approval (because of the Task 4 Step 2 setting). Once approved, the review runs.

If no fork is available, this is acceptable to skip — the `if:` condition has been reviewed and the `pull_request_target` head-repo check is a documented safe pattern.

---

## Done criteria

- `.github/workflows/claude-review.yml` exists, lints clean, and is committed
- README and CLAUDE.md document the workflow
- `ANTHROPIC_API_KEY` secret is set
- "Require approval for outside collaborators" is enabled
- Smoke test PR shows Claude posting an automatic review and re-running on `/claude-review`
