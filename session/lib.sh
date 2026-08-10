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

# Make a bind-mounted workspace writable by `coder` without changing its ownership:
# move coder onto the mount's uid/gid rather than chown-ing the host's files.
# Usage: adopt_workspace_ownership <dir>
adopt_workspace_ownership() {
  local dir="$1" uid gid
  uid="$(stat -c %u "$dir")"
  gid="$(stat -c %g "$dir")"

  # uid 0 means the mount presents as root-owned; re-numbering coder to 0 would
  # defeat the non-root requirement, so leave it and let the probe decide.
  if [ "$uid" != "0" ] && [ "$uid" != "$(id -u coder)" ]; then
    # -o permits a uid/gid another image user already holds (base image: node=1000).
    groupmod -o -g "$gid" coder 2>/dev/null || true
    usermod -o -u "$uid" -g "$gid" coder
    log "Adopted workspace ownership: coder is now ${uid}:${gid}"
  fi

  su -p coder -c "touch '$dir/.ai-implement-write-probe' && rm -f '$dir/.ai-implement-write-probe'" \
    || fail "coder cannot write the mounted workspace at $dir (owned ${uid}:${gid}). Run the harness as the owner of that directory, or check your Docker file-sharing settings."
}
