#!/usr/bin/env bash
# entrypoint.sh — Thin bootstrap. All pipeline logic lives in TS at /app/dist.
# Responsibilities: env validation per mode, token acquisition, clone, chown,
# then exec the phase-appropriate TS entry (run-autonomous.js / run-planning.js)
# under dbus + non-root.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/lib.sh"
trap 'log "ERROR: line $LINENO failed: $BASH_COMMAND (exit $?)"' ERR

# ── 1. Mode detection ────────────────────────────────────────────────────────
if [ "${GITHUB_ACTIONS:-}" = "true" ]; then
  AI_IMPLEMENT_MODE="gha"
else
  AI_IMPLEMENT_MODE="${AI_IMPLEMENT_MODE:-fly}"
fi
log "Execution mode: $AI_IMPLEMENT_MODE"
export AI_IMPLEMENT_MODE

# ── 2. Env validation ────────────────────────────────────────────────────────
PROVIDER="${PROVIDER:-anthropic}"
case "$PROVIDER" in
  bedrock) [ "$AI_IMPLEMENT_MODE" = "gha" ] || fail "provider=bedrock is supported only in GHA mode"; require_env AWS_REGION; export CLAUDE_CODE_USE_BEDROCK=1; export CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1 ;;
  anthropic) require_one_of ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN ;;
  *) fail "Unsupported provider: $PROVIDER" ;;
esac
export PROVIDER
# AI_IMPLEMENT_RUN_CONFIG (the envelope) carries the issue fields when set; the
# TS runner decodes them itself. Only the legacy per-field contract needs them
# validated and exported here.
if [ -n "${AI_IMPLEMENT_RUN_CONFIG:-}" ]; then
  log "Issue fields will be resolved from the AI_IMPLEMENT_RUN_CONFIG envelope"
else
  require_env ISSUE_ID ISSUE_IDENTIFIER ISSUE_TITLE ISSUE_DESCRIPTION
  export ISSUE_ID ISSUE_IDENTIFIER ISSUE_TITLE ISSUE_DESCRIPTION
fi

if [ "$AI_IMPLEMENT_MODE" = "gha" ]; then
  require_env GITHUB_TOKEN GITHUB_REPOSITORY
  GITHUB_OWNER="${GITHUB_REPOSITORY%%/*}"
  GITHUB_REPO="${GITHUB_REPOSITORY#*/}"
else
  require_env GITHUB_TOKEN GITHUB_OWNER GITHUB_REPO
fi
export GITHUB_OWNER GITHUB_REPO
[ -z "${PR_NUMBER:-}" ] && [ -n "${AI_IMPLEMENT_RUN_CONFIG:-}" ] && PR_NUMBER="$(node -e "try{const c=JSON.parse(Buffer.from(process.env.AI_IMPLEMENT_RUN_CONFIG,'base64').toString());process.stdout.write(c.prNumber||'')}catch{}")"
export PR_NUMBER="${PR_NUMBER:-}"

# ── 3. Token acquisition ─────────────────────────────────────────────────────
# Both GHA (workflow-minted) and fly/local (orchestrator-minted) receive GITHUB_TOKEN directly.
export GH_TOKEN="$GITHUB_TOKEN"

# ── 4. Git config + clone ────────────────────────────────────────────────────
if [ -z "${GITHUB_DEFAULT_BRANCH:-}" ]; then
  if [ -n "${GITHUB_REF_NAME:-}" ]; then
    GITHUB_DEFAULT_BRANCH="${GITHUB_REF_NAME}"
  else
    GITHUB_DEFAULT_BRANCH="$(gh api "repos/${GITHUB_OWNER}/${GITHUB_REPO}" --jq ".default_branch")"
  fi
fi
export GITHUB_DEFAULT_BRANCH
# For non-gap-fill runs, envelope baseBranch wins over dispatch-layer env (feature-branch grouping).
if [ -z "${PR_NUMBER:-}" ] && [ -n "${AI_IMPLEMENT_RUN_CONFIG:-}" ]; then
  _rb="$(node -e 'try{const c=JSON.parse(Buffer.from(process.env.AI_IMPLEMENT_RUN_CONFIG,"base64").toString());process.stdout.write(c.baseBranch||"")}catch(e){}' 2>/dev/null||true)"
  if [ -n "$_rb" ]; then log "run_config.baseBranch=${_rb}"; GITHUB_DEFAULT_BRANCH="$_rb"; fi
fi
git config --global user.name "ai-implement-bot"
git config --global user.email "ai-implement-bot@users.noreply.github.com"
git config --global init.defaultBranch "$GITHUB_DEFAULT_BRANCH"

REPO_URL="https://x-access-token:${GITHUB_TOKEN}@github.com/${GITHUB_OWNER}/${GITHUB_REPO}.git"
log "Cloning ${GITHUB_OWNER}/${GITHUB_REPO}..."
git clone --depth=1 --branch "$GITHUB_DEFAULT_BRANCH" "$REPO_URL" /workspace
git config --global --add safe.directory /workspace
cd /workspace
if [ -n "$PR_NUMBER" ]; then
  log "Gap-fill: checking out PR #$PR_NUMBER"
  # --depth + --branch narrows origin's fetch refspec to the cloned base branch.
  # gh pr checkout needs the PR head to count as a trackable remote branch.
  git config --replace-all remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'
  gh pr checkout "$PR_NUMBER"
  GITHUB_DEFAULT_BRANCH="$(git branch --show-current)"
  export GITHUB_DEFAULT_BRANCH
fi

# ── 5. Workspace ownership for non-root Claude ───────────────────────────────
chown -R coder:coder /workspace
cp /root/.gitconfig /home/coder/.gitconfig 2>/dev/null || true
chown coder:coder /home/coder/.gitconfig 2>/dev/null || true

# ── 6. Invoke TS pipeline ────────────────────────────────────────────────────
export WORKSPACE_DIR=/workspace
RUNNER_PHASE="${RUNNER_PHASE:-implementation}"
export RUNNER_PHASE
# Only "planning" has a dedicated entry. "implementation" and "gap-analysis"
# both run run-autonomous.js (gap-fill is an implementation run with PR_NUMBER set),
# so they intentionally share the default branch.
if [ "$RUNNER_PHASE" = "planning" ]; then
  RUNNER_ENTRY="run-planning.js"
else
  RUNNER_ENTRY="run-autonomous.js"
fi
log "Invoking TS pipeline (node /app/dist/$RUNNER_ENTRY, phase=$RUNNER_PHASE)..."
exec dbus-run-session -- su -p coder -c "HOME=/home/coder exec node /app/dist/$RUNNER_ENTRY"
