#!/bin/sh
# docker-entrypoint.sh — orchestrator container startup
#
# KG sidecar management (launch, readiness poll, degraded detection, and — as of
# AII-599 — KG_BACKEND/KG_PARTS_DIR selection for a staged nt_parts overlay) moved
# into src/kg-sidecar.ts, which is started by the orchestrator process itself. See
# KgSidecar.start() for the full lifecycle — this file just hands off to Node.

set -eu

exec node dist/index.js "$@"
