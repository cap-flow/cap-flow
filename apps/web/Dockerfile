# syntax=docker/dockerfile:1.7
# Multi-stage Dockerfile for @cap-flow/web.
# Build context MUST be the monorepo root.

ARG NODE_VERSION=20.18.1
ARG PNPM_VERSION=9.12.3
ARG VITE_API_URL=/api

# ───────────────────────────── 1. base ─────────────────────────────
FROM node:${NODE_VERSION}-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
WORKDIR /repo

# ─────────────────────────── 2. fetch deps ──────────────────────────
FROM base AS deps
COPY pnpm-workspace.yaml pnpm-lock.yaml* package.json ./
COPY apps/web/package.json apps/web/package.json
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @cap-flow/web...

# ───────────────────────────── 3. build ─────────────────────────────
FROM deps AS build
ARG VITE_API_URL
ENV VITE_API_URL=${VITE_API_URL}
COPY tsconfig.base.json ./
COPY apps/web apps/web
RUN pnpm --filter @cap-flow/web run build

# ─────────────────────── 4. runtime (Caddy static) ───────────────────
FROM caddy:2.8-alpine AS runtime
WORKDIR /srv
COPY --from=build /repo/apps/web/dist /srv
COPY apps/web/Caddyfile /etc/caddy/Caddyfile

EXPOSE 80
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:80/ >/dev/null || exit 1
