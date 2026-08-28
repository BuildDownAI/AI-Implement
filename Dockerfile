# Decision (a): node:24-slim (Debian bookworm-based) instead of alpine.
# fastembed/onnxruntime ship pre-built glibc wheels; Alpine's musl libc makes
# those wheels fail to install (or require a full custom build from source).
# Switching to slim costs ~30 MB but makes the KG sidecar viable without
# cross-compilation or musl-specific wheel builds.
#
# Keep the Node version aligned with the repo pins (.node-version / .nvmrc).
# better-sqlite3 is a native addon whose lifecycle behavior can change across Node releases.
FROM node:24.15.0-slim@sha256:4e6b70dd6cbfc88c8157ba19aa3d9f9cce6ba4703576d55459e45efcbc9c5f5d AS builder

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
FROM node:24.15.0-slim@sha256:4e6b70dd6cbfc88c8157ba19aa3d9f9cce6ba4703576d55459e45efcbc9c5f5d

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
# To build WITH the sidecar (requires KG_SOURCE_REPO set and read access to it):
#   docker build --build-arg KG_SOURCE_REPO=owner/repo --secret id=kg_token,env=GH_TOKEN .
#   fly deploy --remote-only --build-secret kg_token="$(gh auth token)"
#
# To build WITHOUT the sidecar (sidecar-less / degraded /mcp 503):
#   docker build .
#   fly deploy --remote-only
#
# When KG_SOURCE_REPO is unset the build succeeds and logs "building without a knowledge graph".
# When the secret is absent the build succeeds and logs "sidecar-less build".
# All other routes remain healthy; only /mcp returns 503.
#
# Receipt rule: any fail-soft build step that skips a meaningful piece of work must
# write /app/kg/.embeddings-failed into the image. Using || echo alone is a
# silent-regression factory — the failure is visible in build logs but invisible to
# monitoring across deploys. The marker is checked by docker-entrypoint.sh at boot,
# which exports KG_EMBEDDINGS_DEGRADED=1 and surfaces the fact via GET / and the
# deploy notification. The || true copy guards below are exempt: they are part of
# the deliberate sidecar-less mode, not unexpected failures.
ARG KG_SOURCE_REPO
ENV KG_SOURCE_REPO=$KG_SOURCE_REPO
COPY kg/ /app/kg/
RUN --mount=type=secret,id=kg_token,required=false \
    if [ -z "$KG_SOURCE_REPO" ]; then \
        echo "[kg] KG_SOURCE_REPO not set — building without a knowledge graph; set it to serve one"; \
        exit 0; \
    fi \
    && kg_owner="${KG_SOURCE_REPO%%/*}" \
    && kg_repo="${KG_SOURCE_REPO#*/}" \
    && if [ "$kg_owner" = "$KG_SOURCE_REPO" ] || [ -z "$kg_owner" ] || [ -z "$kg_repo" ] || [ "$kg_repo" != "${kg_repo%%/*}" ]; then \
        echo "[kg] invalid KG_SOURCE_REPO: $KG_SOURCE_REPO" >&2; exit 1; \
    fi \
    && case "$kg_owner" in *[!A-Za-z0-9-]* | -* | *- ) echo "[kg] invalid KG_SOURCE_REPO owner: $KG_SOURCE_REPO" >&2; exit 1 ;; esac \
    && case "$kg_repo" in *[!A-Za-z0-9._-]* ) echo "[kg] invalid KG_SOURCE_REPO repo: $KG_SOURCE_REPO" >&2; exit 1 ;; esac \
    && if [ -f /run/secrets/kg_token ] && [ -s /run/secrets/kg_token ]; then \
        echo "[kg] secret present — cloning ${KG_SOURCE_REPO}" \
        && apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
        && rm -rf /var/lib/apt/lists/* \
        && KG_TOKEN="$(cat /run/secrets/kg_token)" \
        && git clone --depth 1 \
               "https://x-access-token:${KG_TOKEN}@github.com/${KG_SOURCE_REPO}.git" \
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
        || (touch /app/kg/.embeddings-failed && echo "[kg] WARNING: EMBEDDINGS BUILD FAILED — model warm failed; image will run lexical-only"); \
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
             || (touch /app/kg/.embeddings-failed && echo "[kg] WARNING: EMBEDDINGS BUILD FAILED — embed step failed; image ships graph-only (lexical search only)") ); \
    else \
        echo "[kg] no venv or snapshot — skipping materialize (sidecar-less)"; \
    fi

# Create data directory (Fly volume will mount here)
RUN mkdir -p /data

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Commit/repo/branch this image was built from. Last in the stage — a changing ARG busts every layer below it.
ARG SOURCE_COMMIT=unknown
ARG SOURCE_REPO=unknown
ARG SOURCE_BRANCH=unknown
ENV AI_IMPLEMENT_SOURCE_COMMIT=$SOURCE_COMMIT \
    AI_IMPLEMENT_SOURCE_REPO=$SOURCE_REPO \
    AI_IMPLEMENT_SOURCE_BRANCH=$SOURCE_BRANCH

USER node

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
