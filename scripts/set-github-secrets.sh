#!/usr/bin/env bash
# set-github-secrets.sh — set GitHub Actions secrets for an AI-Implement deployment.
#
# Sets the secrets that the synced workflows (claude-implement.yml and
# claude-plan.yml) need at run time:
#
#   On each TARGET repo (e.g. acme/api):
#     AI_IMPLEMENT_APP_ID         — claude-implement.yml authenticates as the App
#     AI_IMPLEMENT_PRIVATE_KEY    — same
#     CLAUDE_CODE_OAUTH_TOKEN     — runner authenticates Claude Code (preferred)
#       or ANTHROPIC_API_KEY      — fallback Claude auth if no OAuth token
#
# Usage:
#   ./scripts/set-github-secrets.sh <target-repo> [<target-repo>...]
#
# Example:
#   ./scripts/set-github-secrets.sh acme/api acme/web
#
# Sensitive values are read from stdin (-rsp / file path). Nothing is passed
# via argv, so values never appear in shell history or process listings.
#
# Requires: gh CLI (authenticated against an account that can write secrets
# on each repo).

set -euo pipefail

if [ $# -lt 1 ]; then
  cat >&2 <<USAGE
Usage: $0 <target-repo> [<target-repo>...]

Example:
  $0 acme/api acme/web

Each target repo receives the synced workflow templates and runner secrets.
USAGE
  exit 1
fi

TARGET_REPOS=("$@")

# Validate owner/repo format.
for repo in "${TARGET_REPOS[@]}"; do
  if ! echo "$repo" | grep -qE '^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$'; then
    echo "Error: repo must be in 'owner/name' form (got: $repo)" >&2
    exit 1
  fi
done

echo
echo "Will set secrets on:"
for repo in "${TARGET_REPOS[@]}"; do
  echo "  Target:       $repo  (AI_IMPLEMENT_APP_ID, AI_IMPLEMENT_PRIVATE_KEY, CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY)"
done
echo

read -rp  "GitHub App ID (numeric, from https://github.com/settings/apps): " APP_ID
if ! [[ "$APP_ID" =~ ^[0-9]+$ ]]; then
  echo "Error: App ID must be numeric." >&2
  exit 1
fi

read -rp  "Path to GitHub App .pem private key file: " PEM_PATH
if [ ! -f "$PEM_PATH" ]; then
  echo "Error: .pem file not found: $PEM_PATH" >&2
  exit 1
fi

read -rsp "CLAUDE_CODE_OAUTH_TOKEN (preferred; leave blank to use ANTHROPIC_API_KEY): " OAUTH_TOKEN
echo
API_KEY=""
if [ -z "$OAUTH_TOKEN" ]; then
  read -rsp "ANTHROPIC_API_KEY (fallback Claude auth): " API_KEY
  echo
fi

if [ -z "$OAUTH_TOKEN" ] && [ -z "$API_KEY" ]; then
  echo "Error: set either CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY." >&2
  exit 1
fi

# `gh secret set NAME --repo R` reads stdin when no -b/-f flag is passed.
# Using stdin keeps the value out of argv across all gh versions.
set_secret() {
  local repo="$1" name="$2" value="$3"
  printf '%s' "$value" | gh secret set "$name" --repo "$repo" >/dev/null
  echo "  ✓ $repo / $name"
}

set_secret_file() {
  local repo="$1" name="$2" file="$3"
  gh secret set "$name" --repo "$repo" < "$file" >/dev/null
  echo "  ✓ $repo / $name (from $file)"
}

for target in "${TARGET_REPOS[@]}"; do
  echo
  echo "=== Setting secrets on $target (runner auth + Claude) ==="
  set_secret      "$target" AI_IMPLEMENT_APP_ID      "$APP_ID"
  set_secret_file "$target" AI_IMPLEMENT_PRIVATE_KEY "$PEM_PATH"
  if [ -n "$OAUTH_TOKEN" ]; then
    set_secret    "$target" CLAUDE_CODE_OAUTH_TOKEN  "$OAUTH_TOKEN"
  else
    set_secret    "$target" ANTHROPIC_API_KEY        "$API_KEY"
  fi
done

unset OAUTH_TOKEN API_KEY

echo
echo "Done. Verify with:"
for target in "${TARGET_REPOS[@]}"; do
  echo "  gh secret list --repo $target"
done
echo
echo "Now sync workflows for each target from the orchestrator Projects row action,"
echo "POST /api/mappings/:teamKey/sync-workflows, or MCP trigger_workflow_sync."
