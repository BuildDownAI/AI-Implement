#!/bin/bash
# Fetches Linear issue data from the orchestrator's kg-tracker-data proxy and
# writes a merged {"issues":[...]} JSON file to the path given as $1.
# Uses RUNNER_CALLBACK_URL and RUN_PROGRESS_TOKEN from the run env.
#
# Exits 0 with no file written when:
#   - either env var is absent (local ingest path, no callback configured)
#   - the proxy returns 503 (Linear not configured on orchestrator)
# Exits non-zero on unexpected HTTP errors (4xx/5xx other than 503).

set -euo pipefail

OUTPUT_FILE="${1:-}"
if [ -z "$OUTPUT_FILE" ]; then
  echo "[fetch-kg-tracker-data] Usage: fetch-kg-tracker-data.sh <output-file>" >&2
  exit 1
fi

CALLBACK_URL="${RUNNER_CALLBACK_URL:-}"
PROGRESS_TOKEN="${RUN_PROGRESS_TOKEN:-}"

# Strip trailing slashes from callback URL
while [ "${CALLBACK_URL%/}" != "$CALLBACK_URL" ]; do
  CALLBACK_URL="${CALLBACK_URL%/}"
done

# Silent no-op when env vars absent (local ingest path unchanged)
if [ -z "$CALLBACK_URL" ] || [ -z "$PROGRESS_TOKEN" ]; then
  exit 0
fi

ENDPOINT="${CALLBACK_URL}/api/runner/kg-tracker-data"
ALL_ISSUES="[]"
CURSOR=""

TMPOUT=""
trap '[ -n "$TMPOUT" ] && rm -f "$TMPOUT"' EXIT

while true; do
  TMPOUT=$(mktemp)

  if [ -n "$CURSOR" ]; then
    BODY=$(jq -nc --arg cursor "$CURSOR" '{"cursor": $cursor}')
  else
    BODY='{}'
  fi

  HTTP_STATUS=$(curl -s --max-time 30 \
    -o "$TMPOUT" \
    -w '%{http_code}' \
    -X POST \
    -H "Authorization: Bearer $PROGRESS_TOKEN" \
    -H "Content-Type: application/json" \
    -d "$BODY" \
    "$ENDPOINT" 2>/dev/null) || HTTP_STATUS="000"

  if [ "$HTTP_STATUS" = "503" ]; then
    # Linear not configured on orchestrator — skip silently, no file written
    exit 0
  fi

  if [ "$HTTP_STATUS" != "200" ]; then
    echo "[fetch-kg-tracker-data] Unexpected HTTP $HTTP_STATUS from proxy" >&2
    exit 1
  fi

  HTTP_BODY=$(cat "$TMPOUT")
  rm -f "$TMPOUT"
  TMPOUT=""

  PAGE_ISSUES=$(echo "$HTTP_BODY" | jq -c '.issues // []')
  HAS_NEXT_PAGE=$(echo "$HTTP_BODY" | jq -r '.pageInfo.hasNextPage // false')
  END_CURSOR=$(echo "$HTTP_BODY" | jq -r '.pageInfo.endCursor // ""')

  # NOTE: This jq call re-encodes the full accumulated array on every page — O(n²)
  # in total issue count. Acceptable for small teams; the TypeScript pipeline step
  # (src/pipeline/steps/kg-tracker-data.ts) uses Array.push and is O(n).
  ALL_ISSUES=$(jq -nc --argjson a "$ALL_ISSUES" --argjson b "$PAGE_ISSUES" '$a + $b')

  if [ "$HAS_NEXT_PAGE" = "true" ] && [ -n "$END_CURSOR" ]; then
    CURSOR="$END_CURSOR"
  else
    break
  fi
done

TMPOUT=$(mktemp "${OUTPUT_FILE}.XXXXXX")
jq -nc --argjson issues "$ALL_ISSUES" '{"issues": $issues}' > "$TMPOUT"
mv -f "$TMPOUT" "$OUTPUT_FILE"
TMPOUT=""
