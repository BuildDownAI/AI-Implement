FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build

# ---------- Production stage ----------
FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
COPY pipelines/ ./pipelines/
COPY workflows/ ./workflows/

# Create data directory (Fly volume will mount here)
RUN mkdir -p /data

USER node

CMD ["node", "dist/index.js"]
