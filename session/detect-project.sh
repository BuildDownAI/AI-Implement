#!/usr/bin/env bash
# detect-project.sh — Convention detection for AI-Implement sessions.
#
# Parses .ai-implement.toml if present; otherwise auto-detects project type
# from common files (package.json, requirements.txt, Gemfile, go.mod,
# docker-compose.yml) and applies sensible defaults.
#
# Usage (source into a running shell to set+export variables):
#   source /opt/ai-implement/detect-project.sh
#
# Standalone usage (prints detected values to stdout, useful for testing):
#   bash /opt/ai-implement/detect-project.sh
#   DETECT_PROJECT_DIR=/path/to/repo bash /opt/ai-implement/detect-project.sh
#
# Exported variables:
#   SETUP_CMD        — install/build command (e.g. "npm install")
#   DEV_CMD          — dev-server start command (e.g. "npm run dev")
#   DEV_PORT         — port the dev server listens on (e.g. "3000")
#   READY_CHECK      — command that exits 0 when the server is up (may be empty)
#   VERIFY_CMD       — test/verify command (may be empty)
#   TEARDOWN_CMD     — server stop command (may be empty)
#   CLAUDE_MODEL     — Claude model override (may be empty; does not override env var)
#   CLAUDE_MAX_TURNS — Claude max-turns override (may be empty)
#   REQUIRED_SECRETS — space-separated list of required env var names
#   OPTIONAL_SECRETS — space-separated list of optional env var names

# ── Initialise outputs ────────────────────────────────────────────────────────

SETUP_CMD=""
DEV_CMD=""
DEV_PORT=""
READY_CHECK=""
VERIFY_CMD=""
TEARDOWN_CMD=""
# Only set CLAUDE_MODEL/CLAUDE_MAX_TURNS if not already set by caller's env.
# This preserves the priority: external env > .ai-implement.toml > WORKFLOW.md.
_dp_env_model="${CLAUDE_MODEL:-}"
_dp_env_max_turns="${CLAUDE_MAX_TURNS:-}"
CLAUDE_MODEL=""
CLAUDE_MAX_TURNS=""
REQUIRED_SECRETS=""
OPTIONAL_SECRETS=""

# Base directory to detect in (defaults to cwd; override with DETECT_PROJECT_DIR)
_dp_dir="${DETECT_PROJECT_DIR:-$(pwd)}"
_dp_source="none"
_dp_script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# _pkg_has_script KEY FILE — returns 0 if package.json contains scripts.KEY.
_pkg_has_script() {
  local key="$1" file="$2"
  awk -v key="$key" '
    BEGIN { in_scripts = 0; depth = 0; found = 0 }
    {
      line = $0
      if (!in_scripts) {
        if (match(line, /"scripts"[[:space:]]*:[[:space:]]*{/)) {
          in_scripts = 1
          depth = 1
          line = substr(line, RSTART + RLENGTH)
        } else {
          next
        }
      }

      if (line ~ ("\"" key "\"[[:space:]]*:")) {
        found = 1
        exit 0
      }

      # Naive brace counting can be fooled by { or } inside string literals;
      # jq remains the preferred and more accurate detection path.
      opens = gsub(/{/, "{", line)
      closes = gsub(/}/, "}", line)
      depth += opens - closes
      if (depth <= 0) in_scripts = 0
    }
    END { exit(found ? 0 : 1) }
  ' "$file"
}

# ── Detection logic ───────────────────────────────────────────────────────────

_TOML="$_dp_dir/.ai-implement.toml"

if [ -f "$_TOML" ]; then
  # ── Parse .ai-implement.toml with Python's TOML parser ─────────────────────
  if ! command -v python3 >/dev/null 2>&1; then
    echo "ERROR: detect-project: python3 is required to parse .ai-implement.toml but was not found on PATH" >&2
    exit 1
  fi

  _dp_exports_file="$(mktemp)"
  if ! python3 "$_dp_script_dir/parse-ai-implement-toml.py" "$_TOML" >"$_dp_exports_file"; then
    rm -f "$_dp_exports_file"
    exit 1
  fi

  # shellcheck disable=SC1090
  if ! source "$_dp_exports_file"; then
    rm -f "$_dp_exports_file"
    exit 1
  fi
  rm -f "$_dp_exports_file"
  _dp_source="toml"

else
  # ── Auto-detect from well-known project files ──────────────────────────────
  _PKG="$_dp_dir/package.json"

  if [ -f "$_PKG" ]; then
    # Node.js project — prefer 'dev' script, fall back to 'start'
    SETUP_CMD="npm install"
    DEV_PORT="3000"
    _node_script=""

    if command -v jq >/dev/null 2>&1; then
      if jq -e '.scripts.dev' "$_PKG" >/dev/null 2>&1; then
        _node_script="dev"
      elif jq -e '.scripts.start' "$_PKG" >/dev/null 2>&1; then
        _node_script="start"
      fi
    else
      # Fallback: scan only the "scripts" object. This still assumes a
      # conventional package.json layout, so jq remains the preferred path.
      if _pkg_has_script "dev" "$_PKG"; then
        _node_script="dev"
      elif _pkg_has_script "start" "$_PKG"; then
        _node_script="start"
      fi
    fi

    case "$_node_script" in
      dev)   DEV_CMD="npm run dev" ; _dp_source="package.json (dev script)" ;;
      start) DEV_CMD="npm start"   ; _dp_source="package.json (start script)" ;;
      *)     _dp_source="package.json (no dev/start script)" ;;
    esac

    if [ -n "$DEV_CMD" ]; then
      READY_CHECK="curl -sf http://localhost:${DEV_PORT}/"
    fi

  elif [ -f "$_dp_dir/requirements.txt" ] && [ -f "$_dp_dir/manage.py" ]; then
    # Django project
    SETUP_CMD="pip install -r requirements.txt"
    DEV_CMD="python manage.py runserver 0.0.0.0:8000"
    DEV_PORT="8000"
    READY_CHECK="curl -sf http://localhost:8000/"
    _dp_source="requirements.txt+manage.py (django)"

  elif [ -f "$_dp_dir/Gemfile" ] && [ -f "$_dp_dir/config.ru" ]; then
    # Rails project
    SETUP_CMD="bundle install"
    DEV_CMD="bundle exec rails server -b 0.0.0.0"
    DEV_PORT="3000"
    READY_CHECK="curl -sf http://localhost:3000/"
    _dp_source="Gemfile+config.ru (rails)"

  elif [ -f "$_dp_dir/go.mod" ]; then
    # Go project
    SETUP_CMD="go build ./..."
    DEV_CMD="go run ."
    DEV_PORT="8080"
    READY_CHECK="curl -sf http://localhost:8080/"
    _dp_source="go.mod (go)"

  elif [ -f "$_dp_dir/docker-compose.yml" ] || [ -f "$_dp_dir/docker-compose.yaml" ]; then
    # Docker Compose project
    # Compose has no separate "install" phase; the dev command is the startup.
    DEV_CMD="docker compose up -d"
    DEV_PORT="3000"
    # Compose service readiness is repo-specific; override in .ai-implement.toml
    # when a project can provide a stable health check.
    TEARDOWN_CMD="docker compose down"
    _dp_source="docker-compose"

  else
    _dp_source="unknown (no recognised project files found)"
  fi
