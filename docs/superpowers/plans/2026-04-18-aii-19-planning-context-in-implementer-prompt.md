# AII-19: Planning Context in Implementer Prompt — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Teach both implementation paths (GitHub Actions workflow + Fly Machines entrypoint) to fetch planning artifacts from Linear and prepend them to Claude's prompt, so the planner's decisions actually constrain the implementer.

**Architecture:** A shell step in each path queries Linear's GraphQL API for comments on the current issue whose bodies start with one of the three planning prefixes, concatenates them in chronological order, wraps the result in a preamble block, and exposes it as `PLANNING_CONTEXT` to `envsubst` when rendering the prompt template. The `WORKFLOW.md` template gains a `${PLANNING_CONTEXT}` placeholder that renders empty when no planning comments exist (backward-compatible). The shell logic is intentionally inlined in both paths (no shared helper) because the GitHub Actions workflow is synced into customer repos while the entrypoint is baked into a container image — they have no shared runtime. The duplication is ~40 lines of shell; drift risk is mitigated by keeping both copies byte-identical.

**Tech Stack:** Bash, `curl`, `jq`, Linear GraphQL API v1, GNU `envsubst`. No TypeScript changes. No new dependencies.

**Related:** Closes AII-19. Addresses AII-74 gaps #5 (prompt-size guard), #7 (pagination), #8 (comment-trigger coverage), #9 (Fly parity). Gap #6 (existing-repo `WORKFLOW.md` migration) covered by a CHANGELOG entry.

---

## File Structure

**Modified files:**

- `workflows/claude-implement.yml` — new "Fetch planning context" step before "Prepare prompt"; add `${PLANNING_CONTEXT}` to both `envsubst` allow-lists in "Prepare prompt"
- `workflows/WORKFLOW.md` — seeded template gets a `${PLANNING_CONTEXT}` placeholder
- `session/entrypoint.sh` — new block before `if [ -f "WORKFLOW.md" ]` that fetches planning context; add `${PLANNING_CONTEXT}` to both `envsubst` invocations
- `CHANGELOG.md` (or `README.md` if no CHANGELOG) — note the template change and instructions for customers who have a customized `WORKFLOW.md`

**No new files.** No changes to `src/`, tests, or `sync-workflow.yml`.

---

## Data Contract

### Linear GraphQL query (used in both paths)

```graphql
query($id: String!, $after: String) {
  issue(id: $id) {
    comments(first: 100, after: $after, orderBy: createdAt) {
      nodes { body createdAt }
      pageInfo { hasNextPage endCursor }
    }
  }
}
```

- Paginates up to **3 pages** (300 comments max) as a safety cap.
- Filters client-side for bodies starting with one of:
  - `## 🏗️ AI Planning: Architecture Analysis`
  - `## 🧪 AI Planning: Test Plan`
  - `## 🔗 AI Planning: Cross-Story Context`
- Orders by `createdAt` ascending (Linear default).
- Concatenates bodies with `\n\n---\n\n` separator.

### PLANNING_CONTEXT value

**When no planning comments match:** empty string.

**When at least one matches:**

```
## Planning Context

The following architecture analysis, test plan, and cross-story context were produced during the planning phase. Follow these decisions unless you discover a concrete reason not to — and if you deviate, explain why in the PR description.

---

<comment 1 body>

---

<comment 2 body>

---

<comment 3 body>

---
```

### Prompt-size guard

If the final `PLANNING_CONTEXT` exceeds **40,000 bytes**, truncate to 40,000 bytes and append a literal marker:

```
[... planning context truncated from <N> bytes to 40000 bytes ...]
```

The 40 KB cap leaves room for the rest of the prompt under the model's practical context window and is conservative enough that real-world three-comment planning almost never hits it.

---

## Task 1: Add the Fetch step to `workflows/claude-implement.yml`

**Files:**
- Modify: `workflows/claude-implement.yml` (insert new step between "Install power tools" at line ~68 and "Prepare prompt" at line ~123)

