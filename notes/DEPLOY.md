---
updated: 2026-05-12
---

# Deploy Runbook — cap-flow.ru

Step-by-step guide for going from a fresh VPS to a running production
stack. Read top-to-bottom on first deploy; jump to **§ Routine deploys**
on subsequent rollouts.

---

## 0. Prerequisites

- VPS reachable via SSH (root or sudo user).
- DNS: `cap-flow.ru` and `www.cap-flow.ru` A-records point to the VPS IP.
- Ports `80` and `443` open in the cloud firewall.
- GitHub repo has GHCR enabled (Settings → Packages).

---

## 1. Provision the VPS (one-time)

```bash
ssh <user>@cap-flow.ru

# Docker Engine + compose plugin.
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER && newgrp docker

# Compose plugin ships with docker-ce on Ubuntu/Debian; verify:
docker compose version

# Working directory the deploy workflow scp's into.
sudo mkdir -p /opt/cap-flow && sudo chown $USER:$USER /opt/cap-flow
cd /opt/cap-flow
mkdir -p backups/pre-deploy
```

---

## 2. Provision `/opt/cap-flow/.env` (one-time)

```bash
# On the VPS, in /opt/cap-flow:
scp local-host:/path/to/repo/.env.prod.example ./.env.prod.example
cp .env.prod.example .env
chmod 600 .env
$EDITOR .env
```

Fill every `[REQUIRED]` slot. Generate secrets with:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
# → JWT_SECRET, COOKIE_SECRET (run twice)

openssl rand -base64 32
# → POSTGRES_PASSWORD (then update DATABASE_URL to match)
```

Mandatory keys for first boot:

- `POSTGRES_PASSWORD` + `DATABASE_URL` (user/pw aligned)
- `JWT_SECRET`, `COOKIE_SECRET` (≥32 chars each)
- `CORS_ORIGIN=https://cap-flow.ru`
- `COOKIE_DOMAIN=.cap-flow.ru`, `COOKIE_SECURE=true`
- `CADDY_DOMAIN=cap-flow.ru`, `CADDY_ACME_EMAIL=...`
- `ALCHEMY_API_KEY`, `DEBANK_API_KEY`, `ETHERSCAN_API_KEY`, `HELIUS_API_KEY`
  (the four required upstreams)

Optional (can stay empty for beta):
`RESEND_API_KEY`, `TELEGRAM_BOT_USERNAME`, `COINGECKO_API_KEY`,
`COINSTATS_API_KEY`, `TRONSCAN_API_KEY`, `BILLING_ADDRESS_POOL_*`.

---

## 3. GitHub Secrets (one-time)

`Settings → Secrets and variables → Actions → New repository secret`:

| Secret | Value |
|---|---|
| `DEPLOY_HOST` | `cap-flow.ru` (or VPS IP) |
| `DEPLOY_USER` | SSH user with docker group access |
| `DEPLOY_SSH_KEY` | private key, PEM format, matching pubkey in VPS `~/.ssh/authorized_keys` |
| `GHCR_USER` | GitHub username (lowercase) |
| `GHCR_TOKEN` | PAT with `read:packages`, `write:packages` |

---

## 4. First deploy

```bash
# From your local machine.
git checkout main
git push origin main          # triggers .github/workflows/deploy.yml
```

The workflow will:

1. Run `ci.yml` (lint + tests).
2. Build + push `cap-flow-api` and `cap-flow-web` to GHCR.
3. `scp` `infra/docker-compose.yml` and `infra/caddy/Caddyfile` to `/opt/cap-flow/`.
4. SSH in, write `.env.images`, pull, `pg_dump` snapshot, run migrate,
   `docker compose up -d`, smoke-test `/health` + `https://cap-flow.ru/api/v1/users`.
5. Roll back to the previous image tags if the smoke test fails.

Watch in the Actions tab. On success Caddy provisions Let's Encrypt
certs automatically (first request after start triggers ACME).

---

## 5. Routine deploys

Every push to `main` runs the same pipeline. No manual action on the VPS.

To deploy manually without a code change:

```bash
gh workflow run deploy.yml
```

---

## 6. Health checks

```bash
# On the VPS:
docker compose -f infra/docker-compose.yml ps             # all "healthy"
docker compose -f infra/docker-compose.yml logs --tail=100 api worker

# Externally:
curl -fsS https://cap-flow.ru/api/health
curl -fsS https://cap-flow.ru/                            # SPA index
```

---

## 7. Rollback

The deploy workflow rolls back automatically on a failed smoke test by
restoring `.env.images.previous`. To roll back manually:

```bash
cd /opt/cap-flow
cat .env.images          # current tags
# Set API_IMAGE / WEB_IMAGE to a known-good GHCR tag, then:
docker compose -f infra/docker-compose.yml --env-file .env --env-file .env.images up -d
```

DB rollback uses the gzip dumps in `backups/pre-deploy/`:

