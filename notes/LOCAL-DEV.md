# Локальный запуск Capflow

## Одной командой

```
./dev-start.sh
```
Проверит Docker, поднимет Postgres+Redis (если не отвечают), запустит backend
(api + worker) и frontend (vite). Ctrl+C — остановить всё. Логи помечены `[api]`/`[web]`.

## Вручную (по шагам)

1. **Docker Desktop** — запустить (Postgres :5432 и Redis :6379 обязательны).
   Если контейнеры не поднялись сами:
   `docker compose -f infra/docker-compose.yml up -d postgres redis`
2. **backend** (отдельное окно): `cd apps/api && pnpm dev`  → server + worker.
3. **frontend** (отдельное окно): `cd apps/web && pnpm dev` → http://localhost:5173

## Проверка, что всё живо
```
docker ps | grep -E "postgres|redis"                              # Up
curl -s -o /dev/null -w "%{http_code}\n" localhost:3000/health    # 200
curl -s -o /dev/null -w "%{http_code}\n" localhost:5173           # 200
```

⚠ Node ≥ 22.19 (рабочий 25/26). node 20 → api падает на старте (undici/webidl).