- [ ] **Step 1: Read the current file to confirm the insertion point**

Run: `sed -n '120,135p' workflows/claude-implement.yml`

Expected: lines showing the `Prepare prompt` step header (`- name: Prepare prompt`) at line ~123. The new step goes immediately before this.

- [ ] **Step 2: Insert the Fetch step**

Open `workflows/claude-implement.yml` and insert the following **before** the existing `- name: Prepare prompt` line (preserve existing indentation: 6 spaces for the `- name:` line):

```yaml
      - name: Fetch planning context from Linear
        id: fetch-planning
        env:
          LINEAR_API_KEY: ${{ secrets.LINEAR_API_KEY }}
          ISSUE_ID: ${{ inputs.issue_id }}
        run: |
          set -euo pipefail

          # Fetch up to 3 pages (300 comments) of comments for this issue,
          # then filter client-side for planning-prefixed bodies.
          COMMENTS_JSON="[]"
          AFTER="null"
          for page in 1 2 3; do
            if [ "$AFTER" = "null" ]; then
              AFTER_ARG="null"
            else
              AFTER_ARG="\"$AFTER\""
            fi
            RESP=$(curl -s --max-time 30 -X POST https://api.linear.app/graphql \
              -H "Content-Type: application/json" \
              -H "Authorization: $LINEAR_API_KEY" \
              --data-raw "{\"query\":\"query(\$id: String!, \$after: String) { issue(id: \$id) { comments(first: 100, after: \$after, orderBy: createdAt) { nodes { body createdAt } pageInfo { hasNextPage endCursor } } } }\",\"variables\":{\"id\":\"$ISSUE_ID\",\"after\":$AFTER_ARG}}")

            PAGE_NODES=$(echo "$RESP" | jq -c '.data.issue.comments.nodes // []')
            COMMENTS_JSON=$(jq -c -n --argjson a "$COMMENTS_JSON" --argjson b "$PAGE_NODES" '$a + $b')

            HAS_NEXT=$(echo "$RESP" | jq -r '.data.issue.comments.pageInfo.hasNextPage // false')
            AFTER=$(echo "$RESP" | jq -r '.data.issue.comments.pageInfo.endCursor // ""')
            if [ "$HAS_NEXT" != "true" ] || [ -z "$AFTER" ]; then
              break
            fi
          done

          # Filter for planning-prefixed comments, preserve order.
          PLANNING_BODIES=$(echo "$COMMENTS_JSON" | jq -r '
            [.[] | select(
              (.body | startswith("## 🏗️ AI Planning: Architecture Analysis")) or
              (.body | startswith("## 🧪 AI Planning: Test Plan")) or
              (.body | startswith("## 🔗 AI Planning: Cross-Story Context"))
            ) | .body] | .[]' | awk 'BEGIN{first=1} {if(!first) print "\n---\n"; first=0; print}')

          if [ -z "$PLANNING_BODIES" ]; then
            echo "No planning comments found for issue $ISSUE_ID"
            {
              echo 'planning_context<<PLANNING_EOF'
              echo 'PLANNING_EOF'
            } >> "$GITHUB_OUTPUT"
            exit 0
          fi

          PREAMBLE='## Planning Context

          The following architecture analysis, test plan, and cross-story context were produced during the planning phase. Follow these decisions unless you discover a concrete reason not to — and if you deviate, explain why in the PR description.

          ---
          '

          # Assemble the full block, then truncate if over 40KB.
          FULL=$(printf '%s\n%s\n\n---\n' "$PREAMBLE" "$PLANNING_BODIES")
          FULL_BYTES=$(printf '%s' "$FULL" | wc -c)
          CAP=40000
          if [ "$FULL_BYTES" -gt "$CAP" ]; then
            TRUNCATED=$(printf '%s' "$FULL" | head -c "$CAP")
            FULL=$(printf '%s\n\n[... planning context truncated from %s bytes to %s bytes ...]\n' "$TRUNCATED" "$FULL_BYTES" "$CAP")
            echo "::warning::Planning context truncated from $FULL_BYTES bytes to $CAP bytes"
          fi

          echo "Planning context: $FULL_BYTES bytes assembled"
          {
            echo 'planning_context<<PLANNING_EOF'
            printf '%s\n' "$FULL"
            echo 'PLANNING_EOF'
          } >> "$GITHUB_OUTPUT"
```

