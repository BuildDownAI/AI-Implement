#!/usr/bin/env bash
# entrypoint.sh — Session machine orchestration.
#
# Startup sequence: validate → token → clone → setup → Claude → PR → teardown.
# This is a container-native port of workflows/claude-implement.yml.
set -euo pipefail

# Log the failing command on any unexpected exit so silent crashes are debuggable.
trap 'log "ERROR: command failed at line $LINENO: $BASH_COMMAND (exit code $?)"' ERR

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib.sh"

# ── 1. Validate required env vars ────────────────────────────────────────────

require_env GITHUB_APP_ID
require_env GITHUB_APP_PRIVATE_KEY
require_one_of ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN
require_env ISSUE_ID
require_env ISSUE_IDENTIFIER
require_env ISSUE_TITLE
require_env ISSUE_DESCRIPTION
require_env GITHUB_OWNER
require_env GITHUB_REPO

GITHUB_DEFAULT_BRANCH="${GITHUB_DEFAULT_BRANCH:-main}"
CLAUDE_MODEL="${CLAUDE_MODEL:-}"
CLAUDE_MAX_TURNS="${CLAUDE_MAX_TURNS:-}"
SESSION_MODE="${SESSION_MODE:-autonomous}"
SETUP_TIMEOUT="${SETUP_TIMEOUT:-300}"
READY_TIMEOUT="${READY_TIMEOUT:-60}"
CLAUDE_TIMEOUT="${CLAUDE_TIMEOUT:-2700}"
PR_NUMBER="${PR_NUMBER:-}"

export ISSUE_ID ISSUE_IDENTIFIER ISSUE_TITLE ISSUE_DESCRIPTION PR_NUMBER

# ── 2. Session mode gate ─────────────────────────────────────────────────────

if [ "$SESSION_MODE" != "autonomous" ]; then
  log "Only autonomous mode is supported in this phase. Requested: $SESSION_MODE"
  exit 0
fi

log "Starting autonomous session for $ISSUE_IDENTIFIER: $ISSUE_TITLE"

# ── Helper: post a status event to the orchestrator ─────────────────────────

post_status() {
  local event_json="$1"
  if [ -z "${ORCHESTRATOR_URL:-}" ] || [ -z "${MACHINE_NONCE:-}" ]; then
    return 0
  fi
  curl -sf --max-time 10 -X POST \
    -H "Content-Type: application/json" \
    -d "$event_json" \
    "${ORCHESTRATOR_URL}/api/status" \
    || log "WARNING: Failed to post status event (non-fatal)"
}

# ── 3. Acquire GitHub token ──────────────────────────────────────────────────

source "$SCRIPT_DIR/token-refresh.sh"
GITHUB_TOKEN=$(cat /tmp/github-token)
export GITHUB_TOKEN GH_TOKEN="$GITHUB_TOKEN"

# ── 4. Configure git and clone ───────────────────────────────────────────────

git config --global user.name "ai-implement-bot"
git config --global user.email "ai-implement-bot@users.noreply.github.com"
git config --global init.defaultBranch "$GITHUB_DEFAULT_BRANCH"

REPO_URL="https://x-access-token:${GITHUB_TOKEN}@github.com/${GITHUB_OWNER}/${GITHUB_REPO}.git"
REPO_DIR="/workspace"

log "Cloning ${GITHUB_OWNER}/${GITHUB_REPO} (branch: $GITHUB_DEFAULT_BRANCH)..."
git clone --depth=1 --branch "$GITHUB_DEFAULT_BRANCH" "$REPO_URL" "$REPO_DIR"
cd "$REPO_DIR"

# Check out existing PR branch for gap-fill runs
if [ -n "$PR_NUMBER" ]; then
  log "Gap-fill run: checking out PR #$PR_NUMBER"
  gh pr checkout "$PR_NUMBER"
fi

# ── 5. Register teardown trap ────────────────────────────────────────────────

AI_TEARDOWN_SCRIPT=""
DEV_SERVER_PID=""
DEV_SERVER_LOG="/tmp/dev-server.log"

