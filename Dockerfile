FROM node:24-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN apk add --no-cache python3 make g++
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build

# ---------- Production stage ----------
FROM node:24-alpine

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