fi

# ── Restore external env var priority ─────────────────────────────────────────
# If CLAUDE_MODEL / CLAUDE_MAX_TURNS were already set in the caller's environment
# before this script was sourced, those values take precedence over the TOML.

if [ -n "$_dp_env_model" ]; then
  CLAUDE_MODEL="$_dp_env_model"
fi
if [ -n "$_dp_env_max_turns" ]; then
  CLAUDE_MAX_TURNS="$_dp_env_max_turns"
fi

# ── Validate required secrets ─────────────────────────────────────────────────

if [ -n "$REQUIRED_SECRETS" ]; then
  _dp_missing=""
  for _secret in $REQUIRED_SECRETS; do
    if [ -z "${!_secret:-}" ]; then
      _dp_missing="${_dp_missing:+$_dp_missing }$_secret"
    fi
  done
  if [ -n "$_dp_missing" ]; then
    echo "ERROR: detect-project: missing required secret(s): $_dp_missing" >&2
    echo "       Set these environment variables before running: $_dp_missing" >&2
    # Intentional: when sourced by the session entrypoint, exit 1 aborts the
    # whole session before any setup or Claude invocation begins.
    exit 1
  fi
fi

# ── Export all variables ──────────────────────────────────────────────────────

export SETUP_CMD DEV_CMD DEV_PORT READY_CHECK VERIFY_CMD TEARDOWN_CMD
export CLAUDE_MODEL CLAUDE_MAX_TURNS REQUIRED_SECRETS OPTIONAL_SECRETS

# ── Standalone output ─────────────────────────────────────────────────────────
# When executed directly (not sourced), print a human-readable summary.
# Callers can also test by running: bash detect-project.sh and parsing stdout.

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  echo "detect-project: source=${_dp_source}"
  echo "SETUP_CMD=${SETUP_CMD}"
  echo "DEV_CMD=${DEV_CMD}"
  echo "DEV_PORT=${DEV_PORT}"
  echo "READY_CHECK=${READY_CHECK}"
  echo "VERIFY_CMD=${VERIFY_CMD}"
  echo "TEARDOWN_CMD=${TEARDOWN_CMD}"
  echo "CLAUDE_MODEL=${CLAUDE_MODEL}"
  echo "CLAUDE_MAX_TURNS=${CLAUDE_MAX_TURNS}"
  echo "REQUIRED_SECRETS=${REQUIRED_SECRETS}"
  echo "OPTIONAL_SECRETS=${OPTIONAL_SECRETS}"
fi
