#!/usr/bin/env bash
# entrypoint.sh — Thin bootstrap. All pipeline logic lives in TS at /app/dist.
# Responsibilities: env validation per mode, token acquisition, clone, chown,
# then exec node /app/dist/run-autonomous.js under dbus + non-root.

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
require_one_of ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN
require_env ISSUE_ID ISSUE_IDENTIFIER ISSUE_TITLE ISSUE_DESCRIPTION

if [ "$AI_IMPLEMENT_MODE" = "gha" ]; then
  require_env GITHUB_TOKEN GITHUB_REPOSITORY
  GITHUB_OWNER="${GITHUB_REPOSITORY%%/*}"
  GITHUB_REPO="${GITHUB_REPOSITORY#*/}"
else
  require_env GITHUB_APP_ID GITHUB_APP_PRIVATE_KEY GITHUB_OWNER GITHUB_REPO
fi
export ISSUE_ID ISSUE_IDENTIFIER ISSUE_TITLE ISSUE_DESCRIPTION
export GITHUB_OWNER GITHUB_REPO
export PR_NUMBER="${PR_NUMBER:-}"

# Agentica is optional; soft-validate only. If a key is plumbed through, run a
# one-line import smoke test so failures show up here (clear), not deep in a
# user workspace script. python3.12 + symbolica-agentica are baked into the
# runner image; see Dockerfile.session.
if [ -n "${AGENTICA_API_KEY:-}" ]; then
  export AGENTICA_API_KEY
  if python3.12 -c "from agentica import spawn" >/dev/null 2>&1; then
    log "agentica available (python3.12 import OK; AGENTICA_API_KEY set)"
  else
    log "WARN: AGENTICA_API_KEY is set but \`python3.12 -c 'from agentica import spawn'\` failed"
  fi
else
  log "agentica skipped (AGENTICA_API_KEY not set)"
fi

# ── 3. Token acquisition ─────────────────────────────────────────────────────
if [ "$AI_IMPLEMENT_MODE" = "gha" ]; then
  log "Using GITHUB_TOKEN from GHA"
  export GH_TOKEN="$GITHUB_TOKEN"
else
  # shellcheck disable=SC1091
  source "$SCRIPT_DIR/token-refresh.sh"
  GITHUB_TOKEN=$(cat /tmp/github-token)
  export GITHUB_TOKEN
  export GH_TOKEN="$GITHUB_TOKEN"
fi

# ── 4. Git config + clone ────────────────────────────────────────────────────
GITHUB_DEFAULT_BRANCH="${GITHUB_DEFAULT_BRANCH:-main}"
export GITHUB_DEFAULT_BRANCH
git config --global user.name "ai-implement-bot"
git config --global user.email "ai-implement-bot@users.noreply.github.com"
git config --global init.defaultBranch "$GITHUB_DEFAULT_BRANCH"

REPO_URL="https://x-access-token:${GITHUB_TOKEN}@github.com/${GITHUB_OWNER}/${GITHUB_REPO}.git"
log "Cloning ${GITHUB_OWNER}/${GITHUB_REPO}..."
git clone --depth=1 --branch "$GITHUB_DEFAULT_BRANCH" "$REPO_URL" /workspace
cd /workspace
if [ -n "$PR_NUMBER" ]; then
  log "Gap-fill: checking out PR #$PR_NUMBER"
  gh pr checkout "$PR_NUMBER"
  GITHUB_DEFAULT_BRANCH="$(git branch --show-current)"
  export GITHUB_DEFAULT_BRANCH
fi

# ── 5. Workspace ownership for non-root Claude ───────────────────────────────
chown -R coder:coder /workspace
cp /root/.gitconfig /home/coder/.gitconfig 2>/dev/null || true
chown coder:coder /home/coder/.gitconfig 2>/dev/null || true
git config --global --add safe.directory /workspace

# ── 6. Invoke TS pipeline ────────────────────────────────────────────────────
export WORKSPACE_DIR=/workspace
log "Invoking TS pipeline (node /app/dist/run-autonomous.js)..."
exec dbus-run-session -- su -p coder -c "HOME=/home/coder exec node /app/dist/run-autonomous.js"
