#!/bin/bash
# Git credential helper for dependency-auth sibling-repo access.
# Registered globally for https://github.com by the dependency-auth pipeline step.
# Provides a short-lived installation token so composer/git can reach private
# sibling repos.  Exits 0 on every code path — no credentials returned is always
# preferable to crashing and aborting a git operation.
#
# Safety: clone.ts and push.ts embed credentials directly in the remote URL
# (https://x-access-token:<token>@github.com/…).  Git never consults a
# credential helper when the URL already contains a userinfo component, so this
# helper is ONLY called for unauthenticated https://github.com requests (i.e.
# private sibling-repo clones triggered by composer or other tools).

OPERATION="${1:-get}"
[ "$OPERATION" = "get" ] || exit 0

# Parse the key=value block git sends on stdin (terminated by a blank line).
PROTOCOL=""
HOST=""
while IFS= read -r line; do
    [ -z "$line" ] && break
    case "$line" in
        protocol=*) PROTOCOL="${line#protocol=}" ;;
        host=*)     HOST="${line#host=}" ;;
    esac
done

# Only handle HTTPS requests for github.com; fall through for everything else.
[ "$PROTOCOL" = "https" ] && [ "$HOST" = "github.com" ] || exit 0

TOKEN_FILE="${GIT_DEPENDENCY_TOKEN_FILE:-}"
if [ -z "$TOKEN_FILE" ] || [ ! -f "$TOKEN_FILE" ]; then
    # Feature is off or the cache file was removed — exit without credentials.
    exit 0
fi

TOKEN=$(jq -r '.token // empty' "$TOKEN_FILE" 2>/dev/null) || exit 0
[ -n "$TOKEN" ] || exit 0

EXPIRES_AT=$(jq -r '.expires_at // empty' "$TOKEN_FILE" 2>/dev/null) || true

# Refresh when fewer than 10 minutes remain on the cached token.
#
# expires_at is GitHub's real token expiry, passed through verbatim by the
# vending endpoint, which also force-mints on every vend — so a fresh token
# always arrives with its full (~60-minute) lifetime and the 10-minute margin
# holds even if GitHub ever shortens token lifetimes.
CALLBACK_URL="${GIT_DEPENDENCY_CALLBACK_URL:-}"
# Treat this environment value as untrusted input. Normalize all trailing
# slashes so appending the exact route can never produce a double-slash path.
while [ "${CALLBACK_URL%/}" != "$CALLBACK_URL" ]; do
    CALLBACK_URL="${CALLBACK_URL%/}"
done
PROGRESS_TOKEN="${RUN_PROGRESS_TOKEN:-}"

if [ -n "$EXPIRES_AT" ] && [ -n "$CALLBACK_URL" ] && [ -n "$PROGRESS_TOKEN" ]; then
    EXPIRY_EPOCH=$(date -d "$EXPIRES_AT" +%s 2>/dev/null || echo "0")
    NOW_EPOCH=$(date +%s)
    MINS_LEFT=$(( (EXPIRY_EPOCH - NOW_EPOCH) / 60 ))

    if [ "$MINS_LEFT" -le 10 ]; then
        RESPONSE=$(curl -sf --max-time 10 \
            -X POST \
            -H "Authorization: Bearer $PROGRESS_TOKEN" \
            "${CALLBACK_URL}/api/runner/dependency-token" 2>/dev/null) || true

        if [ -n "$RESPONSE" ]; then
            NEW_TOKEN=$(echo "$RESPONSE" | jq -r '.token // empty' 2>/dev/null) || true
            NEW_EXPIRES=$(echo "$RESPONSE" | jq -r '.expires_at // empty' 2>/dev/null) || true

            if [ -n "$NEW_TOKEN" ] && [ -n "$NEW_EXPIRES" ]; then
                # git spawns one helper process per credential request, so parallel
                # fetches can read this file while we replace it — write to a temp
                # file in the same directory and rename so a reader never sees a
                # truncated cache.  jq builds the JSON so a value containing quotes
                # or backslashes cannot wedge the cache with unparseable content.
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
fi

printf 'username=x-access-token\npassword=%s\n' "$TOKEN"
