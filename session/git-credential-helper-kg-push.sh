#!/bin/bash
# Git credential helper for kg-refresh push credential.
# Registered for https://github.com in the kg-refresh entrypoint setup so the
# snapshot push step can authenticate without a token embedded in the remote URL.
# Fetches and caches a write-capable token from /api/runner/kg-push-token on
# first use and re-mints it when fewer than 10 minutes remain.
# Exits 0 on every code path — no credentials is always preferable to crashing.

OPERATION="${1:-get}"
[ "$OPERATION" = "get" ] || exit 0

PROTOCOL=""
HOST=""
while IFS= read -r line; do
    [ -z "$line" ] && break
    case "$line" in
        protocol=*) PROTOCOL="${line#protocol=}" ;;
        host=*)     HOST="${line#host=}" ;;
    esac
done

[ "$PROTOCOL" = "https" ] && [ "$HOST" = "github.com" ] || exit 0

TOKEN_FILE="${GIT_KG_PUSH_TOKEN_FILE:-}"
[ -n "$TOKEN_FILE" ] || exit 0

CALLBACK_URL="${RUNNER_CALLBACK_URL:-}"
while [ "${CALLBACK_URL%/}" != "$CALLBACK_URL" ]; do
    CALLBACK_URL="${CALLBACK_URL%/}"
done
PROGRESS_TOKEN="${RUN_PROGRESS_TOKEN:-}"

TOKEN=""
NEEDS_REFRESH=true

if [ -f "$TOKEN_FILE" ]; then
    TOKEN=$(jq -r '.token // empty' "$TOKEN_FILE" 2>/dev/null) || TOKEN=""
    EXPIRES_AT=$(jq -r '.expires_at // empty' "$TOKEN_FILE" 2>/dev/null) || EXPIRES_AT=""

    if [ -n "$TOKEN" ] && [ -n "$EXPIRES_AT" ]; then
        EXPIRY_EPOCH=$(date -d "$EXPIRES_AT" +%s 2>/dev/null || echo "0")
        NOW_EPOCH=$(date +%s)
        MINS_LEFT=$(( (EXPIRY_EPOCH - NOW_EPOCH) / 60 ))
        [ "$MINS_LEFT" -gt 10 ] && NEEDS_REFRESH=false
    fi
fi

if $NEEDS_REFRESH && [ -n "$CALLBACK_URL" ] && [ -n "$PROGRESS_TOKEN" ]; then
    RESPONSE=$(curl -sf --max-time 15 \
        -X POST \
        -H "Authorization: Bearer $PROGRESS_TOKEN" \
        "${CALLBACK_URL}/api/runner/kg-push-token" 2>/dev/null) || true

    if [ -n "$RESPONSE" ]; then
        NEW_TOKEN=$(echo "$RESPONSE" | jq -r '.token // empty' 2>/dev/null) || true
        NEW_EXPIRES=$(echo "$RESPONSE" | jq -r '.expires_at // empty' 2>/dev/null) || true

        if [ -n "$NEW_TOKEN" ] && [ -n "$NEW_EXPIRES" ]; then
            TMP_FILE=$(mktemp "${TOKEN_FILE}.XXXXXX" 2>/dev/null) || TMP_FILE=""
            if [ -n "$TMP_FILE" ]; then
                if jq -n --arg token "$NEW_TOKEN" --arg expires_at "$NEW_EXPIRES" \
                    '{token: $token, expires_at: $expires_at}' > "$TMP_FILE" 2>/dev/null; then
                    mv -f "$TMP_FILE" "$TOKEN_FILE"
                    TOKEN="$NEW_TOKEN"
                else
                    rm -f "$TMP_FILE"
                fi
            fi
        fi
    fi
fi

[ -n "$TOKEN" ] && printf 'username=x-access-token\npassword=%s\n' "$TOKEN"
