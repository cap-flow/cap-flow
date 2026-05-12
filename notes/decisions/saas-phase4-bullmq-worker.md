---
date: 2026-05-11
stage: SaaS Phase 4
---

# SaaS Phase 4 — BullMQ worker, scheduled portfolio refresh

## Контекст

Phase 3 закрыла caching + quotas для upstream-вызовов. Phase 4 закрывает
**асинхронный** контур — то, что владелец описывал как «раз в час обновление
по всем портфелям, плюс по моей кнопке».

Без worker'а API процесс выполняет всю работу синхронно при HTTP-запросе:
открытие dashboard юзером → сразу 10-15 upstream-вызовов, ожидание 3-5 сек,
N юзеров одновременно × M кошельков = пиковые удары по Alchemy/DeBank +
исчерпание лимитов. С worker'ом dashboard читает уже-готовый `portfolio_snapshots`
и отвечает за миллисекунды; обновление идёт в фоне на расписании.

## Решение

**Архитектура: два процесса, одна Redis, одна Postgres.**

```
   ┌──────────────┐         ┌──────────────────────┐
   │ API process  │ enqueue │   BullMQ queue       │
   │ (server.ts)  │────────►│ portfolio-refresh    │
   └──────────────┘         └──────────────────────┘
         │                          │
         │ read status              │ pull
         │ /accounts/:id/refresh-status
         ▼                          ▼
   ┌──────────────┐         ┌──────────────────────┐
   │  Postgres    │◄────────│   Worker process     │
   │ snapshots,   │ insert  │  (worker.ts)         │
   │ audit_log    │         └──────────────────────┘
   └──────────────┘
```

API процесс **только enqueue-ит** jobs (`POST /accounts/:id/refresh`) и
читает status (`GET /accounts/:id/refresh-status`). Реальный refresh
происходит в `worker.ts` — отдельный процесс, который:

1. Подписывается на queue `portfolio-refresh` (concurrency 5).
2. При старте идёт по всем active accounts → `upsertJobScheduler` с
   `every: 1h` + deterministic jitter per accountId (см. `stableJitter`).
   Идемпотентно: повторный запуск не дублирует.
3. На каждый job вызывает `PortfolioRefreshService.refreshAccount(...)`.

### Два типа jobs
- **recurring**: scheduler id `account-<uuid>`, fires every 1h.
  `removeJobScheduler('account-<uuid>')` отзовёт при archive.
- **manual**: jobId `manual-<uuid>-<unix-seconds>`. Дедупликация
  внутри секунды (двойной клик не плодит).

### Refresh service — stub на Phase 4
`PortfolioRefreshService.refreshAccount` сейчас пишет deterministic-stub
snapshot: `{stub: true, trigger, refreshedFrom: [], totalUsd: 0, openPositions: 0}`.
**Pipeline + observability работают end-to-end** — когда Alchemy/DeBank
clients будут wire-нуты (отдельная задача при миграции фронтенда),
заменится **только тело этого метода**, остальное остаётся.

## Альтернативы

- **Не делать worker, гонять refresh в API процессе на cron**. Отвергли:
  блокирует event loop, не масштабируется горизонтально, нельзя отдельно
  ресайзить под нагрузку, retries сложнее.
- **`node-cron` вместо BullMQ**. Отвергли: нет retries, нет видимости
  состояния job-ов, нельзя ставить manual jobs в ту же очередь, нет UI
  типа bull-board.
- **Использовать Postgres LISTEN/NOTIFY вместо Redis-queue**. Отвергли:
  Redis уже в стеке для cache + quota (Phase 3), один инструмент для
  обеих задач. `volatile-lru` policy позволяет cache evict-ить, а
  job-records (без EXPIRE) держать.
- **Concurrency 1 чтобы не сжигать quota разом**. Отвергли: per-user
  квоты уже на уровне `QuotedPriceProvider` (Phase 3) — concurrency-5
  не нарушает per-user лимит, а параллелизация ускоряет общий refresh
  цикла. Если упрёмся в global rate-limit upstream — снизим.
- **Stateless cron вместо BullMQ jobs**. Отвергли: нет single-shot manual
  refresh, нет retries, нет видимости.

## Реализация

### Schema
- `packages/db/src/schema/portfolio_snapshots.ts` — TS-обёртка над
  existing-таблицей. Поля: `legacy_id` (unique per account), `date`,
  `is_manual text` ("false"/"true"), `metrics jsonb`, `positions jsonb`.