start_dev_server() {
  if [ -z "${DEV_CMD:-}" ]; then
    return
  fi

  : > "$DEV_SERVER_LOG"
  log "Starting dev command: $DEV_CMD"
  export DEV_CMD_TO_RUN="$DEV_CMD"
  cat > /tmp/run-dev-server.sh << 'DEV_SERVER_RUNNER'
#!/usr/bin/env bash
export HOME=/home/coder
cd /workspace
exec bash -lc "$DEV_CMD_TO_RUN"
DEV_SERVER_RUNNER
  chmod +x /tmp/run-dev-server.sh
  su -p coder -c /tmp/run-dev-server.sh >"$DEV_SERVER_LOG" 2>&1 &
  DEV_SERVER_PID=$!
  log "Dev command started (pid: $DEV_SERVER_PID, log: $DEV_SERVER_LOG)"
}

wait_for_ready() {
  if [ -z "${READY_CHECK:-}" ]; then
    return
  fi

  log "Waiting for readiness: $READY_CHECK (timeout: ${READY_TIMEOUT}s)"
  local deadline=$((SECONDS + READY_TIMEOUT))

  while true; do
    if bash -lc "$READY_CHECK" >/dev/null 2>&1; then
      log "Ready check passed"
      return
    fi

    if [ -n "$DEV_SERVER_PID" ] && ! kill -0 "$DEV_SERVER_PID" 2>/dev/null; then
      log "Dev command exited before becoming ready. Recent log output:"
      tail -n 50 "$DEV_SERVER_LOG" 2>/dev/null || true
      fail "Dev command failed before readiness check passed"
    fi

    if [ "$SECONDS" -ge "$deadline" ]; then
      log "Ready check timed out. Recent log output:"
      tail -n 50 "$DEV_SERVER_LOG" 2>/dev/null || true
      fail "Ready check timed out after ${READY_TIMEOUT}s"
    fi

    sleep 2
  done
}

