# cap-flow

Production-ready monorepo: **React (Vite) + Fastify + Drizzle ORM + PostgreSQL + Caddy**, packaged with Docker, orchestrated by `docker compose`, and deployed via GitHub Actions.

## Stack

| Layer       | Tool                                                     |
| ----------- | -------------------------------------------------------- |
| Frontend    | React 18, Vite, TypeScript, React Router, TanStack Query |
| API         | Fastify 5, Zod validation (`fastify-type-provider-zod`)  |
| ORM         | Drizzle (`drizzle-orm/node-postgres`) + `drizzle-kit`    |
| Database    | PostgreSQL 16                                            |
| Reverse proxy | Caddy 2 (auto-HTTPS in prod)                           |
| Container   | Multi-stage Docker images, `docker compose`              |
| CI/CD       | GitHub Actions → GHCR → SSH deploy                       |
| Package mgr | pnpm 9 workspaces                                        |

## Layout

```
cap-flow/
├── apps/
│   ├── api/                    # Fastify REST API
│   │   ├── src/
│   │   │   ├── config/env.ts          # Zod-validated env loader
│   │   │   ├── core/errors.ts         # Domain error hierarchy
│   │   │   ├── plugins/
│   │   │   │   ├── db.ts              # Drizzle client as Fastify plugin
│   │   │   │   └── error-handler.ts
│   │   │   ├── modules/users/         # One module per domain entity
│   │   │   │   ├── users.schema.ts    # Zod DTOs
│   │   │   │   ├── users.repository.ts # Persistence (DIP boundary)
│   │   │   │   ├── users.service.ts   # Business rules
│   │   │   │   └── users.routes.ts    # HTTP layer
│   │   │   ├── app.ts
│   │   │   └── server.ts
│   │   └── Dockerfile
│   └── web/                    # React + Vite SPA
│       ├── src/
│       │   ├── lib/api/client.ts      # Typed fetch wrapper (Zod-validated)
│       │   ├── features/users/        # Feature-sliced (api + hooks + UI)
│       │   ├── components/ui/         # Generic, presentational
│       │   ├── pages/                 # Route components
│       │   ├── App.tsx
│       │   └── main.tsx
│       ├── Caddyfile           # Internal SPA file-server
│       └── Dockerfile
├── packages/
│   └── db/                     # Single source of truth for the DB schema
│       ├── src/
│       │   ├── schema/         # Drizzle table definitions
│       │   ├── client.ts       # createDbClient(...)
│       │   └── migrate.ts      # Migration runner
│       ├── drizzle/            # Generated SQL migrations (committed)
│       └── drizzle.config.ts
├── infra/
│   ├── caddy/Caddyfile         # Edge reverse proxy
│   └── docker-compose.yml      # postgres + api + web + caddy + (migrate)
├── .github/workflows/
│   ├── ci.yml                  # typecheck + build on PR
│   └── deploy.yml              # build → push GHCR → SSH deploy
├── pnpm-workspace.yaml
├── tsconfig.base.json          # strict: true (all strict-* flags on)
└── package.json
```

## Local development

```bash
# 1. Install
pnpm install

# 2. Configure env
cp .env.example .env
# Override DATABASE_URL to localhost when running outside Docker:
#   DATABASE_URL=postgres://capflow:change_me_in_production@localhost:5432/capflow

# 3. Bring up Postgres only
docker compose -f infra/docker-compose.yml up -d postgres

# 4. Run migrations
pnpm --filter @cap-flow/db run generate   # if you changed schema
pnpm --filter @cap-flow/db run migrate

# 5. Start everything (api + web in parallel, hot reload)
pnpm dev
# → web:  http://localhost:5173  (proxies /api → :3000)
# → api:  http://localhost:3000
```

## Production-style local run (full Docker)

```bash
cp .env.example .env
pnpm docker:up                              # builds & starts everything
docker compose -f infra/docker-compose.yml --profile tools run --rm migrate
# → http://localhost  (Caddy on :80)
```

## Adding a new feature (DB → API → Web)

The pattern below is what every new feature follows. The `users` module is the canonical example.

### 1. DB (`packages/db`)

1. Add a table file in `packages/db/src/schema/`, e.g. `posts.ts`.
2. Re-export it from `packages/db/src/schema/index.ts`.
3. Generate a migration: `pnpm db:generate`.
4. Apply locally: `pnpm db:migrate`.

