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

# Decision (b): KG artifact acquisition via BuildKit build secret (fail-soft).
#
# The KG repository is private. A BuildKit --build-secret mount keeps the
# GitHub token out of image history and build logs — it is readable only inside
# the RUN that uses it and is never written to any ENV/ARG.
#
# To build WITH the sidecar (requires read access to BuildDownAI/knowledge-graph-ai-implement):
#   docker build --secret id=kg_token,env=GH_TOKEN .
#   fly deploy --remote-only --build-secret kg_token="$(gh auth token)"
#
# To build WITHOUT the sidecar (sidecar-less / degraded /mcp 503):
#   docker build .
#   fly deploy --remote-only
#
# When the secret is absent the build succeeds and logs "sidecar-less build".
# All other routes remain healthy; only /mcp returns 503.
COPY kg/ /app/kg/
RUN --mount=type=secret,id=kg_token,required=false \
    if [ -f /run/secrets/kg_token ] && [ -s /run/secrets/kg_token ]; then \
        echo "[kg] secret present — cloning BuildDownAI/knowledge-graph-ai-implement" \
        && apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
        && rm -rf /var/lib/apt/lists/* \
        && KG_TOKEN="$(cat /run/secrets/kg_token)" \
        && git clone --depth 1 \
               "https://x-access-token:${KG_TOKEN}@github.com/BuildDownAI/knowledge-graph-ai-implement.git" \
               /tmp/kg-src \
        && unset KG_TOKEN \
        && mkdir -p /app/kg \
        && for d in kg_query kg_ingest snapshot; do \
               [ -d /tmp/kg-src/$d ] && cp -r /tmp/kg-src/$d /app/kg/ || true; \
           done \
        && for f in requirements.txt sources.yml; do \
               [ -f /tmp/kg-src/$f ] && cp /tmp/kg-src/$f /app/kg/ || true; \
           done \
        && printf '#!/bin/sh\ncd "$(dirname "$0")"\nexport KG_HTTP=1 KG_HTTP_PORT=8765 KG_HTTP_HOST=127.0.0.1 KG_BACKEND=rdflib PYTHONPATH=. FASTEMBED_CACHE_PATH=/app/kg/.fastembed-cache\nexec .venv/bin/python -m kg_query.server\n' > /app/kg/start.sh \
        && chmod +x /app/kg/start.sh \
        && rm -rf /tmp/kg-src; \
    else \
        echo "[kg] sidecar-less build — kg_token secret absent or empty, /mcp will return 503"; \
    fi
RUN if [ -f /app/kg/requirements.txt ]; then \
        echo "[kg] installing Python dependencies into /app/kg/.venv" \
        && python3 -m venv /app/kg/.venv \
        && /app/kg/.venv/bin/pip install --no-cache-dir -r /app/kg/requirements.txt; \
    else \
        echo "[kg] requirements.txt absent — sidecar will be unavailable at runtime"; \
    fi
RUN if [ -x /app/kg/.venv/bin/python ]; then \
        echo "[kg] warming fastembed model BAAI/bge-small-en-v1.5 into baked cache" \
        && FASTEMBED_CACHE_PATH=/app/kg/.fastembed-cache \
           /app/kg/.venv/bin/python -c \
             "from fastembed import TextEmbedding; TextEmbedding('BAAI/bge-small-en-v1.5')" \
        || echo "[kg] WARNING: EMBEDDINGS BUILD FAILED — model warm failed; image will run lexical-only"; \
    else \
        echo "[kg] no venv — skipping model warm (sidecar-less)"; \
    fi
RUN if [ -x /app/kg/.venv/bin/python ] && [ -d /app/kg/snapshot/parts ]; then \
        echo "[kg] materializing out/graph.trig from committed snapshot (graph only)" \
        && cd /app/kg \
        && PYTHONPATH=. .venv/bin/python -m kg_ingest.materialize --no-embed \
        && ( echo "[kg] embedding graph with baked fastembed cache" \
             && FASTEMBED_CACHE_PATH=/app/kg/.fastembed-cache \
                PYTHONPATH=. .venv/bin/python -m kg_ingest.materialize \
             || echo "[kg] WARNING: EMBEDDINGS BUILD FAILED — embed step failed; image ships graph-only (lexical search only)" ); \
    else \
        echo "[kg] no venv or snapshot — skipping materialize (sidecar-less)"; \
    fi

# Create data directory (Fly volume will mount here)
RUN mkdir -p /data

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

USER node

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