```bash
ls -lt backups/pre-deploy/ | head -5
gunzip -c backups/pre-deploy/20260512-120000-abc1234.sql.gz | \
  docker compose exec -T postgres psql -U capflow capflow
```

---

## 8. Known operational items

- **CSP** still includes `'unsafe-inline'` for styles — tighten after the
  dashboard refactor (post-beta).
- **Backup retention**: keeps the last 30 pre-deploy snapshots. Add an
  offsite copy (rclone / borg) before going public.
- **Redis persistence**: AOF only, no RDB snapshots. Cache loss on a
  hard restart is acceptable; durable state is in Postgres.
- **No log aggregation yet** (P6.4) — `docker compose logs` is the
  current observability story.

---

## 9. Bare-metal deploy (F1) — alternative к Docker Compose

Если по какой-то причине нужен deploy без Docker (e.g. shared VPS,
hardened systemd policy, debug locally) — есть systemd-первая
конфигурация в `infra/systemd/`.

### 9.1. Provision

```bash
# Создать user без shell login.
sudo useradd --system --shell /usr/sbin/nologin --home /srv/capflow capflow
sudo mkdir -p /srv/capflow /etc/capflow /var/backups/capflow
sudo chown -R capflow:capflow /srv/capflow /var/backups/capflow

# Скопировать built артефакты (после `pnpm build`):
sudo rsync -a apps/api/dist /srv/capflow/apps/api/
sudo rsync -a packages/db/dist /srv/capflow/packages/db/

# Env файл (НЕ в git):
sudo tee /etc/capflow/api.env <<'EOF'
NODE_ENV=production
LOG_LEVEL=info
DATABASE_URL=postgres://capflow:***@localhost:5432/capflow
REDIS_URL=redis://localhost:6379
JWT_SECRET=<64-char hex>
COOKIE_DOMAIN=cap-flow.ru
COOKIE_SECURE=true
EOF
sudo chmod 640 /etc/capflow/api.env
sudo chown root:capflow /etc/capflow/api.env
```

### 9.2. Install systemd units

```bash
sudo cp infra/systemd/capflow-api.service /etc/systemd/system/
sudo cp infra/systemd/capflow-worker.service /etc/systemd/system/
sudo cp infra/systemd/capflow-backup.service /etc/systemd/system/
sudo cp infra/systemd/capflow-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload

# Запустить core services
sudo systemctl enable --now capflow-api capflow-worker

# Backup timer (если /etc/capflow/backup.env настроен)
sudo systemctl enable --now capflow-backup.timer
```

### 9.3. Verify

```bash
sudo systemctl status capflow-api capflow-worker
journalctl -u capflow-api -f       # follow logs
curl http://localhost:3000/health  # liveness
infra/scripts/healthcheck.sh       # readiness + liveness
```

### 9.4. Health monitoring

Внешний uptime monitor (Uptime Kuma / healthchecks.io / Pingdom):
- URL: `https://cap-flow.ru/api/health/ready`
- HTTP 200 = healthy, 503 = DB/Redis down
- Recommended interval: 60s

Admin UI (`/admin/health`, F3) — внутри-приложения snapshot всех
subsystems (DB pool, Redis ping, BullMQ queue, wallets/CEX sync state).
Refresh каждые 15s, требует admin role.

### 9.5. Backup

`infra/scripts/backup-postgres.sh` запускается через
`capflow-backup.timer` daily @ 03:00 UTC. Конфигурация в
`/etc/capflow/backup.env`:

```bash
POSTGRES_HOST=localhost
POSTGRES_USER=capflow
POSTGRES_DB=capflow
PGPASSWORD=<secret>
BACKUP_DIR=/var/backups/capflow
RETENTION_DAYS=14
BACKUP_REMOTE_URL=s3:capflow-backups/postgres   # optional, requires rclone
```

Восстановление:
```bash
gunzip -c /var/backups/capflow/capflow-<TS>.sql.gz | psql -U capflow -d capflow_new
```

### 9.6. Production checklist (pre-launch)

- [ ] DNS A-records настроены (cap-flow.ru + www.cap-flow.ru)
- [ ] TLS работает (Caddy auto-ACME ИЛИ Let's Encrypt cert)
- [ ] `JWT_SECRET` уникальный, ≥64 chars
- [ ] `COOKIE_SECURE=true` (HTTPS only)
- [ ] `COOKIE_DOMAIN` совпадает с production hostname
- [ ] `CORS_ORIGIN` whitelist'ит только production frontend domain
- [ ] PostgreSQL backup настроен + первый тестовый restore сделан
- [ ] External uptime monitor зарегистрирован на `/health/ready`
- [ ] Admin user'ы засеяны (через invite или DB seed)
- [ ] Все migrations применены: `pnpm db:migrate` или `docker compose run migrate`
- [ ] `/admin/health` показывает overall='ok' для всех secrets-зависимых subsystems
- [ ] Sentry / error tracking настроен (если в стэке)
- [ ] `notes/DEPLOY.md` § 0–9 пройден полностью (на новой VPS)
- [ ] Smoke test: register user → connect wallet → видит positions
