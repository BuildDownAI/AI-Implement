#!/usr/bin/env bash
# lib.sh — Shared utilities for session scripts
set -euo pipefail

log() {
  echo "[session] $(date -u +%Y-%m-%dT%H:%M:%SZ) $*"
}

fail() {
  log "FATAL: $*" >&2
  exit 1
}

# Require one or more environment variables to be set and non-empty.
# Usage: require_env VAR_NAME [VAR_NAME ...]
require_env() {
  for var_name in "$@"; do
    if [ -z "${!var_name:-}" ]; then
      fail "Required environment variable $var_name is not set"
    fi
  done
}

# Require at least one of the given environment variables to be set.
# Usage: require_one_of VAR_A VAR_B [VAR_C ...]
require_one_of() {
  for var in "$@"; do
    if [ -n "${!var:-}" ]; then return 0; fi
  done
  fail "At least one of $* must be set"
}

# Match the non-root runner account to the owner of a host bind mount without
# recursively changing ownership of the host checkout.
prepare_coder_identity() {
  local host_uid="$1" host_gid="$2" host_group
  [[ "$host_uid" =~ ^[1-9][0-9]*$ ]] || fail "AI_IMPLEMENT_HOST_UID must be a positive integer"
  [[ "$host_gid" =~ ^[1-9][0-9]*$ ]] || fail "AI_IMPLEMENT_HOST_GID must be a positive integer"
  host_group="$(getent group "$host_gid" | cut -d: -f1 || true)"
  if [ -n "$host_group" ]; then
    usermod -g "$host_group" coder
  else
    groupmod -o -g "$host_gid" coder
  fi
  usermod -o -u "$host_uid" coder
  chown -R coder:"$(id -gn coder)" /home/coder
}

# Verify that coder can create and remove a file in the bind-mounted workspace.
# Call this after prepare_coder_identity has adopted the host UID/GID.
# Stops the run on failure and reports the path, detected ownership, and adopted identity.
verify_workspace_writable() {
  local workspace_dir="$1"
  local coder_uid coder_gid ws_uid ws_gid
  coder_uid="$(id -u coder)"
  coder_gid="$(id -g coder)"
  ws_uid="$(stat -c '%u' "$workspace_dir" 2>/dev/null || stat -f '%u' "$workspace_dir" 2>/dev/null || echo '?')"
  ws_gid="$(stat -c '%g' "$workspace_dir" 2>/dev/null || stat -f '%g' "$workspace_dir" 2>/dev/null || echo '?')"
  # workspace_dir is passed as $1 to the child shell — never interpolated into the
  # -c program text — so shell-significant characters in the path cannot become
  # executable code.  mktemp generates a collision-safe name; _cleanup_probe removes
  # the probe by variable reference rather than embedding the path in an evaluated
  # trap string, so shell-significant characters in the probe path remain data.
  # shellcheck disable=SC2016
  if su coder -s /bin/bash -c '
    probe="$(mktemp "$1/.ai-implement-probe.XXXXXX")" || exit 1
    _cleanup_probe() { rm -f -- "$probe"; }
    trap _cleanup_probe EXIT
  ' -- _ "$workspace_dir" 2>/dev/null; then
    return 0
  fi
  fail "Cannot write to bind-mounted workspace $workspace_dir (owner $ws_uid:$ws_gid, coder UID $coder_uid GID $coder_gid). Verify AI_IMPLEMENT_HOST_UID/AI_IMPLEMENT_HOST_GID match the host directory owner. On macOS Docker Desktop, confirm file sharing is enabled — the mount may be read-only."
}

# Returns 0 (true) if the bare secret name would overwrite an orchestrator-
# owned environment variable and must not be exported by remap_team_secrets.
# Matches all GITHUB_*, ISSUE_*, and AI_IMPLEMENT_* prefixes plus the exact
# orchestrator vars set by buildSessionMachineConfig in src/fly-machines.ts.
_remap_is_reserved() {
  case "$1" in
    GITHUB_*|ISSUE_*|AI_IMPLEMENT_*) return 0 ;;
    ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|SESSION_TOKEN|MACHINE_NONCE) return 0 ;;
    RUN_TOKEN|ORCHESTRATOR_URL|RUNNER_CALLBACK_URL|WORKSPACE_DIR|PATH|HOME) return 0 ;;
  esac
  return 1
}

