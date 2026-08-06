# Keep the Node version aligned with the repo pins and the image immutable;
# better-sqlite3 is a native addon whose lifecycle behavior can change across Node releases.
FROM node:24.15.0-alpine@sha256:d1b3b4da11eefd5941e7f0b9cf17783fc99d9c6fc34884a665f40a06dbdfc94f AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN apk add --no-cache python3 make g++
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build

# ---------- Production stage ----------
FROM node:24.15.0-alpine@sha256:d1b3b4da11eefd5941e7f0b9cf17783fc99d9c6fc34884a665f40a06dbdfc94f

WORKDIR /app

COPY package.json package-lock.json ./
RUN apk add --no-cache --virtual .native-build-deps python3 make g++ \
    && npm ci --omit=dev \
    && apk del .native-build-deps

COPY --from=builder /app/dist ./dist
COPY pipelines/ ./pipelines/
COPY workflows/ ./workflows/

# Create data directory (Fly volume will mount here)
RUN mkdir -p /data

USER node

CMD ["node", "dist/index.js"]