- [ ] **Step 3: Wire the output into the Prepare prompt step**

In the existing `Prepare prompt` step (step `id: prepare-prompt`, starting at line ~123), add `PLANNING_CONTEXT` to the `env:` block and to **both** `envsubst` allow-lists.

Change:

```yaml
      - name: Prepare prompt
        id: prepare-prompt
        env:
          ISSUE_ID: ${{ inputs.issue_id }}
          ISSUE_IDENTIFIER: ${{ inputs.issue_identifier }}
          ISSUE_TITLE: ${{ inputs.issue_title }}
          ISSUE_DESCRIPTION: ${{ inputs.issue_description }}
          PR_NUMBER: ${{ inputs.pr_number }}
```

to:

```yaml
      - name: Prepare prompt
        id: prepare-prompt
        env:
          ISSUE_ID: ${{ inputs.issue_id }}
          ISSUE_IDENTIFIER: ${{ inputs.issue_identifier }}
          ISSUE_TITLE: ${{ inputs.issue_title }}
          ISSUE_DESCRIPTION: ${{ inputs.issue_description }}
          PR_NUMBER: ${{ inputs.pr_number }}
          PLANNING_CONTEXT: ${{ steps.fetch-planning.outputs.planning_context }}
```

Then update the first `envsubst` (currently at line ~144):

Change:
```bash
            envsubst '${ISSUE_ID} ${ISSUE_IDENTIFIER} ${ISSUE_TITLE} ${ISSUE_DESCRIPTION} ${PR_NUMBER}' \
              < /tmp/workflow-stripped.md > /tmp/claude-prompt.md
```

to:
```bash
            envsubst '${ISSUE_ID} ${ISSUE_IDENTIFIER} ${ISSUE_TITLE} ${ISSUE_DESCRIPTION} ${PR_NUMBER} ${PLANNING_CONTEXT}' \
              < /tmp/workflow-stripped.md > /tmp/claude-prompt.md
```

And the second `envsubst` (currently at line ~175):

Change:
```bash
            envsubst '${ISSUE_ID} ${ISSUE_IDENTIFIER} ${ISSUE_TITLE} ${ISSUE_DESCRIPTION} ${PR_NUMBER}' \
              < /tmp/claude-prompt.md > /tmp/claude-prompt-rendered.md
```

to:
```bash
            envsubst '${ISSUE_ID} ${ISSUE_IDENTIFIER} ${ISSUE_TITLE} ${ISSUE_DESCRIPTION} ${PR_NUMBER} ${PLANNING_CONTEXT}' \
              < /tmp/claude-prompt.md > /tmp/claude-prompt-rendered.md
```

- [ ] **Step 4: Shellcheck the workflow**

Run:

```bash
# Extract the new step's shell script and lint it.
yq '.jobs.implement.steps[] | select(.name == "Fetch planning context from Linear") | .run' workflows/claude-implement.yml > /tmp/fetch-step.sh
shellcheck -s bash /tmp/fetch-step.sh
```

Expected: no errors. Warnings about `set -euo pipefail` in a heredoc or `printf` formatting are acceptable but should be resolved if shellcheck flags a real bug (e.g. unquoted expansion, `[[` vs `[`). Fix any issues inline, then re-run.

- [ ] **Step 5: Confirm YAML still parses**

Run:

```bash
yq '.jobs.implement.steps | length' workflows/claude-implement.yml
```

