#!/usr/bin/env bash
# provision-client.sh — Interactive script to onboard a new client.
#
# Usage: ./scripts/provision-client.sh <client-slug>
#
# What it does:
#   1. Creates a client config file at clients/<slug>.toml
#   2. Creates a Fly.io app and volume
#   3. Sets all required Fly secrets interactively
#   4. Prints instructions for adding the GitHub secret FLY_API_TOKEN_<SLUG>
#
# Requirements: flyctl, jq (optional)

set -euo pipefail

SLUG="${1:-}"
if [ -z "$SLUG" ]; then
  echo "Usage: $0 <client-slug>"
  echo "  slug must be lowercase letters, digits, and hyphens (e.g. acme-corp)"
  exit 1
fi

# Validate slug format
if ! echo "$SLUG" | grep -qE '^[a-z0-9][a-z0-9-]*[a-z0-9]$'; then
  echo "Error: slug must contain only lowercase letters, digits, and hyphens, and cannot start/end with a hyphen."
  exit 1
fi

CONFIG_FILE="clients/${SLUG}.toml"

echo ""
echo "=== Provisioning client: $SLUG ==="
echo ""

# ---------- 1. Config file ----------

if [ -f "$CONFIG_FILE" ]; then
  echo "Config file $CONFIG_FILE already exists, skipping creation."
else
  read -rp "Fly.io app name [ai-implement-${SLUG}]: " APP_NAME
  APP_NAME="${APP_NAME:-ai-implement-${SLUG}}"

  read -rp "Fly.io org slug [personal]: " FLY_ORG
  FLY_ORG="${FLY_ORG:-personal}"

  read -rp "Primary region [iad]: " REGION
  REGION="${REGION:-iad}"

  # Prompt for sessions config
  read -rp "Sessions Fly.io org (for session machines) [${FLY_ORG}]: " SESSIONS_ORG
  SESSIONS_ORG="${SESSIONS_ORG:-$FLY_ORG}"

  read -rp "Sessions app name [ai-implement-sessions-${SLUG}]: " SESSIONS_APP
  SESSIONS_APP="${SESSIONS_APP:-ai-implement-sessions-${SLUG}}"

  read -rp "Sessions region [${REGION}]: " SESSIONS_REGION
  SESSIONS_REGION="${SESSIONS_REGION:-$REGION}"

  cat > "$CONFIG_FILE" <<TOML
[client]
slug = "$SLUG"

[fly]
app_name = "$APP_NAME"
org = "$FLY_ORG"
region = "$REGION"

[sessions]
app_name = "$SESSIONS_APP"
org = "$SESSIONS_ORG"
region = "$SESSIONS_REGION"
TOML
  echo "Created $CONFIG_FILE"
fi

# Read values from config (section-aware parsing)
APP_NAME=$(awk '/^\[fly\]/,/^\[/' "$CONFIG_FILE" | grep 'app_name' | head -1 | sed 's/.*= *//' | tr -d '"')
FLY_ORG=$(awk '/^\[fly\]/,/^\[/' "$CONFIG_FILE" | grep 'org ' | head -1 | sed 's/.*= *//' | tr -d '"')
REGION=$(awk '/^\[fly\]/,/^\[/' "$CONFIG_FILE" | grep 'region' | head -1 | sed 's/.*= *//' | tr -d '"')

SESSIONS_APP=$(awk '/^\[sessions\]/,/^\[/' "$CONFIG_FILE" | grep 'app_name' | head -1 | sed 's/.*= *//' | tr -d '"')
SESSIONS_ORG=$(awk '/^\[sessions\]/,/^\[/' "$CONFIG_FILE" | grep 'org ' | head -1 | sed 's/.*= *//' | tr -d '"')
SESSIONS_REGION=$(awk '/^\[sessions\]/,/^\[/' "$CONFIG_FILE" | grep 'region' | head -1 | sed 's/.*= *//' | tr -d '"')

# Fallback defaults if [sessions] section is missing
SESSIONS_APP="${SESSIONS_APP:-ai-implement-sessions-${SLUG}}"
SESSIONS_ORG="${SESSIONS_ORG:-$FLY_ORG}"
SESSIONS_REGION="${SESSIONS_REGION:-$REGION}"

echo ""
echo "Orchestrator: $APP_NAME | Org: $FLY_ORG | Region: $REGION"
echo "Sessions:     $SESSIONS_APP | Org: $SESSIONS_ORG | Region: $SESSIONS_REGION"
echo ""

# ---------- 2. Fly app + volume ----------

