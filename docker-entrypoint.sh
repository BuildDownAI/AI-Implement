#!/bin/sh
# docker-entrypoint.sh — orchestrator container startup
#
# KG sidecar management (launch, readiness poll, degraded detection) moved into
# src/kg-sidecar.ts, which is started by the orchestrator process itself. See
# KgSidecar.start() for the full lifecycle — this file just hands off to Node.

set -eu

exec node dist/index.js "$@"
