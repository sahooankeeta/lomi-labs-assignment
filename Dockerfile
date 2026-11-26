# One Dockerfile for every app. Build with --build-arg APP=<api|worker|db|web>.
# `turbo prune` cuts the monorepo down to the target and its workspace deps,
# so each image installs only what that app needs.

FROM node:24-alpine AS base
# Prisma's schema engine (migrate deploy) needs OpenSSL on Alpine.
RUN apk add --no-cache openssl
RUN npm install -g pnpm@12.14.0 turbo@2.11.13
WORKDIR /app

# 1. Prune the repo to the target package.
FROM base AS pruner
ARG APP
COPY . .
RUN turbo prune @lomi/${APP} --docker

# 2. Install deps from the pruned lockfile (cached unless package.jsons change), then build.
FROM base AS builder
ARG APP
COPY --from=pruner /app/out/json/ .
RUN pnpm install --frozen-lockfile
COPY --from=pruner /app/out/full/ .
RUN pnpm turbo run build --filter=@lomi/${APP}...

# 3a. Node services (api, worker, db migrate/seed) run straight from the build stage.
FROM builder AS node-app
ENV NODE_ENV=production
COPY fixtures ./fixtures

# 3b. The web app is static files served by nginx, which also proxies /api.
FROM nginx:1.29-alpine AS web
# Only warnings and errors from nginx itself (default is notice: a line per worker process).
RUN sed -i 's/ notice;/ warn;/' /etc/nginx/nginx.conf
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --chmod=755 apps/web/docker/40-log-connections.sh /docker-entrypoint.d/40-log-connections.sh
COPY --from=builder /app/apps/web/dist /usr/share/nginx/html