Expected: prints a number (step count increased by 1 vs. before the edit). No `Error: ...` output.

- [ ] **Step 6: Commit**

```bash
git add workflows/claude-implement.yml
git commit -m "AII-19: fetch planning context from Linear in claude-implement.yml"
```

---

## Task 2: Update `workflows/WORKFLOW.md` template with `${PLANNING_CONTEXT}` placeholder

**Files:**
- Modify: `workflows/WORKFLOW.md`

- [ ] **Step 1: Add the placeholder**

Open `workflows/WORKFLOW.md` and insert `${PLANNING_CONTEXT}` between the `## Issue` block (ends around line 122) and the `---` separator that precedes `## Repo context` (line ~124). The exact edit:

Change:
```markdown
**Description:**
${ISSUE_DESCRIPTION}

---

## Repo context
```

to:
```markdown
**Description:**
${ISSUE_DESCRIPTION}

${PLANNING_CONTEXT}

---

## Repo context
```

Rationale: `${PLANNING_CONTEXT}` expands to either empty (producing an extra blank line, harmless) or the full "## Planning Context" block with its own internal structure. Placing it after the issue description and before repo context keeps the narrative order: "here's what was asked → here's what was planned → here's the repo → here's the checklist".

- [ ] **Step 2: Update the HTML-comment docs at the top of WORKFLOW.md**

In the comment block (lines 16–22), add `${PLANNING_CONTEXT}` to the list of substituted variables.

Change:
```
    ${ISSUE_IDENTIFIER}   Linear identifier, e.g. ENG-42
    ${ISSUE_TITLE}        Issue title
    ${ISSUE_DESCRIPTION}  Full issue description (Markdown)
    ${ISSUE_ID}           Linear UUID (useful if you want Claude to call the Linear API)
    ${PR_NUMBER}          Set on gap-fill re-runs; empty on first run
```

to:
```
    ${ISSUE_IDENTIFIER}   Linear identifier, e.g. ENG-42
    ${ISSUE_TITLE}        Issue title
    ${ISSUE_DESCRIPTION}  Full issue description (Markdown)
    ${ISSUE_ID}           Linear UUID (useful if you want Claude to call the Linear API)
    ${PR_NUMBER}          Set on gap-fill re-runs; empty on first run
    ${PLANNING_CONTEXT}   Rendered planning comments (empty if none); expands to a full "## Planning Context" block or nothing
```

- [ ] **Step 3: Commit**

```bash
git add workflows/WORKFLOW.md
git commit -m "AII-19: add \${PLANNING_CONTEXT} placeholder to WORKFLOW.md template"
```

---

## Task 3: Manually exercise the fetch step against a real Linear issue (sanity check before touching the Fly path)

**Files:** none modified.

- [ ] **Step 1: Pick a real issue with planning comments**

Run:

```bash
# AII-19 itself doesn't have planning comments. Use AII-18's issue or whichever
# test issue was most recently run through claude-plan.yml. Find a candidate:
curl -s -X POST https://api.linear.app/graphql \
  -H "Content-Type: application/json" \
  -H "Authorization: $LINEAR_API_KEY" \
  -d '{"query":"{ issues(filter: { labels: { name: { eq: \"Plan-Complete\" } } }, first: 5) { nodes { id identifier title } } }"}' | jq '.data.issues.nodes'
```

Expected: list of at least one issue. Copy its `id` (UUID) to use in the next step. If no results, skip this task and proceed to Task 4 — the step will be exercised end-to-end in Task 7.

- [ ] **Step 2: Run the new shell block standalone against the chosen issue**

Paste the shell block from Task 1 Step 2 into a file, export `LINEAR_API_KEY` and `ISSUE_ID`, and run:

```bash
export LINEAR_API_KEY="$(cat ~/.linear-api-key)"  # or wherever your key is
export ISSUE_ID="<UUID from previous step>"
export GITHUB_OUTPUT=/tmp/gha-output
: > "$GITHUB_OUTPUT"
bash /tmp/fetch-step.sh
cat "$GITHUB_OUTPUT"
```

