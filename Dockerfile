# Decision (a): node:24-slim (Debian bookworm-based) instead of alpine.
# fastembed/onnxruntime ship pre-built glibc wheels; Alpine's musl libc makes
# those wheels fail to install (or require a full custom build from source).
# Switching to slim costs ~30 MB but makes the KG sidecar viable without
# cross-compilation or musl-specific wheel builds.
#
# Keep the Node version aligned with the repo pins (.node-version / .nvmrc).
# better-sqlite3 is a native addon whose lifecycle behavior can change across Node releases.
FROM node:24.15.0-slim@sha256:152aceace5c03e2597988763165ee33e3fd3633636db0fc983cd2e126b02cfde AS builder

WORKDIR /app

COPY package.json package-lock.json ./
# Build tools needed for better-sqlite3 and other native addons.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
# Full install first (TypeScript compiler lives in devDependencies).
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build

# Prune to production deps in-place; native addon binaries stay (same glibc ABI).
RUN npm prune --omit=dev

# ---------- Production ----------
FROM node:24.15.0-slim@sha256:152aceace5c03e2597988763165ee33e3fd3633636db0fc983cd2e126b02cfde

WORKDIR /app

# python3 / python3-venv: KG sidecar runtime
# curl: entrypoint readiness polling
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-venv curl \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./

COPY --from=builder /app/dist ./dist
COPY pipelines/ ./pipelines/
COPY workflows/ ./workflows/

# Decision (b): KG artifact acquisition is a MANUAL PRE-BUILD STEP.
#
# The KG repository is private. Neither a build-arg clone token (credential
# visible in image history / build logs) nor an automated vendored copy is
# workable in CI without operator action. This is therefore surfaced as a
# documented manual step rather than automated.
#
# To enable the sidecar:
#   1. Populate ./kg/ with the KG server code + snapshot artifacts.
#      See CLAUDE.md "KG sidecar — build preparation" for the exact steps.
#   2. Ensure kg/start.sh (or kg/server.py + kg/requirements.txt) is present.
#   3. Run `docker build .` — the venv is created here if requirements.txt exists.
#
# Without KG artifacts (only kg/.gitkeep), the venv step is skipped and the
# sidecar is unavailable at runtime; /mcp returns 503 and everything else
# continues normally.
COPY kg/ /app/kg/
RUN if [ -f /app/kg/requirements.txt ]; then \
        echo "[kg] installing Python dependencies into /app/kg/.venv" \
        && python3 -m venv /app/kg/.venv \
        && /app/kg/.venv/bin/pip install --no-cache-dir -r /app/kg/requirements.txt; \
    else \
        echo "[kg] requirements.txt absent — sidecar will be unavailable at runtime"; \
    fi

# Create data directory (Fly volume will mount here)
RUN mkdir -p /data

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

USER node

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
