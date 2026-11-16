#!/bin/sh
node "$(dirname "$0")/../openrouter-live-check.mjs" 2>/dev/null || true
# The pipeline process survives verify passes; its PID and start record identify
# this run even on a retained machine. No runner bearer is needed by the hook.
if [ -r "/proc/$PPID/stat" ] && [ -r /proc/sys/kernel/random/boot_id ]; then
  OPENROUTER_ACCOUNT_CHECK_RUN_ID="$(cat /proc/sys/kernel/random/boot_id):${PPID}:$(sed 's/.*) //' "/proc/$PPID/stat" | awk '{print $20}')"
  export OPENROUTER_ACCOUNT_CHECK_RUN_ID
fi
if npx --no-install tsx --version >/dev/null 2>&1; then
  npx --no-install tsx "$(dirname "$0")/../openrouter-account-live-check.ts" 2>/dev/null || true
else
  echo 'openrouter-account-live-check: skipped (tsx not found)'
fi
exit 0