### API модуль
- `apps/api/src/modules/queue/portfolio-refresh.queue.ts` — `enqueueManual`,
  `scheduleRecurring`, `removeRecurring`, `recentForAccount`.
  Использует BullMQ 5 `upsertJobScheduler` API.
- `apps/api/src/modules/queue/portfolio-refresh.processor.ts` — обёртка
  над сервисом, преобразует BullMQ `Job` → domain call.
- `apps/api/src/modules/queue/connection.ts` — отдельный ioredis
  connection для BullMQ (требует `maxRetriesPerRequest: null`,
  `enableReadyCheck: false`).
- `apps/api/src/modules/portfolio/portfolio.repository.ts` — insertSnapshot,
  latestSnapshot, recentSnapshots.
- `apps/api/src/modules/portfolio/portfolio-refresh.service.ts` — stub
  pipeline (см. выше), пишет snapshot + audit row.
- `apps/api/src/modules/portfolio/portfolio.routes.ts`:
  - `POST /api/v1/accounts/:id/refresh` → enqueue manual, 202 + jobId.
  - `GET  /api/v1/accounts/:id/refresh-status` → latest snapshot + N
    recent jobs (id, state, trigger, finishedOn).

### Worker
- `apps/api/src/worker.ts` — entry point. Bootstrap: schedule recurring
  для каждого active account. Graceful shutdown SIGINT/SIGTERM.
- `package.json` scripts: `dev:worker` (tsx watch), `start:worker` (node
  dist).

### Infra
- `infra/docker-compose.dev.yml` — Redis `maxmemory-policy` поменян с
  `allkeys-lru` на `volatile-lru`. BullMQ требует чтобы job-keys (без
  EXPIRE) не выбрасывались под памятью; cache-keys (с EXPIRE) остаются
  evictable.

## E2E (6/6 пройдено)

| # | Сценарий | Результат |
|---|---|---|
| 1 | Worker bootstrap при старте | 4 recurring scheduler-а в Redis для всех active accounts |
| 2 | GET refresh-status сразу после bootstrap | `lastSnapshot` — cron-snapshot уже есть, `recentJobs` показывает completed + delayed |
| 3 | POST /accounts/:id/refresh от админа | 202 + `jobId=manual-<uuid>-<ts>` |
| 4 | wait 2s + GET refresh-status | `lastSnapshot.metrics.trigger="manual"`, в `recentJobs` появился `state=completed` |
| 5 | Alice POST refresh на свой account | 202 |
| 6 | Alice POST refresh на admin's account | 403 (tenant isolation через `accountsService.getById`) |
| 7 | audit_log по фильтру `portfolio.%` | `portfolio.refresh_manual: 2`, `portfolio.refresh_cron: 4` |
| 8 | snapshots по `trigger` | `manual: 2`, `cron: 4` |

## Ограничения

- **Refresh — stub**. Реальный pipeline (Alchemy balances → CoinGecko/cache
  prices → cost basis → metrics) подключится при миграции фронтенда. Сейчас
  snapshot пишет `metrics: {stub: true, totalUsd: 0, openPositions: 0}` —
  достаточно чтобы протестировать pipeline целиком.
- **scheduleRecurring / removeRecurring не дёргается из AccountsService
  при create / archive**. Сейчас оба пути работают через worker bootstrap
  (читает все active accounts при старте) — при добавлении нового account
  worker нужно либо перезапустить, либо запустить scheduleRecurring явно.
  Добавится hook в `accounts.routes.ts.POST /` → `refreshQueue.scheduleRecurring(...)`
  в next iteration (тривиальная правка).
- **Нет dead-letter / alerting** на постоянно падающие jobs. BullMQ
  retries (`attempts: 3, exponential backoff`) — есть; alerts когда job
  3 раза подряд упал — Phase 5 + Phase 7 (Telegram alerts).
- **Concurrency 5 — статическая**. При росте до 100+ accounts нужно либо
  увеличить, либо запустить несколько worker процессов (BullMQ это
  поддерживает — несколько Worker'ов на одну queue делят jobs).
- **Worker и API делят одну Redis**. Под нагрузкой может потребоваться
  разделение (BullMQ на отдельной Redis, cache+quota на другой). На beta
  с 25 юзерами не критично — `maxmemory 256mb` достаточно.
- **`historical_prices` lazy-fill через worker** — ещё не реализован.
  Когда реальный refresh заработает, при cold-miss на исторические даты
  будет писать в `historical_prices` (этой схемой Phase 2 уже подготовил).
- **Bull-board UI** — admin не имеет визуализации queue в браузере. Можно
  легко подключить `@bull-board/fastify` (Phase 5 admin panel).
