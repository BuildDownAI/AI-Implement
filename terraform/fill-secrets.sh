#!/usr/bin/env bash
# Fill the SSM Parameter Store placeholders for the orchestrator.
#
# For each parameter, the script:
#   1. If an env var with the same name is set (even to an empty string), uses it.
#      Only ever-set vars take precedence. Unset means "ask me".
#   2. Otherwise prompts on the terminal.
#
# Usage:
#   AWS_PROFILE=<your-profile> ./fill-secrets.sh                # all keys
#   AWS_PROFILE=<your-profile> ./fill-secrets.sh KEY ...        # subset
#   JIRA_TOKEN=abc123 ./fill-secrets.sh                             # via env
#   set -a; source ~/.ai-implement.env; set +a; ./fill-secrets.sh   # via dotenv
#
# An empty value (env or prompt) skips the parameter — existing SSM value untouched.
# Multi-line via prompt: end with a single line containing only ".".
# Multi-line via env (e.g. PEM): set the env var to the full multi-line content.

set -euo pipefail

REGION=${AWS_REGION:-us-east-1}
PROJECT=${PROJECT:-ai-implement}

ALL_KEYS=(
  GITHUB_APP_ID
  GITHUB_APP_PRIVATE_KEY
  GITHUB_WEBHOOK_SECRET
  JIRA_TOKEN
  JIRA_CLOUD_ID
  JIRA_SITE_URL
  ADMIN_ACCESS_CODE
  RUNNER_TOKEN_SECRET
  GAP_FILL_TRIGGER_SECRET
  NOTIFY_TYPE
  NOTIFY_WEBHOOK_URL
)

VISIBLE_KEYS=( NOTIFY_TYPE JIRA_CLOUD_ID JIRA_SITE_URL )
MULTILINE_KEYS=( GITHUB_APP_PRIVATE_KEY )

if [ "$#" -gt 0 ]; then
  KEYS=("$@")
else
  KEYS=("${ALL_KEYS[@]}")
fi

contains() {
  local needle="$1"; shift
  for x in "$@"; do [ "$x" = "$needle" ] && return 0; done
  return 1
}

prompt_secret() {
  local label="$1" var
  printf '%s: ' "$label" >&2
  stty -echo
  IFS= read -r var || true
  stty echo
  printf '\n' >&2
  printf '%s' "$var"
}

prompt_visible() {
  local label="$1" var
  printf '%s: ' "$label" >&2
  IFS= read -r var || var=""
  printf '%s' "$var"
}

prompt_multiline() {
  local label="$1" line buf=""
  printf '%s (end with a single "." on its own line, blank to skip):\n' "$label" >&2
  while IFS= read -r line; do
    [ "$line" = "." ] && break
    buf+="$line"$'\n'
  done
  printf '%s' "${buf%$'\n'}"
}

put() {
  local name="$1" value="$2"
  if [ -z "$value" ]; then
    printf '  - %s: skipped (empty)\n' "$name" >&2
    return 0
  fi
  aws ssm put-parameter \
    --overwrite \
    --region "$REGION" \
    --name "/${PROJECT}/${name}" \
    --type SecureString \
    --value "$value" \
    >/dev/null
  printf '  - %s: set\n' "$name" >&2
}

for key in "${KEYS[@]}"; do
  if [ "${!key+set}" = "set" ]; then
    # Env var defined (even if empty). Use it without prompting.
    value="${!key}"
    if [ -z "$value" ]; then
      printf '  - %s: env var is empty, skipping\n' "$key" >&2
      continue
    fi
    put "$key" "$value"
    continue
  fi

  if contains "$key" "${MULTILINE_KEYS[@]}"; then
    value=$(prompt_multiline "$key")
  elif contains "$key" "${VISIBLE_KEYS[@]}"; then
    value=$(prompt_visible "$key")
  else
    value=$(prompt_secret "$key")
  fi

  put "$key" "$value"
done

cat <<'EOF' >&2

Done. To pick up the new values, restart the orchestrator:

  aws ssm send-command \
    --instance-ids "$(terraform output -raw instance_id)" \
    --document-name AWS-RunShellScript \
    --parameters 'commands=["sudo systemctl restart orchestrator.service"]'
EOF
