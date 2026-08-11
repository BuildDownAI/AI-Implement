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
