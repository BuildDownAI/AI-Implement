#!/usr/bin/env bash
# set-github-secrets.sh — set GitHub Actions secrets for an AI-Implement deployment.
#
# Sets the secrets that the synced workflows (claude-implement.yml, claude-plan.yml,
# comment-trigger.yml, sync-workflow.yml) need at run time:
#
#   On the ORCHESTRATOR repo (this fork of AI-Implement):
#     AI_IMPLEMENT_APP_ID         — sync-workflow.yml authenticates the GitHub App
#     AI_IMPLEMENT_PRIVATE_KEY    — same
#
#   On each TARGET repo (e.g. acme/api):
#     AI_IMPLEMENT_APP_ID         — claude-implement.yml authenticates as the App
#     AI_IMPLEMENT_PRIVATE_KEY    — same
#     LINEAR_API_KEY              — runner posts status back to Linear
#     CLAUDE_CODE_OAUTH_TOKEN     — runner authenticates Claude Code (preferred)
#
# Usage:
#   ./scripts/set-github-secrets.sh <orchestrator-repo> <target-repo> [<target-repo>...]
#
# Example:
#   ./scripts/set-github-secrets.sh acme/ai-implement acme/api acme/web
#
# Sensitive values are read from stdin (-rsp / file path). Nothing is passed
# via argv, so values never appear in shell history or process listings.
#
# Requires: gh CLI (authenticated against an account that can write secrets
# on each repo).

set -euo pipefail

if [ $# -lt 2 ]; then
  cat >&2 <<USAGE
Usage: $0 <orchestrator-repo> <target-repo> [<target-repo>...]

Example:
  $0 acme/ai-implement acme/api acme/web

The orchestrator repo is the fork of AI-Implement. Each target repo
receives the synced workflow templates and runner secrets.
USAGE
  exit 1
fi

ORCH_REPO="$1"
shift
TARGET_REPOS=("$@")

# Validate owner/repo format.
for repo in "$ORCH_REPO" "${TARGET_REPOS[@]}"; do
  if ! echo "$repo" | grep -qE '^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$'; then
    echo "Error: repo must be in 'owner/name' form (got: $repo)" >&2
    exit 1
  fi
done

echo
echo "Will set secrets on:"
echo "  Orchestrator: $ORCH_REPO  (AI_IMPLEMENT_APP_ID, AI_IMPLEMENT_PRIVATE_KEY)"
for repo in "${TARGET_REPOS[@]}"; do
  echo "  Target:       $repo  (AI_IMPLEMENT_APP_ID, AI_IMPLEMENT_PRIVATE_KEY, LINEAR_API_KEY, CLAUDE_CODE_OAUTH_TOKEN)"
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

read -rsp "LINEAR_API_KEY (lin_api_...): " LINEAR_KEY
echo
read -rsp "CLAUDE_CODE_OAUTH_TOKEN: " OAUTH_TOKEN
echo

if [ -z "$LINEAR_KEY" ] || [ -z "$OAUTH_TOKEN" ]; then
  echo "Error: empty value for LINEAR_API_KEY or CLAUDE_CODE_OAUTH_TOKEN." >&2
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

echo
echo "=== Setting secrets on $ORCH_REPO (sync-workflow.yml auth) ==="
set_secret      "$ORCH_REPO" AI_IMPLEMENT_APP_ID      "$APP_ID"
set_secret_file "$ORCH_REPO" AI_IMPLEMENT_PRIVATE_KEY "$PEM_PATH"

for target in "${TARGET_REPOS[@]}"; do
  echo
  echo "=== Setting secrets on $target (runner auth + Linear + Claude) ==="
  set_secret      "$target" AI_IMPLEMENT_APP_ID      "$APP_ID"
  set_secret_file "$target" AI_IMPLEMENT_PRIVATE_KEY "$PEM_PATH"
  set_secret      "$target" LINEAR_API_KEY           "$LINEAR_KEY"
  set_secret      "$target" CLAUDE_CODE_OAUTH_TOKEN  "$OAUTH_TOKEN"
done

unset LINEAR_KEY OAUTH_TOKEN

echo
echo "Done. Verify with:"
echo "  gh secret list --repo $ORCH_REPO"
for target in "${TARGET_REPOS[@]}"; do
  echo "  gh secret list --repo $target"
done
echo
echo "Now dispatch the sync workflow per target repo:"
for target in "${TARGET_REPOS[@]}"; do
  echo "  gh workflow run sync-workflow.yml --repo $ORCH_REPO -f target_repo=$target"
done