Expected: `GITHUB_OUTPUT` contains a `planning_context<<PLANNING_EOF ... PLANNING_EOF` block with the rendered "## Planning Context" heading, preamble, and at least one planning comment body between `---` separators.

- [ ] **Step 3: Verify empty case**

Repeat Step 2 with `ISSUE_ID` set to the UUID of an issue **without** planning comments (e.g. AII-19's UUID `34d8b665-3564-4052-88d5-1df6d33742a9`). Expected: empty `planning_context` output (the heredoc markers are present but the content between them is empty) and stdout prints `No planning comments found for issue <ID>`.

- [ ] **Step 4: No commit — this was a verification-only task**

---

## Task 4: Port the Fetch logic to `session/entrypoint.sh`

**Files:**
- Modify: `session/entrypoint.sh`

- [ ] **Step 1: Identify the insertion point**

Run: `grep -n "Parse WORKFLOW.md front matter" session/entrypoint.sh`

Expected: one match near line 166. The new block goes immediately before this section header (before line 166).

- [ ] **Step 2: Insert the fetch block**

Insert the following block immediately **before** the `# ── 7. Parse WORKFLOW.md front matter ────────────────────────────────────────` line:

```bash
# ── 6b. Fetch planning context from Linear ───────────────────────────────────
# Mirror of the "Fetch planning context from Linear" step in
# workflows/claude-implement.yml. Keep byte-identical with that step where
# possible — the two paths have no shared runtime so drift is a real risk.

PLANNING_CONTEXT=""
LINEAR_API_KEY="${LINEAR_API_KEY:-}"
if [ -n "$LINEAR_API_KEY" ]; then
  log "Fetching planning context from Linear for $ISSUE_IDENTIFIER..."

  COMMENTS_JSON="[]"
  AFTER="null"
  for page in 1 2 3; do
    if [ "$AFTER" = "null" ]; then
      AFTER_ARG="null"
    else
      AFTER_ARG="\"$AFTER\""
    fi
    RESP=$(curl -s --max-time 30 -X POST https://api.linear.app/graphql \
      -H "Content-Type: application/json" \
      -H "Authorization: $LINEAR_API_KEY" \
      --data-raw "{\"query\":\"query(\$id: String!, \$after: String) { issue(id: \$id) { comments(first: 100, after: \$after, orderBy: createdAt) { nodes { body createdAt } pageInfo { hasNextPage endCursor } } } }\",\"variables\":{\"id\":\"$ISSUE_ID\",\"after\":$AFTER_ARG}}")

    PAGE_NODES=$(echo "$RESP" | jq -c '.data.issue.comments.nodes // []')
    COMMENTS_JSON=$(jq -c -n --argjson a "$COMMENTS_JSON" --argjson b "$PAGE_NODES" '$a + $b')

    HAS_NEXT=$(echo "$RESP" | jq -r '.data.issue.comments.pageInfo.hasNextPage // false')
    AFTER=$(echo "$RESP" | jq -r '.data.issue.comments.pageInfo.endCursor // ""')
    if [ "$HAS_NEXT" != "true" ] || [ -z "$AFTER" ]; then
      break
    fi
  done

  PLANNING_BODIES=$(echo "$COMMENTS_JSON" | jq -r '
    [.[] | select(
      (.body | startswith("## 🏗️ AI Planning: Architecture Analysis")) or
      (.body | startswith("## 🧪 AI Planning: Test Plan")) or
      (.body | startswith("## 🔗 AI Planning: Cross-Story Context"))
    ) | .body] | .[]' | awk 'BEGIN{first=1} {if(!first) print "\n---\n"; first=0; print}')

  if [ -n "$PLANNING_BODIES" ]; then
    PREAMBLE='## Planning Context

The following architecture analysis, test plan, and cross-story context were produced during the planning phase. Follow these decisions unless you discover a concrete reason not to — and if you deviate, explain why in the PR description.

---
'
    FULL=$(printf '%s\n%s\n\n---\n' "$PREAMBLE" "$PLANNING_BODIES")
    FULL_BYTES=$(printf '%s' "$FULL" | wc -c)
    CAP=40000
    if [ "$FULL_BYTES" -gt "$CAP" ]; then
      TRUNCATED=$(printf '%s' "$FULL" | head -c "$CAP")
      FULL=$(printf '%s\n\n[... planning context truncated from %s bytes to %s bytes ...]\n' "$TRUNCATED" "$FULL_BYTES" "$CAP")
      log "WARNING: Planning context truncated from $FULL_BYTES bytes to $CAP bytes"
    fi
    PLANNING_CONTEXT="$FULL"
    log "Planning context: $FULL_BYTES bytes assembled"
  else
    log "No planning comments found for issue $ISSUE_ID"
  fi
else
  log "LINEAR_API_KEY not set; skipping planning context fetch"
fi

export PLANNING_CONTEXT
```

- [ ] **Step 3: Update both `envsubst` invocations**

In `session/entrypoint.sh` around line 189, change:

```bash
  envsubst '${ISSUE_ID} ${ISSUE_IDENTIFIER} ${ISSUE_TITLE} ${ISSUE_DESCRIPTION} ${PR_NUMBER}' \
    < /tmp/workflow-stripped.md > /tmp/claude-prompt.md
```

to:

```bash
  envsubst '${ISSUE_ID} ${ISSUE_IDENTIFIER} ${ISSUE_TITLE} ${ISSUE_DESCRIPTION} ${PR_NUMBER} ${PLANNING_CONTEXT}' \
    < /tmp/workflow-stripped.md > /tmp/claude-prompt.md
```

And around line 229, change:

```bash
  envsubst '${ISSUE_ID} ${ISSUE_IDENTIFIER} ${ISSUE_TITLE} ${ISSUE_DESCRIPTION} ${PR_NUMBER}' \
    < /tmp/claude-prompt-raw.md > /tmp/claude-prompt.md
```

to:

```bash
  envsubst '${ISSUE_ID} ${ISSUE_IDENTIFIER} ${ISSUE_TITLE} ${ISSUE_DESCRIPTION} ${PR_NUMBER} ${PLANNING_CONTEXT}' \
    < /tmp/claude-prompt-raw.md > /tmp/claude-prompt.md
```

- [ ] **Step 4: Confirm `LINEAR_API_KEY` is available in the session machine**

Run:

```bash
grep -n "LINEAR_API_KEY" session/entrypoint.sh src/*.ts
```

Expected: the env var is referenced somewhere in `src/` (the orchestrator passes it to the session machine as part of the Fly Machines env). If it's **not** passed, you need to verify the orchestrator sets it. Check `src/github.ts` or the Fly Machines dispatch path (`src/fly*.ts` if one exists). If missing, add it to the env block of the Fly machine creation call.

If `LINEAR_API_KEY` is not currently passed through, **stop and flag this to the user** — it's a separate change that affects secret propagation and should be its own ticket. The fallback behavior in the fetch block (empty `PLANNING_CONTEXT` when the key is missing) is safe, but the feature won't work on Fly until the key is piped through.

- [ ] **Step 5: Shellcheck the entrypoint**

Run:

```bash
shellcheck -s bash session/entrypoint.sh
```

Expected: no new errors introduced. Pre-existing warnings are acceptable; any new warnings triggered by the insertion should be resolved.

- [ ] **Step 6: Commit**

```bash
git add session/entrypoint.sh
git commit -m "AII-19: fetch planning context in Fly Machines entrypoint"
```

---

## Task 5: Add a CHANGELOG / migration note for existing repos

**Files:**
- Modify: `CHANGELOG.md` if it exists; otherwise `README.md`

- [ ] **Step 1: Find the right file**

Run: `ls CHANGELOG.md 2>/dev/null || echo "no changelog"`

If CHANGELOG.md exists, target that. If not, target `README.md` under a new "## Migration notes" section near the "Workflow templates" section.

- [ ] **Step 2: Add the entry**

Add the following at the top of the CHANGELOG or under the migration section:

```markdown
## [Unreleased]

### Changed — Planning context in implementer prompt (AII-19)

`claude-implement.yml` and the Fly Machines entrypoint now fetch `## 🏗️ AI Planning:`, `## 🧪 AI Planning:`, and `## 🔗 AI Planning:` comments from Linear and expose them as `${PLANNING_CONTEXT}` when rendering the prompt template.

**For customer repos with a stock `WORKFLOW.md`:** nothing to do. The next sync PR will update the template.

**For customer repos with a customized `WORKFLOW.md`:** sync will not overwrite your template. To pick up the planning context, add `${PLANNING_CONTEXT}` somewhere in the body of your `WORKFLOW.md` — typically immediately after the issue description section. Without this, the planning comments are fetched but never reach Claude's prompt.

**Secret requirement:** the Fly Machines path now requires `LINEAR_API_KEY` in the session environment. If the key is missing, planning context is silently skipped (non-fatal). The GitHub Actions path already has access to this secret.
```

- [ ] **Step 3: Commit**

```bash
git add CHANGELOG.md  # or README.md
git commit -m "AII-19: document planning-context template change for existing repos"
```

---

## Task 6: End-to-end validation against a real issue

**Files:** none modified. This task proves the feature works and produces the evidence the ticket's Validation section asks for.

- [ ] **Step 1: Pick (or create) a validation issue**

Create a throwaway Linear issue in the AI-Implement team titled `AII-validate-19`, body describing a trivial feature ("add a function `hello(name)` that returns `Hello, {name}!` with a unit test"). Label it `AI-Implement` only (no `Plan-Complete`) so the poller routes it to planning first. Target the `eudoxus-ai/linear-ai-implement` repo (or any repo with `planningEnabled=true`).

- [ ] **Step 2: Wait for planning dispatch**

Watch the admin UI's dispatch log, or `fly logs --app <app>`, for `[poll] Planning workflow dispatched for AII-validate-19`. Confirm the `claude-plan.yml` run starts in the target repo's Actions tab.

- [ ] **Step 3: Verify planning comments were posted**

After the planning run finishes, fetch the issue's comments:

```bash
curl -s -X POST https://api.linear.app/graphql \
  -H "Content-Type: application/json" \
  -H "Authorization: $LINEAR_API_KEY" \
  -d '{"query":"{ issue(id: \"<UUID>\") { comments(first: 20, orderBy: createdAt) { nodes { body } } } }"}' | jq -r '.data.issue.comments.nodes[].body' | head -c 2000
```

Expected: at least two comments with headers starting `## 🏗️ AI Planning:` and `## 🧪 AI Planning:`.

- [ ] **Step 4: Wait for implementation dispatch and inspect the rendered prompt**

The next poll (within ~60s) should dispatch `claude-implement.yml` because `autoApprovePlans=true` (default per AII-21). Open the Actions run in GitHub. In the "Fetch planning context from Linear" step's log, confirm it prints `Planning context: <N> bytes assembled` (N > 500 bytes typically).

In the "Prepare prompt" step's log, expand the output and confirm the rendered prompt contains a `## Planning Context` section with the planning comment bodies, sitting between the issue description and the repo context.

- [ ] **Step 5: Verify the implementer's PR references planning decisions**

When the `claude-implement.yml` run finishes and the PR is created, read the PR description. It should reference at least one decision from the planning comments (e.g. a file path the architecture analysis called out, or a test case from the test plan). If the PR reads as if Claude never saw the planning context, check the prompt in Step 4 — the most likely failure mode is `${PLANNING_CONTEXT}` being present in `WORKFLOW.md` but empty, meaning the fetch step returned nothing.

- [ ] **Step 6: Validate backward-compatibility on a no-planning issue**

Create a second issue `AII-validate-19-no-plan`, label it `AI-Implement` **and** `Plan-Complete` (skipping the planning phase). Verify the next implementation run's "Fetch planning context" step prints `No planning comments found for issue <UUID>` and the "Prepare prompt" step's rendered prompt has no `## Planning Context` section. The PR should be created as normal.

- [ ] **Step 7: Validate the `/ai-implement` gap-fill path**

On the PR from Step 5, comment `/ai-implement`. Watch the comment-trigger workflow dispatch `claude-implement.yml` again. Inspect the new run's "Fetch planning context" step — it should print the same byte count as Step 4 (same issue, same planning comments). This confirms AII-74 gap #8 (comment-trigger coverage) is handled — the fetch is in the shared `Prepare prompt` pipeline, not gated on `pr_number == ''`.

- [ ] **Step 8: Close the validation issues**

Delete or close the throwaway Linear issues to keep the backlog tidy.

- [ ] **Step 9: No commit — this was a verification-only task**

---

## Task 7: Update AII-19 with validation evidence and close

**Files:** none in repo. Updates Linear.

- [ ] **Step 1: Post a summary comment to AII-19**

Via the Linear MCP, add a comment to AII-19 summarizing: target repo, validation issue identifiers, PR link, and a note that gaps #5 (truncation), #7 (pagination), #8 (comment-trigger), #9 (Fly parity) from AII-74 were addressed in this implementation. Gap #6 (existing-repo migration) documented in CHANGELOG.

- [ ] **Step 2: Mark AII-19 Done**

Once the PR in `linear-ai-implement` merges, AII-19 auto-closes via the `Fixes AII-19` line the implementer adds to its PR body. If that didn't happen for any reason, set the status to `Done` manually.

---

## Self-review notes

**Spec coverage (from AII-19):**

- [x] GHA: new "Fetch planning artifacts from Linear" step before Claude — Task 1
- [x] GHA: sort by creation date, concatenate into PLANNING_CONTEXT — Task 1 (Linear default orderBy + jq select preserves order)
- [x] GHA: prepend "## Planning Context" block with the specified preamble — Task 1 (preamble matches ticket wording)
- [x] GHA: backward-compatible when no comments — Task 1 (empty output) + Task 6 Step 6
- [x] Fly Machines: same logic in entrypoint.sh — Task 4
- [x] Fly Machines: include in Claude's prompt — Task 4 (envsubst)
- [x] WORKFLOW.md template: ${PLANNING_CONTEXT} placeholder — Task 2
- [x] Full-pipeline validation (plan → approve → implement) — Task 6
- [x] PR description references planning decisions — Task 6 Step 5
- [x] Claude follows architecture analysis — Task 6 Step 5 (manual inspection)
- [x] Backward-compat — Task 6 Step 6

**AII-74 gap coverage:**

- Gap #5 (prompt-size guard): 40 KB cap in both paths.
- Gap #7 (pagination): 3 pages × 100 comments = 300-comment ceiling.
- Gap #8 (comment-trigger): fetch lives in shared Prepare prompt path; validated in Task 6 Step 7.
- Gap #9 (Fly parity): both paths implemented with byte-near-identical shell; CHANGELOG calls out secret propagation.
- Gap #6 (existing-repo migration): CHANGELOG entry, Task 5.
- Gap #1 (autoApprovePlans), #3 (re-planning), #4 (server-side validation): out of scope, handled elsewhere (AII-21, deferred, already resolved respectively).

**Placeholder scan:** no "TBD", no "implement later", no "similar to Task N". All shell blocks are complete.

**Type consistency:** only one identifier shared across tasks (`PLANNING_CONTEXT`); used identically everywhere.
