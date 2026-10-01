#!/usr/bin/env bash
# lib.sh — Shared utilities for session scripts
set -euo pipefail

log() {
  echo "[session] $(date -u +%Y-%m-%dT%H:%M:%SZ) $*"
}

fail() {
  log "FATAL: $*" >&2
  exit 1
}

# Require one or more environment variables to be set and non-empty.
# Usage: require_env VAR_NAME [VAR_NAME ...]
require_env() {
  for var_name in "$@"; do
    if [ -z "${!var_name:-}" ]; then
      fail "Required environment variable $var_name is not set"
    fi
  done
}

# Require at least one of the given environment variables to be set.
# Usage: require_one_of VAR_A VAR_B [VAR_C ...]
require_one_of() {
  for var in "$@"; do
    if [ -n "${!var:-}" ]; then return 0; fi
  done
  fail "At least one of $* must be set"
}

# Match the non-root runner account to the owner of a host bind mount without
# recursively changing ownership of the host checkout.
prepare_coder_identity() {
  local host_uid="$1" host_gid="$2" host_group
  [[ "$host_uid" =~ ^[1-9][0-9]*$ ]] || fail "AI_IMPLEMENT_HOST_UID must be a positive integer"
  [[ "$host_gid" =~ ^[1-9][0-9]*$ ]] || fail "AI_IMPLEMENT_HOST_GID must be a positive integer"
  host_group="$(getent group "$host_gid" | cut -d: -f1 || true)"
  if [ -n "$host_group" ]; then
    usermod -g "$host_group" coder
  else
    groupmod -o -g "$host_gid" coder
  fi
  usermod -o -u "$host_uid" coder
  chown -R coder:"$(id -gn coder)" /home/coder
}

# Verify that coder can create and remove a file in the bind-mounted workspace.
# Call this after prepare_coder_identity has adopted the host UID/GID.
# Stops the run on failure and reports the path, detected ownership, and adopted identity.
verify_workspace_writable() {
  local workspace_dir="$1"
  local coder_uid coder_gid ws_uid ws_gid
  coder_uid="$(id -u coder)"
  coder_gid="$(id -g coder)"
  ws_uid="$(stat -c '%u' "$workspace_dir" 2>/dev/null || stat -f '%u' "$workspace_dir" 2>/dev/null || echo '?')"
  ws_gid="$(stat -c '%g' "$workspace_dir" 2>/dev/null || stat -f '%g' "$workspace_dir" 2>/dev/null || echo '?')"
  # workspace_dir is passed as $1 to the child shell — never interpolated into the
  # -c program text — so shell-significant characters in the path cannot become
  # executable code.  mktemp generates a collision-safe name; _cleanup_probe removes
  # the probe by variable reference rather than embedding the path in an evaluated
  # trap string, so shell-significant characters in the probe path remain data.
  # shellcheck disable=SC2016
  if su coder -s /bin/bash -c '
    probe="$(mktemp "$1/.ai-implement-probe.XXXXXX")" || exit 1
    _cleanup_probe() { rm -f -- "$probe"; }
    trap _cleanup_probe EXIT
  ' -- _ "$workspace_dir" 2>/dev/null; then
    return 0
  fi
  fail "Cannot write to bind-mounted workspace $workspace_dir (owner $ws_uid:$ws_gid, coder UID $coder_uid GID $coder_gid). Verify AI_IMPLEMENT_HOST_UID/AI_IMPLEMENT_HOST_GID match the host directory owner. On macOS Docker Desktop, confirm file sharing is enabled — the mount may be read-only."
}

# Resolve VAR from the AI_IMPLEMENT_RUN_CONFIG envelope when the env is empty.
# Usage: resolve_envelope_field VAR_NAME ENVELOPE_KEY
#
# Env wins: if VAR is already non-empty, this is a no-op. Otherwise, decode
# the envelope with node -e (same base64-JSON style as the other envelope
# reads in entrypoint.sh) and read the string value of ENVELOPE_KEY. A
# non-empty value is assigned to VAR and exported, logging one
# "envelope.<KEY>=<value>" line. An absent envelope or an absent/empty key
# leaves VAR unchanged with no log line. A malformed envelope also leaves VAR
# unchanged but logs one warning line — the errors are swallowed the same way
# the other envelope reads swallow them, so a bad envelope surfaces as the
# runner's own decode error rather than a shell exit with no callback.
resolve_envelope_field() {
  local var_name="$1" key="$2" out status val
  [ -n "${!var_name:-}" ] && return 0
  [ -z "${AI_IMPLEMENT_RUN_CONFIG:-}" ] && return 0
  # The value comes first and the status marker last, since command
  # substitution strips trailing newlines — putting the (possibly empty)
  # value last would make it indistinguishable from a value that never had
  # a separator.
  out="$(node -e "try{const c=JSON.parse(Buffer.from(process.env.AI_IMPLEMENT_RUN_CONFIG,'base64').toString());const v=c['$key'];process.stdout.write((typeof v==='string'?v:'')+'\nok')}catch(e){process.stdout.write('\nerr')}" 2>/dev/null || echo $'\nerr')"
  status="${out##*$'\n'}"
  val="${out%$'\n'*}"
  if [ "$status" != "ok" ]; then
    log "WARNING: Could not decode AI_IMPLEMENT_RUN_CONFIG while resolving ${key}; leaving ${var_name} unset"
    return 0
  fi
  if [ -n "$val" ]; then
    export "${var_name}=${val}"
    log "envelope.${key}=${val}"
  fi
}

