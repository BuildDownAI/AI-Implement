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

# Remap per-project Fly secrets to their unprefixed runner-visible names.
#
# Classic Fly app secrets are app-wide: every machine on the sessions app
# receives every classic secret under its stored name (e.g. SAN_QA_PROBE).
# The Machines API processes[].secrets env_var remap applies only to the
# non-GA named-secrets feature and has no effect on classic secrets (confirmed
# 2026-09-03, probe SAN-22 on ai-implement-testing-sessions).
#
# Reads AI_IMPLEMENT_TEAM_SECRET_PREFIX (e.g. "SAN_") and
# AI_IMPLEMENT_ALL_SECRET_NAMES (comma-joined list of all secret names on
# the sessions app, e.g. "SAN_QA_PROBE,ENG_OTHER").
#
# Effect (runs before su -p coder handoff):
#   - Own-team names (prefix match): export <BARE>=<value>; unset <TEAM>_<BARE>
#   - Other-team names: unset (cross-team isolation)
#   - Exports AI_IMPLEMENT_FORWARDED_SECRETS=<comma-joined bare names>
#     Format: "QA_PROBE,DB_URL" — names only, no values. Empty when none.
remap_team_secrets() {
  local prefix="${AI_IMPLEMENT_TEAM_SECRET_PREFIX:-}"
  local all_names="${AI_IMPLEMENT_ALL_SECRET_NAMES:-}"
  if [ -z "$prefix" ] || [ -z "$all_names" ]; then return 0; fi

  local forwarded="" _bare _val _sname
  local -a _names=()
  IFS=',' read -ra _names <<< "$all_names"
  for _sname in "${_names[@]}"; do
    [ -z "$_sname" ] && continue
    if [[ "$_sname" == "${prefix}"* ]]; then
      _bare="${_sname#"${prefix}"}"
      _val="${!_sname:-}"
      export "${_bare}=${_val}"
      unset "${_sname}"
      forwarded="${forwarded:+${forwarded},}${_bare}"
    else
      unset "${_sname}"
    fi
  done
  export AI_IMPLEMENT_FORWARDED_SECRETS="$forwarded"
  log "Remapped team secrets (prefix=${prefix}): ${forwarded:-none}"
}
