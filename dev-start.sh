#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Capflow — запуск ВСЕГО локального стека одной командой.
#   1. проверяет Docker (Postgres + Redis обязательны);
#   2. поднимает инфраструктуру, если она не отвечает;
#   3. запускает backend (api + worker) и frontend (vite) и стримит их логи.
# Останавливается по Ctrl+C — гасит оба процесса.
#
# Запуск:  ./dev-start.sh
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

c_green=$'\033[0;32m'; c_yellow=$'\033[0;33m'; c_red=$'\033[0;31m'; c_dim=$'\033[2m'; c_off=$'\033[0m'
say()  { printf "%s\n" "${c_green}▸ $*${c_off}"; }
warn() { printf "%s\n" "${c_yellow}⚠ $*${c_off}"; }
die()  { printf "%s\n" "${c_red}✘ $*${c_off}"; exit 1; }

port_up() { nc -z localhost "$1" >/dev/null 2>&1; }

# ── 0. Node ──────────────────────────────────────────────────────────────────
node_major="$(node -v 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/')"
if [ -z "$node_major" ]; then
  die "Node не найден. Установи Node ≥ 22.19 (рабочий — 25/26)."
elif [ "$node_major" -lt 22 ]; then
  warn "Node $(node -v): проекту нужен ≥ 22.19 (undici). api может не стартовать — переключись через nvm/brew."
fi

# ── 1. Docker daemon ─────────────────────────────────────────────────────────
if ! docker info >/dev/null 2>&1; then
  die "Docker не запущен. Открой Docker Desktop, дождись зелёного статуса и повтори."
fi

# ── 2. Инфраструктура: Postgres (5432) + Redis (6379) ────────────────────────
ensure_infra() {
  if port_up 5432 && port_up 6379; then
    say "Postgres :5432 и Redis :6379 уже подняты."
    return 0
  fi
  say "Поднимаю инфраструктуру…"
  # Сначала пробуем запустить УЖЕ существующие контейнеры (без пересоздания —
  # чтобы не плодить дубликаты с пустой БД).
  docker start capflow-postgres >/dev/null 2>&1 || true
  for r in cap-flow-dev-redis-1 cap-flow-redis-1; do
    docker start "$r" >/dev/null 2>&1 || true
  done
  # Если контейнеров нет — поднимаем сервисы из compose.
  if ! port_up 5432 || ! port_up 6379; then
    docker compose -f infra/docker-compose.yml up -d postgres redis >/dev/null 2>&1 || true
  fi
  # Ждём готовности до 40с.
  for _ in $(seq 1 40); do
    port_up 5432 && port_up 6379 && { say "Инфраструктура готова."; return 0; }
    sleep 1
  done
  die "Postgres/Redis не поднялись за 40с. Проверь Docker Desktop и контейнеры (docker ps)."
}
ensure_infra

# ── 3. Backend (api + worker) и Frontend (vite) ──────────────────────────────
pids=()
cleanup() {
  printf "\n%s\n" "${c_dim}Останавливаю api/web…${c_off}"
  for p in "${pids[@]:-}"; do kill "$p" >/dev/null 2>&1 || true; done
  # добиваем дочерние tsx/vite
  pkill -P $$ >/dev/null 2>&1 || true
  exit 0
}
trap cleanup INT TERM

say "Запускаю backend (api + worker)…"
( cd apps/api && pnpm dev 2>&1 | sed -u "s/^/${c_dim}[api]${c_off} /" ) &
pids+=("$!")

say "Запускаю frontend (vite)…"
( cd apps/web && pnpm dev 2>&1 | sed -u "s/^/${c_dim}[web]${c_off} /" ) &
pids+=("$!")

printf "\n%s\n" "${c_green}Стек поднимается:${c_off}  web → http://localhost:5173   api → http://localhost:3000"
printf "%s\n\n" "${c_dim}Ctrl+C — остановить всё.${c_off}"

wait