if flyctl status --app "$APP_NAME" &>/dev/null; then
  echo "Fly app '$APP_NAME' already exists, skipping creation."
else
  echo "--> Creating Fly app: $APP_NAME"
  flyctl apps create "$APP_NAME" --org "$FLY_ORG"
fi

# Check if volume exists
if flyctl volumes list --app "$APP_NAME" 2>/dev/null | grep -q "dedup_data"; then
  echo "Volume 'dedup_data' already exists for $APP_NAME, skipping."
else
  echo "--> Creating volume 'dedup_data' (1 GB) in $REGION"
  flyctl volumes create dedup_data --size 1 --region "$REGION" --app "$APP_NAME" --yes
fi

# ---------- 3. Sessions app ----------

if flyctl status --app "$SESSIONS_APP" &>/dev/null; then
  echo "Sessions app '$SESSIONS_APP' already exists, skipping creation."
else
  echo "--> Creating sessions app: $SESSIONS_APP (org: $SESSIONS_ORG)"
  flyctl apps create "$SESSIONS_APP" --org "$SESSIONS_ORG"
fi

# ---------- 4. Fly secrets ----------

echo ""
echo "=== Set Fly secrets for $APP_NAME ==="

# Fetch the names of secrets already set on the app (values are never returned by the API).
# `flyctl secrets list` outputs a table; skip the header row and grab the first column.
EXISTING_SECRETS=$(flyctl secrets list --app "$APP_NAME" 2>/dev/null \
  | awk 'NR>1 && $1!="" {print $1}' || echo "")

is_set() {
  echo "$EXISTING_SECRETS" | grep -qx "$1"
}

hint() {
  local KEY="$1"
  if is_set "$KEY"; then echo " [already set — Enter to keep]"; else echo " [required]"; fi
}

echo "Secrets already set on this app will show '[already set — Enter to keep]'."
echo "Press Enter to leave them unchanged."
echo ""

# Read a plain secret (single-line, hidden input).
# If the app already has the key and the user hits Enter, skip it.
# If the app does NOT have the key and the user hits Enter, exit with error (required=true).
read_secret() {
  local KEY="$1"
  local LABEL="$2"
  local REQUIRED="${3:-false}"
  local VALUE
  read -rsp "${LABEL}$(hint "$KEY"): " VALUE
  echo ""
  if [ -z "$VALUE" ]; then
    if ! is_set "$KEY" && [ "$REQUIRED" = "true" ]; then
      echo "Error: $KEY is required."
      exit 1
    fi
    [ -z "$VALUE" ] && return  # keep existing
  fi
  flyctl secrets set "${KEY}=${VALUE}" --app "$APP_NAME"
}

# Private key: accept a file path (multi-line PEM can't be pasted into a prompt).
# If already set and the user hits Enter, skip it.
read_private_key() {
  local already_set_hint
  if is_set "GITHUB_APP_PRIVATE_KEY"; then
    already_set_hint=" [already set — Enter to keep]"
  else
    already_set_hint=" [required — path to .pem file]"
  fi

  local PEM_PATH
  read -rp "GITHUB_APP_PRIVATE_KEY — path to .pem file${already_set_hint}: " PEM_PATH

  if [ -z "$PEM_PATH" ]; then
    if ! is_set "GITHUB_APP_PRIVATE_KEY"; then
      echo "Error: GITHUB_APP_PRIVATE_KEY is required."
      exit 1
    fi
    echo "  Keeping existing GITHUB_APP_PRIVATE_KEY."
    return
  fi

  if [ ! -f "$PEM_PATH" ]; then
    echo "Error: file not found: $PEM_PATH"
    exit 1
  fi
  local VALUE
  VALUE=$(cat "$PEM_PATH")
  flyctl secrets set "GITHUB_APP_PRIVATE_KEY=${VALUE}" --app "$APP_NAME"
  echo "  Set GITHUB_APP_PRIVATE_KEY from $PEM_PATH"
}

read_secret "LINEAR_API_KEY"             "LINEAR_API_KEY (lin_api_...)" "true"
read_secret "GITHUB_APP_ID"              "GITHUB_APP_ID (numeric)" "true"
read_private_key
read_secret "CLAUDE_CODE_OAUTH_TOKEN"    "CLAUDE_CODE_OAUTH_TOKEN (preferred auth for Claude Code, optional)"
read_secret "ANTHROPIC_API_KEY"          "ANTHROPIC_API_KEY (fallback if no OAuth token, optional)"
read_secret "ADMIN_ACCESS_CODE"          "ADMIN_ACCESS_CODE (admin UI password, optional)"
read_secret "NOTIFY_TYPE"                "NOTIFY_TYPE (slack or teams, default: slack)"
read_secret "NOTIFY_WEBHOOK_URL"         "NOTIFY_WEBHOOK_URL (optional)"