cleanup() {
  if [ -n "$AI_TEARDOWN_SCRIPT" ] && [ -f "$AI_TEARDOWN_SCRIPT" ]; then
    log "Running teardown: $AI_TEARDOWN_SCRIPT"
    bash "$AI_TEARDOWN_SCRIPT" || log "WARNING: Teardown script failed (non-fatal)"
  elif [ -n "${TEARDOWN_CMD:-}" ]; then
    log "Running teardown command: $TEARDOWN_CMD"
    bash -lc "$TEARDOWN_CMD" || log "WARNING: Teardown command failed (non-fatal)"
  fi

  if [ -n "$DEV_SERVER_PID" ] && kill -0 "$DEV_SERVER_PID" 2>/dev/null; then
    log "Stopping dev command (pid: $DEV_SERVER_PID)"
    kill "$DEV_SERVER_PID" 2>/dev/null || true
    wait "$DEV_SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

# ── 6. Convention detection ───────────────────────────────────────────────────

DETECT_PROJECT_DIR="$REPO_DIR"
export DETECT_PROJECT_DIR
# shellcheck source=detect-project.sh
source "$SCRIPT_DIR/detect-project.sh"
log "Convention detection: source=${_dp_source} SETUP_CMD=${SETUP_CMD:-} DEV_PORT=${DEV_PORT:-}"

# ── 6b. Fetch planning context from Linear ───────────────────────────────────
# Mirror of the "Fetch planning context from Linear" step in
# workflows/claude-implement.yml. Keep logic aligned with that step — the two
# paths have no shared runtime so drift is a real risk.

PLANNING_CONTEXT=""
if [ -n "${LINEAR_API_KEY:-}" ]; then
  log "Fetching planning context from Linear for $ISSUE_IDENTIFIER..."

  # Planning context is advisory: if Linear is unavailable or the response is
  # malformed, log a warning and proceed without it instead of aborting the
  # job. The fetch work runs in a subshell so its non-zero exit doesn't kill
  # the parent shell (which has `set -euo pipefail`).
  PLANNING_FETCH_LOG=/tmp/planning-fetch.log
  : > "$PLANNING_FETCH_LOG"
  if ! COMMENTS_JSON=$(
    set -euo pipefail
    ACCUM="[]"
    AFTER="null"
    for _page in 1 2 3; do
      if [ "$AFTER" = "null" ]; then
        AFTER_JSON="null"
      else
        AFTER_JSON=$(jq -n --arg v "$AFTER" '$v')
      fi
      BODY=$(jq -cn --arg id "$ISSUE_ID" --argjson after "$AFTER_JSON" \
        '{query:"query($id:String!,$after:String){issue(id:$id){comments(first:100,after:$after,orderBy:createdAt){nodes{body createdAt}pageInfo{hasNextPage endCursor}}}}",variables:{id:$id,after:$after}}')
      # curl -fsS: fail on HTTP errors, suppress progress, keep error messages.
      RESP=$(curl -fsS --max-time 30 -X POST https://api.linear.app/graphql \
        -H "Content-Type: application/json" \
        -H "Authorization: $LINEAR_API_KEY" \
        --data-raw "$BODY")

      PAGE_NODES=$(echo "$RESP" | jq -c '.data.issue.comments.nodes // []')
      ACCUM=$(jq -c -n --argjson a "$ACCUM" --argjson b "$PAGE_NODES" '$a + $b')

      HAS_NEXT=$(echo "$RESP" | jq -r '.data.issue.comments.pageInfo.hasNextPage // false')
      AFTER=$(echo "$RESP" | jq -r '.data.issue.comments.pageInfo.endCursor // ""')
      if [ "$HAS_NEXT" != "true" ] || [ -z "$AFTER" ]; then
        break
      fi
    done
    printf '%s' "$ACCUM"
  ) 2>"$PLANNING_FETCH_LOG"; then
    log "WARNING: Failed to fetch planning context from Linear — proceeding without it."
    if [ -s "$PLANNING_FETCH_LOG" ]; then
      log "Linear fetch error details:"
      sed 's/^/  /' "$PLANNING_FETCH_LOG" | while IFS= read -r _line; do log "$_line"; done
    fi
    COMMENTS_JSON="[]"
  fi

  # Filter for planning-prefixed comments. Keep only the most recent match of
  # each prefix so a re-planning run's stale output doesn't leak into the
  # prompt alongside the fresh plan. Sort the survivors by createdAt so the
  # final order is stable.
  # TODO(AII-71): add "## 📦 AI Planning:" (work units) once AII-71 lands.
  PLANNING_BODIES=$(echo "$COMMENTS_JSON" | jq -r '
    [.[] | select(
      (.body | startswith("## 🏗️ AI Planning: Architecture Analysis")) or
      (.body | startswith("## 🧪 AI Planning: Test Plan")) or
      (.body | startswith("## 🔗 AI Planning: Cross-Story Context"))
    )]
    | group_by(
        if (.body | startswith("## 🏗️")) then "arch"
        elif (.body | startswith("## 🧪")) then "test"
        else "cross" end
      )
    | map(max_by(.createdAt))
    | sort_by(.createdAt)
    | map(.body) | join("\n\n---\n\n")
  ')

  if [ -n "$PLANNING_BODIES" ]; then
    PREAMBLE=$(printf '%s\n\n%s\n\n%s\n' \
      '## Planning Context' \
      'The following architecture analysis, test plan, and cross-story context were produced during the planning phase. Follow these decisions unless you discover a concrete reason not to — and if you deviate, explain why in the PR description.' \
      '---')
    FULL=$(printf '%s\n%s\n\n---\n' "$PREAMBLE" "$PLANNING_BODIES")
    FULL_BYTES=$(printf '%s' "$FULL" | wc -c)
    CAP=40000
    if [ "$FULL_BYTES" -gt "$CAP" ]; then
      TRUNCATED=$(printf '%s' "$FULL" | LC_ALL=C head -c "$CAP")
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

# ── 7. Parse WORKFLOW.md front matter ────────────────────────────────────────
# Direct port of workflows/claude-implement.yml lines 77–153.

AI_SETUP_SCRIPT=""
AI_VERIFY_SCRIPT=""
MODEL=""

if [ -f "WORKFLOW.md" ]; then
  log "Using repo WORKFLOW.md as prompt template"

  # Extract front matter (lines between first pair of ---)
  FRONTMATTER=$(awk '/^---/{found++; next} found==1{print}' WORKFLOW.md)

  # Strip front matter from body (state machine handles --- horizontal rules)
  awk 'BEGIN{in_fm=0; past_fm=0}
       !past_fm && /^---/ { if (!in_fm) { in_fm=1; next } else { in_fm=0; past_fm=1; next } }
       !in_fm { print }' \
    WORKFLOW.md > /tmp/workflow-body.md

  # Strip HTML comments
  perl -0777 -pe 's/<!--.*?-->//gs' /tmp/workflow-body.md > /tmp/workflow-stripped.md

  # Substitute issue variables (explicit list to avoid leaking other env vars)
  envsubst '${ISSUE_ID} ${ISSUE_IDENTIFIER} ${ISSUE_TITLE} ${ISSUE_DESCRIPTION} ${PR_NUMBER} ${PLANNING_CONTEXT}' \
    < /tmp/workflow-stripped.md > /tmp/claude-prompt.md

  # Extract front matter keys (|| true prevents set -e from killing the script
  # when grep finds no matches — grep returns exit 1 on no match)
  if [ -n "${FRONTMATTER:-}" ]; then
    MODEL=$(echo "$FRONTMATTER" | grep '^model:' | head -1 | sed 's/model:[[:space:]]*//' | tr -d '[:space:]' || true)
    AI_SETUP_SCRIPT=$(echo "$FRONTMATTER" | grep '^setup:' | head -1 | sed 's/setup:[[:space:]]*//; s/^[[:space:]]*//; s/[[:space:]]*$//' || true)
    AI_VERIFY_SCRIPT=$(echo "$FRONTMATTER" | grep '^verify:' | head -1 | sed 's/verify:[[:space:]]*//; s/^[[:space:]]*//; s/[[:space:]]*$//' || true)
    AI_TEARDOWN_SCRIPT=$(echo "$FRONTMATTER" | grep '^teardown:' | head -1 | sed 's/teardown:[[:space:]]*//; s/^[[:space:]]*//; s/[[:space:]]*$//' || true)
  fi
else
  log "No WORKFLOW.md found, using default prompt"
  if [ -z "$PR_NUMBER" ]; then
    cat > /tmp/claude-prompt-raw.md << 'PROMPT'
Read CLAUDE.md if it exists.

## New implementation

Create a branch named "${ISSUE_IDENTIFIER}/short-description" then implement the feature below and open a PR with title "${ISSUE_IDENTIFIER}: ${ISSUE_TITLE}". The PR body must include "Fixes ${ISSUE_IDENTIFIER}" so Linear auto-closes the issue on merge.

**Issue:** ${ISSUE_IDENTIFIER}
**Title:** ${ISSUE_TITLE}
**Description:**
${ISSUE_DESCRIPTION}

${PLANNING_CONTEXT}
PROMPT
  else
    cat > /tmp/claude-prompt-raw.md << 'PROMPT'
Read CLAUDE.md if it exists.

## Gap-fill run (PR #${PR_NUMBER})

You are filling implementation gaps on existing PR #${PR_NUMBER}. Do NOT create a new branch or PR. Commit your changes to the current branch and push.

**Issue:** ${ISSUE_IDENTIFIER}
**Title:** ${ISSUE_TITLE}
**Description:**
${ISSUE_DESCRIPTION}

${PLANNING_CONTEXT}
PROMPT
  fi
  envsubst '${ISSUE_ID} ${ISSUE_IDENTIFIER} ${ISSUE_TITLE} ${ISSUE_DESCRIPTION} ${PR_NUMBER} ${PLANNING_CONTEXT}' \
    < /tmp/claude-prompt-raw.md > /tmp/claude-prompt.md
fi

# Tell Claude about the power tools available in this image.
if [ -f /etc/ai-implement/tools.md ]; then
  {
    echo "Power tools available in this environment: see /etc/ai-implement/tools.md"
    echo
    cat /tmp/claude-prompt.md
  } > /tmp/claude-prompt.md.new
  mv /tmp/claude-prompt.md.new /tmp/claude-prompt.md
fi

# Validate model (env var takes precedence over front matter)
if [ -n "$CLAUDE_MODEL" ]; then
  MODEL="$CLAUDE_MODEL"
fi
VALID_MODELS="claude-opus-4-7 claude-opus-4-6 claude-sonnet-4-6 claude-haiku-4-5-20251001"
if [ -n "$MODEL" ] && ! echo "$VALID_MODELS" | grep -qw "$MODEL"; then
  log "WARNING: Unknown model '$MODEL', falling back to claude-sonnet-4-6"
  MODEL=""
fi
if [ -z "$MODEL" ]; then
  MODEL="claude-sonnet-4-6"
fi

log "Model: $MODEL"

# ── 8. Run setup hook ────────────────────────────────────────────────────────

if [ -n "$AI_SETUP_SCRIPT" ]; then
  log "Running setup script: $AI_SETUP_SCRIPT (timeout: ${SETUP_TIMEOUT}s)"
  timeout "$SETUP_TIMEOUT" bash "$AI_SETUP_SCRIPT" || fail "Setup script failed or timed out"
elif [ -n "${SETUP_CMD:-}" ]; then
  log "Running setup command: $SETUP_CMD (timeout: ${SETUP_TIMEOUT}s)"
  timeout "$SETUP_TIMEOUT" bash -lc "$SETUP_CMD" || fail "Setup command failed or timed out"
fi

# ── 9. Remove local Claude settings to avoid conflicts ───────────────────────

rm -f .claude/settings.local.json .claude/settings.json 2>/dev/null || true

# ── 10. Prepare workspace for non-root user ──────────────────────────────────
# Claude Code refuses --dangerously-skip-permissions as root.
# Hand ownership of the workspace and git config to the coder user.

chown -R coder:coder /workspace
cp /root/.gitconfig /home/coder/.gitconfig 2>/dev/null || true
chown coder:coder /home/coder/.gitconfig 2>/dev/null || true

# ── 11. Start the dev command (interactive/preview sessions only) ────────────
# Autonomous implementation sessions do NOT start the target repo's dev server.
# Their job is to implement the issue, not serve the app. Running the repo's
# `dev` script and then hard-gating on a readiness check is pure downside here:
# a dev server that never binds — slow start, an unexpected port, or a repo
# whose `dev` script is itself a long-running daemon (e.g. this orchestrator) —
# makes wait_for_ready call fail() and abort the whole session before Claude
# ever runs. The dev server exists for interactive/preview modes; gate on mode.
if [ "$SESSION_MODE" != "autonomous" ]; then
  start_dev_server
  wait_for_ready
fi

post_status "{\"nonce\":\"${MACHINE_NONCE}\",\"event\":\"setup_complete\"}"

# ── 12. Run Claude Code as non-root user ─────────────────────────────────────
# Write a wrapper script to avoid quoting issues with prompt content.

cat > /tmp/run-claude.sh << 'CLAUDE_RUNNER'
#!/usr/bin/env bash
# su -p preserves the parent's environment including HOME=/root, but we're
# running as coder (uid 1001) with no access to /root. Claude Code's startup
# config/keychain resolution hangs when HOME points at an unreadable dir,
# even with dbus-run-session in front of it. Point HOME at coder's real home.
export HOME=/home/coder

# Close stdin explicitly so nothing can hang waiting for input.
# Disable nonessential traffic (update checks, telemetry) which can hang.
export DISABLE_AUTOUPDATER=1
export DISABLE_TELEMETRY=1
export DISABLE_ERROR_REPORTING=1
export DISABLE_BUG_COMMAND=1
export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1

# Run under a throwaway D-Bus session bus. Claude Code 2.1+ reads the system
# keychain via libsecret on startup; without a session bus, libsecret blocks
# forever in dbus auto-activation. dbus-run-session starts an empty bus,
# libsecret gets a fast "no Secret Service available" response, and Claude
# falls through to CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY from env.
exec dbus-run-session -- claude \
  -p "$(cat /tmp/claude-prompt.md)" \
  --dangerously-skip-permissions \
  --verbose \
  --output-format stream-json \
  --model "${CLAUDE_MODEL}" \
  --max-turns "${CLAUDE_MAX_TURNS}" \
  --allowedTools 'Bash(*)' \
  --allowedTools 'Write' \
  --allowedTools 'Edit' \
  --allowedTools 'Read' \
  --allowedTools 'Glob' \
  --allowedTools 'Grep' \
  --allowedTools 'WebFetch' \
  --allowedTools 'Agent' \
  < /dev/null
CLAUDE_RUNNER
chmod +x /tmp/run-claude.sh
export CLAUDE_MODEL="$MODEL"
# Resolve max turns: env/TOML > default 100
CLAUDE_MAX_TURNS="${CLAUDE_MAX_TURNS:-100}"
export CLAUDE_MAX_TURNS

log "Running Claude Code as 'coder' (timeout: ${CLAUDE_TIMEOUT}s)..."

timeout "$CLAUDE_TIMEOUT" su -p coder -c /tmp/run-claude.sh \
  || fail "Claude Code failed or timed out"

log "Claude Code completed"

# ── 13. Safety net: ensure branch exists and push ────────────────────────────
# The workspace is now owned by coder (chown in step 10). Root needs
# safe.directory to operate on it after Claude finishes.
git config --global --add safe.directory /workspace

CURRENT_BRANCH=$(git branch --show-current)

if [ "$CURRENT_BRANCH" = "$GITHUB_DEFAULT_BRANCH" ]; then
  # Claude didn't create a branch — check for uncommitted changes OR new commits
  HAS_UNCOMMITTED=false
  HAS_NEW_COMMITS=false
  git diff --quiet HEAD || HAS_UNCOMMITTED=true
  [ "$(git rev-parse HEAD)" != "$(git rev-parse "origin/$GITHUB_DEFAULT_BRANCH")" ] && HAS_NEW_COMMITS=true

  if [ "$HAS_UNCOMMITTED" = "true" ] || [ "$HAS_NEW_COMMITS" = "true" ]; then
    BRANCH_NAME="${ISSUE_IDENTIFIER}/auto-implement"
    log "Claude didn't create a branch. Creating fallback: $BRANCH_NAME"
    git checkout -b "$BRANCH_NAME"
    if [ "$HAS_UNCOMMITTED" = "true" ]; then
      git add -A
      git commit -m "${ISSUE_IDENTIFIER}: ${ISSUE_TITLE}" || true
    fi
  else
    log "WARNING: Claude made no changes and didn't create a branch"
  fi
  CURRENT_BRANCH=$(git branch --show-current)
fi

if [ "$CURRENT_BRANCH" != "$GITHUB_DEFAULT_BRANCH" ]; then
  log "Pushing branch $CURRENT_BRANCH..."
  git push -u origin "$CURRENT_BRANCH" || fail "Failed to push branch"
fi

# ── 14. Ensure PR exists ─────────────────────────────────────────────────────

if [ "$CURRENT_BRANCH" != "$GITHUB_DEFAULT_BRANCH" ] && [ -z "$PR_NUMBER" ]; then
  EXISTING_PR=$(gh pr list --head "$CURRENT_BRANCH" --state open --json number --jq '.[0].number' 2>/dev/null || echo "")

  if [ -z "$EXISTING_PR" ] || [ "$EXISTING_PR" = "null" ]; then
    log "Creating PR..."
    DESC_B64=$(printf '%s' "$ISSUE_DESCRIPTION" | base64 -w 0 2>/dev/null || printf '%s' "$ISSUE_DESCRIPTION" | base64)

    gh pr create \
      --title "${ISSUE_IDENTIFIER}: ${ISSUE_TITLE}" \
      --body "Fixes ${ISSUE_IDENTIFIER}

Implements ${ISSUE_IDENTIFIER}: ${ISSUE_TITLE}

<!-- ai-implement-meta
issue_id: ${ISSUE_ID}
issue_identifier: ${ISSUE_IDENTIFIER}
issue_title: ${ISSUE_TITLE}
issue_description_b64: ${DESC_B64}
-->" \
      --head "$CURRENT_BRANCH" \
      --base "$GITHUB_DEFAULT_BRANCH"
  else
    log "PR #$EXISTING_PR already exists"

    # Ensure metadata block is present (Claude may have created the PR without it)
    HAS_META=$(gh pr view "$EXISTING_PR" --json body --jq '.body' | grep -c 'ai-implement-meta' || true)
    if [ "$HAS_META" = "0" ]; then
      log "Appending metadata to PR #$EXISTING_PR"
      CURRENT_BODY=$(gh pr view "$EXISTING_PR" --json body --jq '.body')
      DESC_B64=$(printf '%s' "$ISSUE_DESCRIPTION" | base64 -w 0 2>/dev/null || printf '%s' "$ISSUE_DESCRIPTION" | base64)

      TMPFILE=$(mktemp)
      printf '%s\n\n<!-- ai-implement-meta\nissue_id: %s\nissue_identifier: %s\nissue_title: %s\nissue_description_b64: %s\n-->' \
        "$CURRENT_BODY" "$ISSUE_ID" "$ISSUE_IDENTIFIER" "$ISSUE_TITLE" "$DESC_B64" > "$TMPFILE"
      gh pr edit "$EXISTING_PR" --body-file "$TMPFILE"
      rm -f "$TMPFILE"
    fi
  fi
fi

# Post implementation_complete once the PR is known
_impl_pr_url=$(gh pr list --head "$CURRENT_BRANCH" --state open --json url --jq '.[0].url' 2>/dev/null || echo "")
_impl_pr_num=$(gh pr list --head "$CURRENT_BRANCH" --state open --json number --jq '.[0].number' 2>/dev/null || echo "0")
if [ -n "$_impl_pr_url" ] && [ "$_impl_pr_url" != "null" ]; then
  post_status "{\"nonce\":\"${MACHINE_NONCE}\",\"event\":\"implementation_complete\",\"prNumber\":${_impl_pr_num:-0},\"prUrl\":\"${_impl_pr_url}\"}"
fi

# ── 15. Run verify hook ───────────────────────────────────────────────────────

if [ -n "$AI_VERIFY_SCRIPT" ] || [ -n "${VERIFY_CMD:-}" ]; then
  post_status "{\"nonce\":\"${MACHINE_NONCE}\",\"event\":\"verify_running\"}"
fi

_verify_passed=true
if [ -n "$AI_VERIFY_SCRIPT" ]; then
  log "Running verify: $AI_VERIFY_SCRIPT"
  if ! bash "$AI_VERIFY_SCRIPT"; then
    log "WARNING: Verify script failed (non-fatal)"
    _verify_passed=false
  fi
elif [ -n "${VERIFY_CMD:-}" ]; then
  log "Running verify command: $VERIFY_CMD"
  if ! bash -lc "$VERIFY_CMD"; then
    log "WARNING: Verify command failed (non-fatal)"
    _verify_passed=false
  fi
fi

if [ -n "$AI_VERIFY_SCRIPT" ] || [ -n "${VERIFY_CMD:-}" ]; then
  if [ "$_verify_passed" = "true" ]; then
    post_status "{\"nonce\":\"${MACHINE_NONCE}\",\"event\":\"verify_passed\"}"
  else
    post_status "{\"nonce\":\"${MACHINE_NONCE}\",\"event\":\"verify_failed\",\"summary\":\"Verify script exited with non-zero status\"}"
  fi
fi

# ── 16. Log results (stub — orchestrator reporting in future tickets) ────────

PR_URL=$(gh pr list --head "$CURRENT_BRANCH" --state open --json url --jq '.[0].url' 2>/dev/null || echo "")
log "Session complete. PR: ${PR_URL:-none}"
log "Issue: $ISSUE_IDENTIFIER ($ISSUE_ID)"

# Teardown runs via the EXIT trap (step 5)
log "Session finished"
