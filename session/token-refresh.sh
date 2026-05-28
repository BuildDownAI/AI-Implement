#!/usr/bin/env bash
# token-refresh.sh — Acquire a GitHub App installation token.
#
# Reads:  GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, GITHUB_OWNER
# Writes: /tmp/github-token, exports GITHUB_TOKEN and GH_TOKEN
#
# This is a bash port of src/github-app-auth.ts.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib.sh"

require_env GITHUB_APP_ID
require_env GITHUB_APP_PRIVATE_KEY
require_env GITHUB_OWNER

# --- Step 1: Write normalised PEM to temp file ---
# Env vars store the key with literal \n — convert to real newlines.
PEM_FILE=$(mktemp)
trap 'rm -f "$PEM_FILE"' RETURN
printf '%b' "$GITHUB_APP_PRIVATE_KEY" > "$PEM_FILE"

# --- Step 2: Build and sign JWT ---
NOW=$(date +%s)
IAT=$(( NOW - 60 ))   # 60s clock-skew buffer (matches github-app-auth.ts)
EXP=$(( NOW + 600 ))  # 10 min validity

HEADER=$(printf '{"alg":"RS256","typ":"JWT"}' | base64url)
PAYLOAD=$(printf '{"iat":%d,"exp":%d,"iss":"%s"}' "$IAT" "$EXP" "$GITHUB_APP_ID" | base64url)

SIGNING_INPUT="${HEADER}.${PAYLOAD}"
SIGNATURE=$(printf '%s' "$SIGNING_INPUT" | openssl dgst -sha256 -sign "$PEM_FILE" -binary | base64url)

JWT="${SIGNING_INPUT}.${SIGNATURE}"

# --- Step 3: Resolve installation ID for the owner ---
# GitHub Apps can be installed on either an organization or a user account.
# Try /orgs/X/installation first; on 404 (or any failure) fall back to
# /users/X/installation. Only fail hard if both endpoints fail.
log "Fetching installation ID for owner '$GITHUB_OWNER'..."

INSTALL_RESPONSE=$(curl -sf --max-time 30 \
  -H "Authorization: Bearer $JWT" \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  -H "User-Agent: ai-implement-runner" \
  "https://api.github.com/orgs/${GITHUB_OWNER}/installation" 2>/dev/null) || \
INSTALL_RESPONSE=$(curl -sf --max-time 30 \
  -H "Authorization: Bearer $JWT" \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  -H "User-Agent: ai-implement-runner" \
  "https://api.github.com/users/${GITHUB_OWNER}/installation") || \
  fail "GitHub App not installed on owner '$GITHUB_OWNER' (tried both /orgs and /users endpoints)"

INSTALL_ID=$(echo "$INSTALL_RESPONSE" | jq -r '.id')
if [ -z "$INSTALL_ID" ] || [ "$INSTALL_ID" = "null" ]; then
  fail "Could not parse installation ID from response"
fi

# --- Step 4: Exchange for installation access token ---
log "Exchanging for installation token (installation $INSTALL_ID)..."

TOKEN_RESPONSE=$(curl -sf --max-time 30 -X POST \
  -H "Authorization: Bearer $JWT" \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  -H "User-Agent: ai-implement-runner" \
  "https://api.github.com/app/installations/${INSTALL_ID}/access_tokens") \
  || fail "Failed to get installation token for installation $INSTALL_ID"

TOKEN=$(echo "$TOKEN_RESPONSE" | jq -r '.token')
if [ -z "$TOKEN" ] || [ "$TOKEN" = "null" ]; then
  fail "Could not parse token from response"
fi

# --- Step 5: Export token ---
printf '%s' "$TOKEN" > /tmp/github-token
export GITHUB_TOKEN="$TOKEN"
export GH_TOKEN="$TOKEN"

log "GitHub App token acquired successfully"
