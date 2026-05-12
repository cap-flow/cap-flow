---
date: 2026-05-11
stage: SaaS Phase 5
---

# SaaS Phase 5 — admin panel API (users, portfolios, SaaS metrics, audit, tech audit, queue)

## Контекст

Phase 0-4 построили auth, multi-tenancy, providers/cache, scheduled refresh.
Phase 5 закрывает **видимый администратору слой**: список юзеров с
агрегатами, аналитика всех портфелей, SaaS-метрики (DAU/WAU/MAU,
активация), audit-log viewer, авто-детектор аномалий и queue health.

Фронтенд админ-панели — отдельная задача. Этой фазой закрыты все backend
endpoints, на которые он будет подписан.

## Решение

Семь endpoint-семейств под `/api/v1/admin/*`, все требуют `requireAdmin`.

### 1. `GET /admin/users`
Расширенный список с фильтрами (`status` / `role` / `search` по email+name)
и **per-user агрегатами**: accountCount, lastSnapshotAt, lastSnapshotUsd.
Одна SQL-query с коррелированными subqueries — компромисс
читаемости/производительности. Для >100 юзеров промотируем в materialised
view.

### 2. `PATCH /admin/users/:id/status` + `/role`
- `setStatus(active|pending|blocked)` — при не-active автоматически revoked
  все активные сессии юзера.
- `setRole(admin|user|viewer)` — смена роли.
- Оба пишут в `audit_log` с `as_admin=true`, `target_user_id`,
  `payload.from/to`.

### 3. `POST/DELETE /admin/users/:id/impersonate`
Перенесён из Phase 2 в единый admin-users модуль. `/me` теперь
возвращает `impersonation: {impersonatorId, mode}` (Phase 2 этого не
прокидывал на фронт) — нужно для рендера баннера «вы под Alice».
Refresh-rotation создаёт обычную сессию без impersonatedById — баннер
автоматически снимается.

### 4. `GET /admin/portfolios`
Таблица аккаунтов: `accountName, ownerEmail, lastSnapshotUsd,
snapshotCount24h, errors24h, lastTrigger`. Коррелированные subqueries
для last snapshot + 24h counts.

### 5. `GET /admin/portfolios/aggregate`
Платформенные тоталы: активных аккаунтов, активных юзеров, **TVL через
LATERAL JOIN** (sum последнего снапшота каждого аккаунта),
snapshots/errors за 24h.

### 6. `GET /admin/metrics/saas`
- Users by status (total/active/pending/blocked).
- DAU/WAU/MAU через `COUNT(DISTINCT user_id) FILTER (...)` по
  `sessions.last_used_at`.
- New users windows (24h/7d/30d) по `users.created_at`.
- Invites by status.
- **Activation 1**: % invites за 30d консьюмнутых ≤24h после issue.
- **Activation 2**: % users за 30d получивших ≥1 snapshot ≤7d после
  регистрации.

### 7. `GET /admin/audit` + `/admin/audit/action-counts`
Paginated viewer с фильтрами `actorId, targetUserId, action prefix,
asAdmin, accountId, sinceHours, limit, offset`. Counts — top actions
для глаз.

### 8. `GET /admin/tech-audit`
Автодетектор аномалий — то, что владелец просил («выявлять закономерные
ошибки пользователей»). Composable: каждый чекер возвращает `Finding[]`,
итог группируется по `category`. Шесть чекеров на старте:
- `users-without-accounts` (warning)
- `account-never-refreshed` (error) — старше 24h без snapshot-а
- `account-stale-snapshot` (warning) — последний >7d назад
- `upstream-errors-spike` (warning) — ≥5 ошибок provider за 24h
- `admin-not-verified` (info) — admin без `email_verified_at`
- `invite-near-expiry` (info) — pending invite expires <12h

Добавление нового чекера = метод + push в `runAll`.

### 9. `GET /admin/queue/status`
Queue health: counts (active/waiting/delayed/completed/failed) + список
scheduler id-ов с next-fire timestamps.

## Альтернативы