echo ""
echo "=== Session machine secrets for $APP_NAME ==="
echo ""
echo "FLY_SESSIONS_APP will be set to: $SESSIONS_APP"
if is_set "FLY_SESSIONS_APP"; then
  echo "  (already set — will update)"
fi
flyctl secrets set "FLY_SESSIONS_APP=${SESSIONS_APP}" --app "$APP_NAME"

echo ""
echo "FLY_SESSIONS_TOKEN: Fly API token for the '${SESSIONS_ORG}' org."
echo "  Generate one with: fly tokens create org --org ${SESSIONS_ORG}"
read_secret "FLY_SESSIONS_TOKEN" "FLY_SESSIONS_TOKEN (Fly API token for ${SESSIONS_ORG} org)" "true"

# ---------- 5. Link GitHub repos ----------

SYNC_WORKFLOW=".github/workflows/sync-workflow.yml"

echo ""
echo "=== Link GitHub repos ==="
echo "Add target repos so the workflow templates (claude-implement.yml, etc.)"
echo "are synced to them. Enter repos as owner/repo (e.g. acme/my-app)."
echo "Press Enter with no input when done."
echo ""

REPOS_ADDED=false
while true; do
  read -rp "GitHub repo to link (owner/repo, or Enter to skip): " REPO_INPUT
  [ -z "$REPO_INPUT" ] && break

  # Validate format
  if ! echo "$REPO_INPUT" | grep -qE '^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$'; then
    echo "  Invalid format. Use owner/repo (e.g. acme/my-app)"
    continue
  fi

  REPO_OWNER=$(echo "$REPO_INPUT" | cut -d/ -f1)

  # Check if already in sync workflow
  if grep -qF "$REPO_INPUT" "$SYNC_WORKFLOW" 2>/dev/null; then
    echo "  $REPO_INPUT is already in sync-workflow.yml, skipping."
    continue
  fi

  # Add to the matrix — insert before the closing "steps:" line
  # Find the last matrix entry and append after it
  sed -i.bak "/^    steps:$/i\\
          - repo: ${REPO_INPUT}\\
            owner: ${REPO_OWNER}" "$SYNC_WORKFLOW"
  rm -f "${SYNC_WORKFLOW}.bak"

  echo "  Added $REPO_INPUT to sync-workflow.yml"
  REPOS_ADDED=true
done

if [ "$REPOS_ADDED" = "true" ]; then
  echo ""
  echo "New repos added to sync-workflow.yml."
  read -rp "Commit and push to trigger the sync workflow? [Y/n]: " PUSH_CONFIRM
  PUSH_CONFIRM="${PUSH_CONFIRM:-Y}"
  if [[ "$PUSH_CONFIRM" =~ ^[Yy] ]]; then
    git add "$SYNC_WORKFLOW"
    git commit -m "Add repos to workflow sync matrix for client: $SLUG"
    git push
    echo "  Pushed. The sync workflow will run automatically."
    echo "  Check progress: gh run list --workflow=sync-workflow.yml --limit 1"
  else
    echo "  Skipped. Remember to commit and push $SYNC_WORKFLOW to trigger the sync."
  fi
fi

# ---------- 6. Done ----------

echo ""
echo "============================================================"
echo "  Client '$SLUG' is provisioned and ready."
echo ""
echo "  Orchestrator app: $APP_NAME (org: $FLY_ORG)"
echo "  Sessions app:     $SESSIONS_APP (org: $SESSIONS_ORG)"
echo ""
echo "  Next steps:"
echo "    1. Commit clients/${SLUG}.toml and push to main to deploy:"
echo "       git add clients/${SLUG}.toml && git commit -m 'Add client: $SLUG' && git push"
echo "    2. Merge the sync PR in each target repo (opens automatically)"
echo "    3. Enable 'Allow GitHub Actions to create and approve pull requests'"
echo "       in each target repo: Settings → Actions → General"
echo "    4. Install the GitHub App on each target repo"
echo "    5. Add team→repo mappings via the admin UI at /admin"
echo ""
echo "  To re-run this script (update secrets, add more repos):"
echo "    ./scripts/provision-client.sh $SLUG"
echo "============================================================"
echo ""
echo "Client '$SLUG' provisioning complete."