# Remap per-project Fly secrets to their unprefixed runner-visible names.
#
# Classic Fly app secrets are app-wide: every machine on the sessions app
# receives every classic secret under its stored name (e.g. SAN_QA_PROBE).
# The Machines API processes[].secrets env_var remap applies only to the
# non-GA named-secrets feature and has no effect on classic secrets (confirmed
# 2026-09-03, probe SAN-22 on ai-implement-testing-sessions).
#
# Reads:
#   AI_IMPLEMENT_TEAM_SECRET_PREFIX  — own-team prefix, e.g. "SAN_"
#   AI_IMPLEMENT_FOREIGN_SECRET_NAMES — comma-joined names from other teams,
#       e.g. "ENG_DB_URL,QA_OTHER". Global machine secrets (no team prefix)
#       are absent from this list and pass through unchanged.
#
# Effect (runs before su -p coder handoff):
#   - Own-team names (prefix match via env scan): export <BARE>=<value>;
#     unset <TEAM>_<BARE>. Reserved names (_remap_is_reserved) are unset
#     but not exported.
#   - Foreign-team names (AI_IMPLEMENT_FOREIGN_SECRET_NAMES): unset.
#   - Global secrets (not in either category): untouched.
#   - Exports AI_IMPLEMENT_FORWARDED_SECRETS=<comma-joined bare names>
#     Format: "QA_PROBE,DB_URL" — names only, no values. Empty when none.
remap_team_secrets() {
  local prefix="${AI_IMPLEMENT_TEAM_SECRET_PREFIX:-}"
  if [ -z "$prefix" ]; then return 0; fi

  local forwarded="" _bare _val _sname
  # Remap own-team secrets: scan the environment for vars with the own-team
  # prefix, export them under their bare name, and unset the prefixed form.
  while IFS= read -r _sname; do
    [ -z "$_sname" ] && continue
    _bare="${_sname#"${prefix}"}"
    if _remap_is_reserved "$_bare"; then
      log "WARNING: Skipping reserved secret name ${_bare} (stored as ${_sname}) — would overwrite orchestrator-managed env var"
      unset "${_sname}"
      continue
    fi
    _val="${!_sname:-}"
    export "${_bare}=${_val}"
    unset "${_sname}"
    forwarded="${forwarded:+${forwarded},}${_bare}"
  done < <(compgen -v | grep "^${prefix}" || true)

  # Unset foreign-team secrets. Global secrets (no team prefix) are not listed
  # here and pass through unchanged.
  local foreign_names="${AI_IMPLEMENT_FOREIGN_SECRET_NAMES:-}"
  if [ -n "$foreign_names" ]; then
    local -a _fnames=()
    IFS=',' read -ra _fnames <<< "$foreign_names"
    for _sname in "${_fnames[@]}"; do
      [ -z "$_sname" ] && continue
      unset "${_sname}" 2>/dev/null || true
    done
  fi

  export AI_IMPLEMENT_FORWARDED_SECRETS="$forwarded"
  log "Remapped team secrets (prefix=${prefix}): ${forwarded:-none}"
}

# Install the kg-push git credential helper for kg-refresh runs.
# Call this after the coder gitconfig has been written (step 5 copy).
# Sets GIT_KG_PUSH_TOKEN_FILE, registers the helper in coder's gitconfig,
# and removes the embedded token from the origin remote URL so the helper
# is consulted on git push.
#
# Guard: if RUNNER_CALLBACK_URL or RUN_PROGRESS_TOKEN is absent the helper
# cannot fetch a write token anyway. In that case the function logs one line
# and returns 0 so the entrypoint always reaches the pipeline exec — it must
# never set -e-exit before `exec node` runs.
setup_kg_push_credential() {
  if [ -z "${RUNNER_CALLBACK_URL:-}" ] || [ -z "${RUN_PROGRESS_TOKEN:-}" ]; then
    log "setup_kg_push_credential: RUNNER_CALLBACK_URL or RUN_PROGRESS_TOKEN not set; skipping credential setup"
    return 0
  fi
  local token_file="/tmp/ai-implement-kg-push-$$.json"
  export GIT_KG_PUSH_TOKEN_FILE="$token_file"
  # Create an empty file owned by coder so the helper can read and update it.
  touch "$token_file" || true
  chown coder:coder "$token_file" || true
  chmod 600 "$token_file" || true
  # Register helper in coder's gitconfig (root's copy was already written at step 5).
  git config --file /home/coder/.gitconfig credential.https://github.com.helper /opt/ai-implement/git-credential-helper-kg-push.sh
  # Remove the embedded token from origin so git consults the helper for push.
  # shellcheck disable=SC2153
  git -C "$WORKSPACE_DIR" remote set-url origin "https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}.git"
}
