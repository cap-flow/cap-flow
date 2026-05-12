# syntax=docker/dockerfile:1.7
# Multi-stage Dockerfile for @cap-flow/api.
# Build context MUST be the monorepo root.

ARG NODE_VERSION=20.18.1
ARG PNPM_VERSION=9.12.3

# ───────────────────────────── 1. base ─────────────────────────────
FROM node:${NODE_VERSION}-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# Install pnpm directly via npm. Bypasses corepack's signature
# verification, which breaks in this base image (stale baked-in keys
# can't validate freshly-published pnpm tarballs).
RUN npm install -g pnpm@${PNPM_VERSION}
WORKDIR /repo

# ─────────────────────────── 2. fetch deps ──────────────────────────
FROM base AS deps
COPY pnpm-workspace.yaml pnpm-lock.yaml* package.json ./
COPY apps/api/package.json apps/api/package.json
COPY packages/db/package.json packages/db/package.json
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# ───────────────────────────── 3. build ─────────────────────────────
FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/db packages/db
COPY apps/api apps/api
RUN pnpm --filter @cap-flow/db run build && \
    pnpm --filter @cap-flow/api run build

# ────────────────────────── 4. production deps ───────────────────────
FROM base AS prod-deps
COPY pnpm-workspace.yaml pnpm-lock.yaml* package.json ./
COPY apps/api/package.json apps/api/package.json
COPY packages/db/package.json packages/db/package.json
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod

# ─────────────────────────── 5. runtime ─────────────────────────────
FROM node:${NODE_VERSION}-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

RUN apk add --no-cache tini wget && \
    addgroup -S app && adduser -S app -G app

COPY --from=prod-deps --chown=app:app /repo/node_modules ./node_modules
COPY --from=prod-deps --chown=app:app /repo/apps/api/node_modules ./apps/api/node_modules
COPY --from=prod-deps --chown=app:app /repo/packages/db/node_modules ./packages/db/node_modules
COPY --from=build --chown=app:app /repo/apps/api/dist ./apps/api/dist
COPY --from=build --chown=app:app /repo/apps/api/package.json ./apps/api/package.json
COPY --from=build --chown=app:app /repo/packages/db/dist ./packages/db/dist
COPY --from=build --chown=app:app /repo/packages/db/drizzle ./packages/db/drizzle
COPY --from=build --chown=app:app /repo/packages/db/package.json ./packages/db/package.json

USER app
WORKDIR /app/apps/api
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/health || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/server.js"]