# Classify AI_IMPLEMENT_RUN_CONFIG for model-auth bootstrap. Prints exactly one fixed word:
#   legacy      no envelope, or a trusted-decodable envelope with neither a resolved agentConfig
#               nor a credentials.modelAuthGrant (a callback/publication-only credentials
#               namespace stays legacy stage selection)
#   configured  trusted decoder accepts it and it carries both agentConfig and modelAuthGrant
#   invalid     any nonempty envelope the trusted decoder rejects (bad base64/JSON, non-object,
#               bad version, bad credentials) or configured intent with only one of the two;
#               callers fail closed, never fall back to legacy
# Never prints decoded values or decoder error text. AI_IMPLEMENT_DIST_DIR is a test seam.
classify_run_config() {
  [ -z "${AI_IMPLEMENT_RUN_CONFIG:-}" ] && { echo legacy; return 0; }
  node --input-type=module -e '
    const out = (w) => process.stdout.write(w);
    try {
      const dir = process.env.AI_IMPLEMENT_DIST_DIR || "/app/dist";
      const { decodeTrustedRunConfig } = await import(dir + "/run-config.js");
      const c = decodeTrustedRunConfig(process.env.AI_IMPLEMENT_RUN_CONFIG);
      const snapshot = c.agentConfig !== undefined;
      const grant = c.credentials !== undefined && c.credentials.modelAuthGrant !== undefined;
      out(snapshot && grant ? "configured" : snapshot || grant ? "invalid" : "legacy");
    } catch { out("invalid"); }
  ' 2>/dev/null || echo invalid
}

# Credential helper that answers only from the GIT_PASSWORD of the git child it serves, so the
# remote URL and argv stay credential-free and nothing is written to disk. Registered for
# configured runs only; the TS clone step already supplies GIT_PASSWORD per operation.
# shellcheck disable=SC2016 # expanded by the helper's own shell, not here
SCOPED_GIT_HELPER='!f() { [ "$1" = get ] && [ -n "${GIT_PASSWORD:-}" ] || exit 0; echo username=x-access-token; echo "password=$GIT_PASSWORD"; }; f'

configure_scoped_git_auth() {
  run_scoped "" git config --global credential.helper "$SCOPED_GIT_HELPER" || return $?
}

# Run one git network operation (clone/fetch) with the GitHub token in that child's environment only.
git_authed() {
  GIT_PASSWORD="$GITHUB_TOKEN" GIT_TERMINAL_PROMPT=0 run_scoped "GIT_PASSWORD GIT_TERMINAL_PROMPT" git "$@" || return $?
}

# Run a command with a minimal, scrubbed environment when the run is configured
# (CONFIGURED=1): only PATH/HOME/locale/TLS/proxy context plus the explicitly named
# extra variables (e.g. GH_TOKEN for gh). Model, session, bootstrap and forwarded-secret
# material never reaches the child. Legacy runs (CONFIGURED unset) run unchanged.
# Usage: run_scoped "EXTRA_VAR ..." command [args...]
run_scoped() {
  local extra="$1" k
  shift
  # `|| return` keeps the failure visible to the caller's ERR trap (traps are not inherited by functions).
  if [ "${CONFIGURED:-0}" != "1" ]; then "$@" || return $?; return 0; fi
  local -a keep=(PATH HOME USER LOGNAME SHELL TERM TMPDIR TMP TEMP TZ LANG LANGUAGE LC_ALL LC_CTYPE
    SSL_CERT_FILE SSL_CERT_DIR NODE_EXTRA_CA_CERTS REQUESTS_CA_BUNDLE CURL_CA_BUNDLE
    HTTP_PROXY HTTPS_PROXY NO_PROXY ALL_PROXY http_proxy https_proxy no_proxy all_proxy)
  local -a pairs=()
  # shellcheck disable=SC2086 # extra is a space-separated list of names
  for k in "${keep[@]}" $extra; do
    [ -n "${!k+x}" ] && pairs+=("$k=${!k}")
  done
  env -i "${pairs[@]}" "$@" || return $?
}

# ERR trap body. Configured runs log a fixed message: the failing command text can carry
# bootstrap or token material.
on_err() {
  local rc="$1" line="$2" cmd="$3"
  if [ "${CONFIGURED:-0}" = "1" ]; then
    log "ERROR: line $line failed (exit $rc)"
  else
    log "ERROR: line $line failed: $cmd (exit $rc)"
  fi
}

