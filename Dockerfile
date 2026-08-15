# syntax=docker/dockerfile:1.7

# ---------------------------------------------------------------------------
# Careflow API / worker image.
#
# One image serves the API and all three workers; the process is selected by the
# container command. This keeps the ECR footprint small and guarantees that a
# worker and the API can never drift to different application versions.
# ---------------------------------------------------------------------------

# ---- Stage 1: dependencies (cacheable) ------------------------------------
FROM node:22.22-alpine AS deps
WORKDIR /app

# argon2 is a native module and needs a toolchain to build its bindings.
RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# ---- Stage 2: build ------------------------------------------------------
FROM node:22.22-alpine AS build
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.json tsconfig.build.json ./
COPY src ./src

RUN npm run build

# ---- Stage 3: production dependencies only -------------------------------
FROM node:22.22-alpine AS prod-deps
WORKDIR /app

RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# ---- Stage 4: runtime ----------------------------------------------------
FROM node:22.22-alpine AS runtime
WORKDIR /app

# `dumb-init` reaps zombies and forwards SIGTERM to node, which is what makes
# graceful shutdown work during an ECS rolling deployment.
# The RDS CA bundle lets `pg` verify TLS (`DB_SSL=true`, rejectUnauthorized).
RUN apk add --no-cache dumb-init curl \
  && curl -fsSL -o /etc/ssl/certs/rds-global-bundle.pem \
    https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem \
  && addgroup -g 10001 -S careflow \
  && adduser -u 10001 -S careflow -G careflow

ENV NODE_ENV=production \
    NODE_OPTIONS="--enable-source-maps" \
    NODE_EXTRA_CA_CERTS=/etc/ssl/certs/rds-global-bundle.pem \
    PORT=3000

COPY --from=prod-deps --chown=10001:10001 /app/node_modules ./node_modules
COPY --from=build --chown=10001:10001 /app/dist ./dist
COPY --chown=10001:10001 package.json ./
COPY --chown=10001:10001 migrations ./migrations

USER 10001:10001
EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/health" || exit 1

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/main.js"]
