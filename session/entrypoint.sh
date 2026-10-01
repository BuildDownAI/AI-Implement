#!/usr/bin/env bash
# entrypoint.sh — Thin bootstrap. All pipeline logic lives in TS at /app/dist.
# Responsibilities: env validation, workspace bootstrap, then exec the
# phase-appropriate TS entry under dbus + non-root.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/lib.sh"
CONFIGURED=0
# on_err logs a fixed message once CONFIGURED=1 (the failing command text can carry secrets).
trap 'on_err "$?" "$LINENO" "$BASH_COMMAND"' ERR
WORKSPACE_DIR="${WORKSPACE_DIR:-/workspace}"
WORKSPACE_MODE="${AI_IMPLEMENT_WORKSPACE_MODE:-cloned}"

# ── 1. Mode detection ────────────────────────────────────────────────────────
if [ "${GITHUB_ACTIONS:-}" = "true" ]; then
  AI_IMPLEMENT_MODE="gha"
else
  AI_IMPLEMENT_MODE="${AI_IMPLEMENT_MODE:-fly}"
fi
log "Execution mode: $AI_IMPLEMENT_MODE"
export AI_IMPLEMENT_MODE

# ── 2. Env validation ────────────────────────────────────────────────────────
# A configured (opted-in) run carries a resolved agent snapshot plus a model-auth bootstrap in
# the envelope; the trusted decoder must accept it before the legacy provider check is skipped.
# Incomplete or malformed configured input fails closed here, before any git/clone/setup, with
# a fixed message and no legacy-credential fallback.
case "$(classify_run_config)" in
  legacy) ;;
  configured) CONFIGURED=1 ;;
  *) fail "Configured model-auth bootstrap is invalid or incomplete" ;;
esac
PROVIDER="${PROVIDER:-anthropic}"
if [ "$CONFIGURED" = "1" ]; then
  log "Configured run: model credentials come from the selected-stage authentication path"
else
  case "$PROVIDER" in
    bedrock) [ "$AI_IMPLEMENT_MODE" = "gha" ] || fail "provider=bedrock is supported only in GHA mode"; require_env AWS_REGION; export CLAUDE_CODE_USE_BEDROCK=1; export CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1 ;;
    anthropic) require_one_of ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN ;;
    *) fail "Unsupported provider: $PROVIDER" ;;
  esac
fi
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
[ -z "${PR_NUMBER:-}" ] && [ -n "${AI_IMPLEMENT_RUN_CONFIG:-}" ] && PR_NUMBER="$(node -e "try{const c=JSON.parse(Buffer.from(process.env.AI_IMPLEMENT_RUN_CONFIG,'base64').toString());process.stdout.write(String(c.prNumber||''))}catch{}" 2>/dev/null||true)"
export PR_NUMBER="${PR_NUMBER:-}"
_kg_r="$(if [ -n "${AI_IMPLEMENT_RUN_CONFIG:-}" ]; then node -e "try{const c=JSON.parse(Buffer.from(process.env.AI_IMPLEMENT_RUN_CONFIG,'base64').toString());process.stdout.write(c.kgSourceRepo||'')}catch{}" 2>/dev/null; fi)"
[ -n "${_kg_r:-}" ] && { GITHUB_OWNER="${_kg_r%%/*}"; GITHUB_REPO="${_kg_r#*/}"; }
# ── 3. Token acquisition ─────────────────────────────────────────────────────
export GH_TOKEN="$GITHUB_TOKEN"

# ── 4. Git config + clone ────────────────────────────────────────────────────
if [ -z "${GITHUB_DEFAULT_BRANCH:-}" ]; then
  if [ -z "${_kg_r:-}" ] && [ -n "${GITHUB_REF_NAME:-}" ]; then
    GITHUB_DEFAULT_BRANCH="${GITHUB_REF_NAME}"
  else
    GITHUB_DEFAULT_BRANCH="$(run_scoped "GH_TOKEN" gh api "repos/${GITHUB_OWNER}/${GITHUB_REPO}" --jq ".default_branch")"
  fi
