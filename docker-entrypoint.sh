#!/bin/sh
# docker-entrypoint.sh — orchestrator container startup
#
# Starts the KG knowledge-graph sidecar on loopback before handing off to
# Node. Sidecar failure is non-fatal: the orchestrator boots normally and
# /mcp returns 503 (degraded) while all other routes remain unaffected.

set -eu

KG_DIR=/app/kg
KG_PORT=8765
KG_MCP_URL="http://127.0.0.1:${KG_PORT}/mcp"

# ---------------------------------------------------------------------------
# _start_sidecar: launch the KG sidecar and wait for its MCP endpoint.
# Returns 0 on success, 1 on any failure (no start script, crash, timeout).
# ---------------------------------------------------------------------------
_start_sidecar() {
    if [ -f "${KG_DIR}/start.sh" ]; then
        # Vendor-provided startup script (preferred — knows its own CLI args).
        sh "${KG_DIR}/start.sh" &
        _KG_PID=$!
    elif [ -f "${KG_DIR}/server.py" ]; then
        # Bare Python entry point — venv must have been created at build time.
        if [ ! -x "${KG_DIR}/.venv/bin/python" ]; then
            printf '[kg] .venv missing — rebuild the image to install Python dependencies\n' >&2
            return 1
        fi
        "${KG_DIR}/.venv/bin/python" "${KG_DIR}/server.py" &
        _KG_PID=$!
    else
        printf '[kg] no startup entry point found (kg/start.sh or kg/server.py) — sidecar unavailable\n' >&2
        return 1
    fi

    printf '[kg] sidecar starting (pid %s) — polling %s\n' "${_KG_PID}" "${KG_MCP_URL}" >&2

    # Poll the MCP endpoint for up to 30 s. Any HTTP response (even 4xx/5xx)
    # means the server is accepting connections; connection-refused means it
    # is not ready yet.
    _i=0
    while [ "${_i}" -lt 30 ]; do
        # curl returns 0 for any HTTP response, non-zero on connect failure.
        if curl -s --connect-timeout 1 --max-time 2 "${KG_MCP_URL}" -o /dev/null 2>&1; then
            printf '[kg] sidecar ready (pid %s)\n' "${_KG_PID}" >&2
            return 0
        fi
        # Bail early if the process already exited.
        if ! kill -0 "${_KG_PID}" 2>/dev/null; then
            printf '[kg] sidecar exited during startup — degraded mode\n' >&2
            return 1
        fi
        sleep 1
        _i=$((_i + 1))
    done

    printf '[kg] sidecar readiness timeout after 30 s — degraded mode; /mcp serves no kg_* tools\n' >&2
    return 1
}

if _start_sidecar; then
    export KG_SIDECAR_URL="${KG_MCP_URL}"
    printf '[kg] KG_SIDECAR_URL set to %s\n' "${KG_SIDECAR_URL}" >&2
else
    printf '[kg] continuing without sidecar; /mcp serves no kg_* tools\n' >&2
    # KG_SIDECAR_URL stays unset. /mcp still answers 401 unauthenticated, so this log is the signal.
fi

exec node dist/index.js "$@"
