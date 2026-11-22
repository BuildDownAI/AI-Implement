#!/usr/bin/env bash
set -euo pipefail

suite=all
if (( $# > 1 )); then
  echo 'Usage: npm run test:docker -- [unit|restate]' >&2
  exit 1
fi
if (( $# == 1 )); then
  case "$1" in
    unit|restate) suite=$1 ;;
    *) echo "Unknown suite: $1. Expected unit or restate." >&2; exit 1 ;;
  esac
fi
if ! command -v docker >/dev/null 2>&1; then
  echo 'Docker is required. Install and start Docker before running test:docker.' >&2
  exit 1
fi

# Resolve from this script, so invoking it outside the repository also works.
repo=$(cd -- "${BASH_SOURCE[0]%/*}/.." && pwd -P)
if [[ ! -d "$repo/.git" ]]; then
  echo 'test:docker requires a checkout with a .git directory; linked worktrees are not supported. Use a regular clone.' >&2
  exit 1
fi
image='node:24.15.0-slim@sha256:4e6b70dd6cbfc88c8157ba19aa3d9f9cce6ba4703576d55459e45efcbc9c5f5d'

# No host environment, credentials, dependency directories or writable mounts.
exec docker run --rm -i \
  --mount "type=bind,source=$repo,target=/source,readonly" \
  "$image" bash -s -- "$suite" <<'CONTAINER'
set -euo pipefail
apt-get update
apt-get install -y --no-install-recommends git jq shellcheck python3 make g++
for tool in git jq shellcheck python3 make g++ bash sh tar runuser; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "Missing required tool: $tool" >&2
    exit 1
  fi
done
mkdir /workspace
# Include ignored/untracked files and .git; preserve mtimes (including the index).
tar --format=posix -C /source --exclude=node_modules -cf - . | tar -C /workspace -xpf -
chown -R node:node /workspace
cd /workspace
exec runuser -u node -- bash -s -- "$1" <<'TESTS'
set -euo pipefail
run_step() {
  local status
  if "$@"; then
    printf 'PASS: %s\n' "$*"
  else
    status=$?
    printf 'FAIL: %s (exit %s)\n' "$*" "$status" >&2
    exit "$status"
  fi
}
run_step npm ci
if [[ "$1" != restate ]]; then
  run_step npm test
  run_step npm run typecheck
fi
if [[ "$1" != unit ]]; then
  run_step npm run test:restate
fi
TESTS
CONTAINER