# Echoes the runner entry file for a given RUNNER_PHASE. Same five arms used
# by every execution mode; kept here so lib.sh is the one place that maps
# phase -> entry file.
select_runner_entry() {
  local phase="$1"
  case "$phase" in
    planning) echo "run-planning.js" ;;
    local-planning) echo "run-local-planning.js" ;;
    full) echo "run-local-full-loop.js" ;;
    kg-refresh) echo "pipeline/kg-refresh-run.js" ;;
    *) echo "run-autonomous.js" ;;
  esac
}

# Returns 0 (true) if the bare secret name would overwrite an orchestrator-
# owned environment variable and must not be exported by remap_team_secrets.
# Matches all GITHUB_*, ISSUE_*, and AI_IMPLEMENT_* prefixes plus the exact
# orchestrator vars set by buildSessionMachineConfig in src/fly-machines.ts.
_remap_is_reserved() {
  case "$1" in
    GITHUB_*|ISSUE_*|AI_IMPLEMENT_*) return 0 ;;
    ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|SESSION_TOKEN|MACHINE_NONCE) return 0 ;;
    RUN_TOKEN|ORCHESTRATOR_URL|RUNNER_CALLBACK_URL|WORKSPACE_DIR|PATH|HOME) return 0 ;;
  esac
  # Configured (opted-in) runs also reserve every model credential, session/auth-directory
  # and provider-routing name. Legacy runs keep the narrower list above on purpose.
  if [ "${CONFIGURED:-0}" = "1" ]; then
    case "$1" in
      OPENAI_*|CODEX_*|ANTHROPIC_*|CLAUDE_*|AWS_*|RUN_*|RUNNER_*|NPM_TOKEN|CLOUD_ML_REGION|GOOGLE_APPLICATION_CREDENTIALS) return 0 ;;
    esac
  fi
  return 1
}

# Remap per-project Fly secrets to their unprefixed runner-visible names.
#
# Classic Fly app secrets are app-wide: every machine on the sessions app
# receives every classic secret under its stored name (e.g. SAN_QA_PROBE).
# The Machines API processes[].secrets env_var remap applies only to the
# non-GA named-secrets feature and has no effect on classic secrets (confirmed
# 2026-09-03, probe SAN-22 on ai-implement-testing-sessions).
#
# Reads:
#   AI_IMPLEMENT_TEAM_SECRET_PREFIX  — own-team prefix, e.g. "SAN_"
#   AI_IMPLEMENT_FOREIGN_SECRET_NAMES — comma-joined names from other teams,
#       e.g. "ENG_DB_URL,QA_OTHER". Global machine secrets (no team prefix)
#       are absent from this list and pass through unchanged.
#
# Effect (runs before su -p coder handoff):
#   - Own-team names (prefix match via env scan): export <BARE>=<value>;
#     unset <TEAM>_<BARE>. Reserved names (_remap_is_reserved) are unset
#     but not exported.
#   - Foreign-team names (AI_IMPLEMENT_FOREIGN_SECRET_NAMES): unset.
#   - Global secrets (not in either category): untouched.
#   - Exports AI_IMPLEMENT_FORWARDED_SECRETS=<comma-joined bare names>
#     Format: "QA_PROBE,DB_URL" — names only, no values. Empty when none.
remap_team_secrets() {
  local prefix="${AI_IMPLEMENT_TEAM_SECRET_PREFIX:-}"
  if [ -z "$prefix" ]; then return 0; fi

  local forwarded="" _bare _val _sname
  # Remap own-team secrets: scan the environment for vars with the own-team
  # prefix, export them under their bare name, and unset the prefixed form.
  while IFS= read -r _sname; do
    [ -z "$_sname" ] && continue
    _bare="${_sname#"${prefix}"}"
    if _remap_is_reserved "$_bare"; then
      log "WARNING: Skipping reserved secret name ${_bare} (stored as ${_sname}) — would overwrite orchestrator-managed env var"
      unset "${_sname}"
      continue
    fi
    _val="${!_sname:-}"
    export "${_bare}=${_val}"
    unset "${_sname}"
    forwarded="${forwarded:+${forwarded},}${_bare}"
  done < <(compgen -v | grep "^${prefix}" || true)

  # Unset foreign-team secrets. Global secrets (no team prefix) are not listed
  # here and pass through unchanged.
  local foreign_names="${AI_IMPLEMENT_FOREIGN_SECRET_NAMES:-}"
  if [ -n "$foreign_names" ]; then
    local -a _fnames=()
    IFS=',' read -ra _fnames <<< "$foreign_names"
    for _sname in "${_fnames[@]}"; do
      [ -z "$_sname" ] && continue
      unset "${_sname}" 2>/dev/null || true
    done
  fi

  export AI_IMPLEMENT_FORWARDED_SECRETS="$forwarded"
  log "Remapped team secrets (prefix=${prefix}): ${forwarded:-none}"
}