fi
export GITHUB_DEFAULT_BRANCH
[ -n "${_kg_r:-}" ] && _kg_ref="$(node -e 'try{const c=JSON.parse(Buffer.from(process.env.AI_IMPLEMENT_RUN_CONFIG,"base64").toString());process.stdout.write(c.kgSourceRef||"")}catch(e){}' 2>/dev/null||true)" && [ -n "$_kg_ref" ] && { log "run_config.kgSourceRef=${_kg_ref}"; GITHUB_DEFAULT_BRANCH="$_kg_ref"; export GITHUB_DEFAULT_BRANCH; }
[ -z "${PR_NUMBER:-}" ] && [ -n "${AI_IMPLEMENT_RUN_CONFIG:-}" ] && _rb="$(node -e 'try{const c=JSON.parse(Buffer.from(process.env.AI_IMPLEMENT_RUN_CONFIG,"base64").toString());process.stdout.write(c.baseBranch||"")}catch(e){}' 2>/dev/null||true)" && [ -n "$_rb" ] && { log "run_config.baseBranch=${_rb}"; GITHUB_DEFAULT_BRANCH="$_rb"; }
run_scoped "" git config --global user.name "ai-implement-bot"
run_scoped "" git config --global user.email "ai-implement-bot@users.noreply.github.com"
run_scoped "" git config --global init.defaultBranch "$GITHUB_DEFAULT_BRANCH"

if [ "$WORKSPACE_MODE" = "mounted" ]; then
  log "Using bind-mounted workspace at $WORKSPACE_DIR"
  run_scoped "" git config --global --add safe.directory "$WORKSPACE_DIR"
  cd "$WORKSPACE_DIR"
else
  log "Cloning ${GITHUB_OWNER}/${GITHUB_REPO}..."
  if [ "$CONFIGURED" = "1" ]; then
    configure_scoped_git_auth
    git_authed clone --depth=1 --branch "$GITHUB_DEFAULT_BRANCH" "https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}.git" "$WORKSPACE_DIR"
  else
    REPO_URL="https://x-access-token:${GITHUB_TOKEN}@github.com/${GITHUB_OWNER}/${GITHUB_REPO}.git"
    git clone --depth=1 --branch "$GITHUB_DEFAULT_BRANCH" "$REPO_URL" "$WORKSPACE_DIR"
  fi
  run_scoped "" git config --global --add safe.directory "$WORKSPACE_DIR"
  cd "$WORKSPACE_DIR"
  if [ -n "$PR_NUMBER" ]; then
    log "Gap-fill: checking out PR #$PR_NUMBER"
    run_scoped "" git config --replace-all remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'
    run_scoped "GH_TOKEN" gh pr checkout "$PR_NUMBER"
    GITHUB_DEFAULT_BRANCH="$(run_scoped "" git branch --show-current)"
    export GITHUB_DEFAULT_BRANCH
  fi
fi

# ── 5. Workspace ownership for non-root Claude ───────────────────────────────
if [ "$WORKSPACE_MODE" = "mounted" ]; then
  prepare_coder_identity "${AI_IMPLEMENT_HOST_UID:-}" "${AI_IMPLEMENT_HOST_GID:-}"
  verify_workspace_writable "$WORKSPACE_DIR"
else
  chown -R coder:coder "$WORKSPACE_DIR"
fi
cp /root/.gitconfig /home/coder/.gitconfig 2>/dev/null || true
chown coder:coder /home/coder/.gitconfig 2>/dev/null || true

# ── 5.5. Remap per-team Fly secrets ─────────────────────────────────────────
remap_team_secrets

# ── 6. Invoke TS pipeline ────────────────────────────────────────────────────
export WORKSPACE_DIR
RUNNER_PHASE_SOURCE="env"
[ -z "${RUNNER_PHASE:-}" ] && RUNNER_PHASE_SOURCE="default"
resolve_envelope_field RUNNER_PHASE runnerPhase
[ "$RUNNER_PHASE_SOURCE" = "default" ] && [ -n "${RUNNER_PHASE:-}" ] && RUNNER_PHASE_SOURCE="envelope"
resolve_envelope_field RUNNER_CALLBACK_URL runnerCallbackUrl
RUNNER_PHASE="${RUNNER_PHASE:-implementation}"
export RUNNER_PHASE
# Managed gap-analysis is an implementation run with PR_NUMBER set, so it uses the default entry.
RUNNER_ENTRY="$(select_runner_entry "$RUNNER_PHASE")"
[ "$RUNNER_PHASE" = "kg-refresh" ] && export RUNNER_CALLBACK_URL RUN_PROGRESS_TOKEN
log "Invoking TS pipeline (node /app/dist/$RUNNER_ENTRY, phase=$RUNNER_PHASE, source=$RUNNER_PHASE_SOURCE)..."
exec dbus-run-session -- su -p coder -c "HOME=/home/coder exec node /app/dist/$RUNNER_ENTRY"