In production, migrations run automatically on every deploy via the `migrate` compose service (see `.github/workflows/deploy.yml`).

### 2. API (`apps/api/src/modules/<feature>/`)

Create five files mirroring `users/`:

- `*.schema.ts` — Zod DTOs (request/response).
- `*.repository.ts` — `class FooRepository implements IFooRepository`. Only Drizzle here.
- `*.service.ts` — Business rules. Depends on `IFooRepository`, not on `Database`.
- `*.routes.ts` — Wires repo + service, registers Fastify routes with `withTypeProvider<ZodTypeProvider>()`.
- Register the module in `apps/api/src/app.ts` under `/api/v1`.

### 3. Web (`apps/web/src/features/<feature>/`)

- `api.ts` — Zod schema + `usersApi`-style object using the typed `api` client.
- `hooks.ts` — `useFoo()` / `useCreateFoo()` via TanStack Query.
- `FooList.tsx`, `CreateFooForm.tsx` — feature components.
- Add a route page in `src/pages/` and register it in `App.tsx`.

## Deployment

### One-time server setup

```bash
# On the target server, as the deploy user:
sudo mkdir -p /opt/cap-flow/infra/caddy
sudo chown -R $USER:$USER /opt/cap-flow

# Provision the production env (NEVER commit this, NEVER ship it from CI)
cat > /opt/cap-flow/.env <<'EOF'
POSTGRES_USER=capflow
POSTGRES_PASSWORD=<strong-password>
POSTGRES_DB=capflow
DATABASE_URL=postgres://capflow:<strong-password>@postgres:5432/capflow
NODE_ENV=production
LOG_LEVEL=info
CORS_ORIGIN=https://cap-flow.ru
CADDY_DOMAIN=cap-flow.ru
CADDY_ACME_EMAIL=admin@cap-flow.ru
EOF
chmod 600 /opt/cap-flow/.env
```

### GitHub repository secrets

| Secret           | Purpose                                              |
| ---------------- | ---------------------------------------------------- |
| `DEPLOY_HOST`    | Server hostname / IP                                 |
| `DEPLOY_USER`    | SSH user                                             |
| `DEPLOY_SSH_KEY` | Private key (matching pubkey in `~/.ssh/authorized_keys`) |
| `GHCR_USER`      | GitHub user / org with read access to GHCR          |
| `GHCR_TOKEN`     | PAT with `read:packages` (used by the server to pull) |

Variable: `VITE_API_URL` (Repository → Variables) — defaults to `/api`.

### Flow

1. Push to `main` → `ci.yml` validates types and builds.
2. `deploy.yml`:
   - Builds & pushes `cap-flow-api` and `cap-flow-web` to GHCR (tagged with the commit SHA + `latest`).
   - SCPs `infra/docker-compose.yml` and `infra/caddy/Caddyfile` to `/opt/cap-flow`.
   - SSHs in, logs into GHCR, runs `migrate`, then `up -d`.

A failed migration aborts the deploy before traffic switches over.

### DNS for cap-flow.ru

Point both records at the server's public IP:

```
A     cap-flow.ru        → <server-ip>
A     www.cap-flow.ru    → <server-ip>
```

After the first deploy with `CADDY_DOMAIN=cap-flow.ru`, Caddy will automatically obtain a Let's Encrypt certificate (HTTP-01 challenge — make sure ports 80 and 443 are open). `www.cap-flow.ru` is permanently redirected to `https://cap-flow.ru`.

## Strict TypeScript

All packages extend `tsconfig.base.json` which enables every `strict*` flag plus `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`. New code must compile cleanly under these rules.

## Useful scripts

| Command              | Effect                                       |
| -------------------- | -------------------------------------------- |
| `pnpm dev`           | api + web in dev mode (parallel)             |
| `pnpm build`         | Build all packages                           |
| `pnpm typecheck`     | Typecheck the whole monorepo                 |
| `pnpm db:generate`   | Generate Drizzle migrations from schema      |
| `pnpm db:migrate`    | Apply migrations to the configured DB        |
| `pnpm db:studio`     | Drizzle Studio (web UI)                      |
| `pnpm docker:up`     | Build & start the full stack via compose     |
| `pnpm docker:down`   | Stop the stack                               |
