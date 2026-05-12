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
