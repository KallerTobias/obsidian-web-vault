# syntax=docker/dockerfile:1

# ---- build: install all deps, bundle the frontend and the server ----
FROM node:22-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY shared ./shared
COPY server ./server
COPY web ./web
RUN npm run build

# ---- deps: production dependencies only (the server bundle keeps packages external) ----
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force \
 && find node_modules \( -name "*.map" -o -name "*.d.ts" -o -name "*.d.mts" -o -name "*.d.cts" -o -iname "*.md" \) -type f -delete

# ---- runtime: plain Alpine plus only the node binary (no npm/yarn/headers; keeps the image small).
# Keep the Alpine version in line with the node:22-alpine base (musl/libstdc++ compatibility).
FROM node:22-alpine AS node

FROM alpine:3.24
ARG VERSION=dev
LABEL org.opencontainers.image.title="obsidian-web-vault" \
      org.opencontainers.image.description="Self-hosted web editor for an Obsidian vault, passkey-only login" \
      org.opencontainers.image.source="https://github.com/KallerTobias/obsidian-web-vault" \
      org.opencontainers.image.url="https://github.com/KallerTobias/obsidian-web-vault" \
      org.opencontainers.image.version="${VERSION}"

RUN apk add --no-cache su-exec libstdc++ \
 && addgroup -g 1000 node && adduser -u 1000 -G node -s /bin/sh -D node
COPY --from=node /usr/local/bin/node /usr/local/bin/node
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /src/dist ./dist
COPY package.json ./
COPY docker/obsidian-web-vault.sh /usr/local/bin/obsidian-web-vault
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 0755 /usr/local/bin/obsidian-web-vault /usr/local/bin/entrypoint.sh \
 && mkdir -p /vault /data && chown node:node /vault /data

ENV NODE_ENV=production \
    PORT=8080 \
    VAULT_DIR=/vault \
    DATA_DIR=/data \
    UMASK=002

EXPOSE 8080
VOLUME ["/vault", "/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/health" >/dev/null || exit 1

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["serve"]
