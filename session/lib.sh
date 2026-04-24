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

# Require a single environment variable to be set and non-empty.
# Usage: require_env VAR_NAME
require_env() {
  local var_name="$1"
  if [ -z "${!var_name:-}" ]; then
    fail "Required environment variable $var_name is not set"
  fi
}

# Require at least one of two environment variables to be set.
# Usage: require_one_of VAR_A VAR_B
require_one_of() {
  local var_a="$1" var_b="$2"
  if [ -z "${!var_a:-}" ] && [ -z "${!var_b:-}" ]; then
    fail "At least one of $var_a or $var_b must be set"
  fi
}

# Base64url encode from stdin (no padding, URL-safe alphabet).
base64url() {
  openssl base64 -e -A | tr '+/' '-_' | tr -d '='
}