- **bull-board UI** — пробовал, но Fastify-плагин bull-board 6.x не сходится
  чисто с Fastify v5 + ESM (`basePath` opts конфликт + mixed CJS/ESM
  `bullMQAdapter`). JSON `/admin/queue/status` покрывает нужную поверхность
  дашборда. UI подключим отдельно если потребуется визуальная отладка
  очереди.
- **Materialised views** для агрегатов — отложено. Correlated subqueries при
  100 юзерах работают за ms. >1000 — promote.
- **GraphQL** — отвергли: REST с explicit endpoints проще для admin UI
  (нет over-fetching), Zod валидирует единообразно.
- **Tech-audit в cron** — пока on-demand через GET. Поставим в cron когда
  будут alerts (Phase 7).
- **Computed columns / triggers** для агрегатов — отвергли: дороже на
  записи, для read-rare-write-heavy ledger не оправдано.

## Реализация

Новые модули в `apps/api/src/modules/`:

- `admin-users/` — расширил Phase 2: listUsers с агрегатами, setStatus,
  setRole.
- `admin-portfolios/` — listAllAccounts, aggregate.
- `admin-metrics/` — compute.
- `admin-audit/` — list (filters + pagination), actionCounts.
- `admin-tech-audit/` — runAll + 6 чекеров.
- `admin-queue/` — JSON status endpoint.

Также:
- **SQL fix** в `admin-users.service.ts`: `${schema.users.id}` (emit `id` без
  table-qualifier) был ambiguous внутри коррелированных subqueries (где
  `accounts a` и `portfolio_snapshots ps` тоже содержат `id`). Заменил на
  raw `users.id` в template literal.
- **Date normalization**: PG возвращает timestamp из raw subquery как
  строку. Routes конструируют Date через `new Date(...)` перед `.toISOString()`.
- **`/me` shape**: добавил `impersonation` поле (nullable) — Phase 2
  прокидывал контекст внутри middleware, но не во внешний JSON.

## E2E (11/11 пройдено)

| # | Сценарий | Результат |
|---|---|---|
| 1 | `GET /admin/users` с агрегатами | 4 users, каждый с accountCount + lastSnapshotAt + TVL |
| 2 | `GET /admin/users?search=alice` | 1 user |
| 3 | `GET /admin/portfolios` | 4 accounts, per-account snapsLast24h + lastTrigger |
| 4 | `GET /admin/portfolios/aggregate` | accountsActive:4, usersActive:4, snapshotsLast24h:34, errors:0 |
| 5 | `GET /admin/metrics/saas` | DAU=3, активация within24h=50%, first-refresh-7d=75% |
| 6 | `GET /admin/queue/status` | counts + 5 schedulers |
| 7 | `GET /admin/audit/action-counts` | top events за 24h: 41 logins, 32 cron refreshes, … |
| 8 | `GET /admin/tech-audit` | `admin-not-verified: 2` |
| 9 | Alice (user) → `/admin/users` | 403 ✓ |
| 10 | Admin impersonate Alice → `/me` под imp-token | `impersonation: {impersonatorId, mode:"view"}` |
| 11 | `DELETE /admin/users/:id/impersonate` | revokedSessions=2 |

## Ограничения

- **PnL пока 0** — refresh service stub, реальный pipeline (cost-basis,
  positions) подключится при миграции фронтенда. Дашборд читает
  `metrics->>'totalUsd'` — когда worker начнёт писать реальные числа,
  оживёт без правок.
- **Activation metrics на маленькой выборке** (2 invites + 2 registered за
  тест). Цифры 50–75% — статистический шум при 4 юзерах.
- **bull-board UI пока нет** — есть JSON. UI — отдельная задача.
- **Pagination в `/admin/users`** есть только в `/admin/audit`. Для users
  список <100 → один запрос; добавим если scale потребует.
- **No per-endpoint rate-limit для admin** — глобальный 300/min достаточен.
- **tech-audit on-demand**, не cron. Поставим в cron когда будут
  Telegram alerts (Phase 7).
- **`admin.user_status_changed`** не сохраняет в `payload` список
  revoked-сессий — extension easy, если admin захочет видеть «какие именно
  сессии были убиты при suspend-е».
