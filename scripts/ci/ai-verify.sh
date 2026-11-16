#!/bin/sh
node "$(dirname "$0")/../openrouter-live-check.mjs" || :
# The pipeline parent survives implement passes; fallback for local hook invocations.
export OPENROUTER_LIVE_RUN_ID="${OPENROUTER_LIVE_RUN_ID:-$PPID}"
if command -v npx >/dev/null 2>&1 && npx --no-install tsx --version >/dev/null 2>&1; then
  npx --no-install tsx "$(dirname "$0")/../openrouter-agent-live-check.ts" 2>/dev/null || :
else
  echo 'openrouter-agent-live-check: skipped (tsx not found)'
fi
exit 0
