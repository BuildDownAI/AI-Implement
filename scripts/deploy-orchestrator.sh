#!/usr/bin/env bash
# Deploy an orchestrator WITH its KG sidecar — the standard deploy command.
#
# Why this script exists (learned the hard way, three times):
#   1. A plain `fly deploy` silently produces a SIDECAR-LESS image (/mcp -> 503):
#      the KG is cloned at build time via a BuildKit secret, and without the
#      secret the build fail-softs to "no kg/".
#   2. `--no-cache` is REQUIRED even with the secret: a --build-secret is NOT
#      part of the layer cache key, so a repeat deploy silently reuses a stale
#      (possibly sidecar-less) clone/materialize layer.
#   3. GH_TOKEN must be EXPORTED — an inline `GH_TOKEN=... fly deploy ... "$GH_TOKEN"`
#      prefix doesn't affect same-line expansion and passes an empty secret.
#
# Usage:
#   ./scripts/deploy-orchestrator.sh [app-name]     # default: ai-implement-testing-orchestrator
#
# Requires: fly (authed), gh (authed with read access to the private KG repo).
set -euo pipefail

APP="${1:-ai-implement-testing-orchestrator}"

export GH_TOKEN="${GH_TOKEN:-$(gh auth token)}"
if [ -z "$GH_TOKEN" ]; then
    echo "❌ no GitHub token — run 'gh auth login' first (the KG repo is private)" >&2
    exit 1
fi

echo "==> deploying $APP (KG sidecar build, --no-cache)"
fly deploy --remote-only --no-cache --build-secret kg_token="$GH_TOKEN" --app "$APP"

# ---- post-deploy serve check (boots != serves) ------------------------------
# /mcp must answer 401 (alive, OAuth-gated). 503 means the image shipped
# without the sidecar — the exact failure this script exists to prevent.
echo "==> verifying /mcp on https://$APP.fly.dev"
for i in $(seq 1 12); do
    code=$(curl -s -o /dev/null -w '%{http_code}' -m 5 -X POST "https://$APP.fly.dev/mcp" -d '{}' || echo 000)
    [ "$code" = "401" ] && break
    sleep 5
done
if [ "$code" = "401" ]; then
    echo "✅ /mcp is OAuth-gated (sidecar up and configured)"
else
    echo "❌ /mcp returned $code — the deployed image has NO working KG sidecar." >&2
    echo "   Most likely: the build secret was missing/empty, or a cached sidecar-less" >&2
    echo "   layer was reused. Re-run this script (it always passes both flags)." >&2
    exit 1
fi
