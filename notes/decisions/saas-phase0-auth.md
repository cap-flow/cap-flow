---
date: 2026-05-10
stage: SaaS Phase 0
---

# SaaS Phase 0 — auth, multi-tenancy, миграция поверх существующей БД

## Контекст

Capflow переходит из single-user веб-приложения с ключами в `localStorage` в
SaaS с multi-user, ролями admin/user, инвайтами, биллингом и общими API-ключами
владельца. Условия зафиксированы с владельцем 2026-05-10 (см. memory
`project_capflow_saas_decisions.md`).

При старте обнаружили, что в `capflow-postgres` уже была частичная SaaS-схема
(27 таблиц, 16 enum-ов, 1 user) — оставшаяся от прошлой попытки. Среди них
вся бизнес-модель Capflow (`operations`, `wallets`, `tokens`, `portfolio_snapshots`,
`imported_operations`), плюс auth-каркас с уклоном в Telegram-only auth
(`users.telegram_id NOT NULL`, без email/password).

## Решение

**Вариант B — встраиваемся в существующую схему**, не переписываем её. Email
становится primary identifier, `telegram_id` и `legacy_id` становятся
nullable. Inherit все существующие таблицы как есть; добавляем только то, чего
нет: `invites`, `api_usage`, и новые колонки в `users`/`accounts`/`sessions`.

Auth-стек:
- argon2id для паролей (`@node-rs/argon2`).
- JWT access (15 min, HS256) — stateless, payload `{ sub, role, sid }`.
- Refresh token — random 32 bytes, SHA-256 hash в `sessions.session_token_hash`
  (используем существующую колонку, а не вводим новую).
- Refresh cookie: `httpOnly` + `secure` (prod) + `sameSite=strict` + `path=/api/v1/auth`.
- Token rotation на каждый `/auth/refresh` — старая сессия `revoked_at`, новая
  выдаётся с тем же TTL.
- Login с неизвестным email прогоняется через dummy argon2 hash, чтобы время
  ответа не выдавало enumeration.
- Rate-limit на `/auth/login`: 5 попыток / 15 мин (env `RATE_LIMIT_LOGIN_PER_15MIN`).

Multi-tenancy:
- `accounts.owner_id → users.id` — связь N:1 уже была. Добавили
  `is_primary`, `description`, `settings`, `archived_at`. На beta — лимит
  1 аккаунт на user; админу без лимита.
- Изоляция планируется в Phase 2 на уровне queries (middleware + явный
  фильтр по `owner_id`/`account_id` в SQL).

## Альтернативы

- **Вариант A** — дроп всей БД и применить чистую миграцию. Отвергли:
  существующая бизнес-модель Capflow содержательная, переделывать значит
  выкинуть работу прошлой итерации.
- **Вариант C** — отдельная новая БД. Отвергли: два инстанса в инфраструктуре
  без выгоды; владельцу проще иметь одну.
- **drizzle-kit pull → автогенерация schema** — отвергли: drizzle-kit 0.30
  + drizzle-orm 0.39 несовместимы по `./gel-core` экспорту, цикл апгрейда
  не оправдан. Schema-файлы написали вручную из `pg_dump` для нужных Phase 0
  таблиц.
- **drizzle-kit generate diff** — отвергли: TS-схема покрывает только Phase 0
  таблицы, diff против пустой baseline захотел бы дропнуть `operations`,
  `wallets` и т.д. Миграцию `0000_phase0_auth.sql` написали руками с
  `IF NOT EXISTS` / `IF EXISTS` для идемпотентности.
- **Сразу полная row-level security в Postgres (RLS)** — отложили на Phase 2.
  Сначала middleware-isolation, потом RLS как defense-in-depth.

## Реализация

**Schema** (`packages/db/src/schema/`):
- `users.ts` — расширили: `email`, `password_hash`, `name`, `email_verified_at`,
  `last_login_at`. Существующие `telegram_id` / `legacy_id` теперь nullable.
- `accounts.ts` — расширили: `is_primary`, `description`, `settings`, `archived_at`.
- `sessions.ts` — добавили `last_used_at`. Используем `session_token_hash` как
  refresh-token hash (одну колонку).
- `audit_log.ts`, `feature_flags.ts`, `auth_tokens.ts`, `edit_requests.ts`,
  `user_payments.ts` — inherit как есть.
- `invites.ts`, `api_usage.ts` — новые таблицы.

**Миграция** (`packages/db/drizzle/0000_phase0_auth.sql`) — SQL вручную,
идемпотентный, применяется через `psql`. Не использует drizzle migrate
framework (см. ограничения).

**Auth API** (`apps/api/src/modules/auth/`):
- `password.ts` — argon2id, m=64MB, t=3, p=1.
- `tokens.ts` — JWT helpers, refresh/invite token generators, SHA-256 hash.
- `auth.repository.ts` — Drizzle-репо для users/sessions.
- `auth.service.ts` — login / refresh / logout / getActiveUser.
- `auth.routes.ts` — POST `/auth/login`, `/auth/refresh`, `/auth/logout`;
  GET `/auth/me`. Роуты живут под `/api/v1/auth`.
- `auth.cookies.ts` — set/clear refresh cookie с правильными флагами.
- `plugins/auth.ts` — `app.requireAuth` (Bearer header → проверка JWT +
  валидной сессии в БД), `app.requireAdmin` (requireAuth + role check).
- `modules/audit/audit.service.ts` — пишет login/logout в `audit_log`.

**Seed** (`apps/api/src/scripts/seed-admin.ts`) — идемпотентно создаёт/обновляет
админа Vladimir и его primary account "Main".

**Тестирование**: e2e-флоу через curl, 10/10 кейсов прошли:
1. Login правильным паролем → 200, JWT + cookie.
2. `/me` без токена → 401.
3. `/me` с токеном → 200.
4. `/me` с битым токеном → 401.
5. `/refresh` с cookie → 200, **новый токен** (rotation подтверждён).
6. `/refresh` без cookie → 401.
7. `/logout` → 204.
8. `/refresh` после logout → 401 (старая сессия revoked).
9. Login с неверным паролем → 401.
10. Login с неизвестным email → 401 (constant-time через dummy hash).

В `audit_log` после прогона — записи `auth.login` + `auth.logout` с
`session_id` в payload. В `sessions` — две записи (rotated + revoked).

## Ограничения

- **Не использован drizzle migrate framework**. Файл `0000_phase0_auth.sql`
  применяется руками. На Phase 2-3 нужно сделать proper baseline: добавить все
  существующие таблицы в TS-схему, прогнать `drizzle-kit generate` для
  snapshot, и зарегистрировать `0000_phase0_auth` в `drizzle.__drizzle_migrations`
  чтобы дальнейшие миграции работали через `pnpm db:migrate`.
- **TS-схема покрывает только Phase 0 таблицы**. Operations/wallets/tokens/etc
  существуют в БД, но недоступны через `schema.*`. Добавлю по мере того как
  они потребуются в коде (Phase 2-3).
- **Tenant isolation на уровне SQL пока не реализован**. Кроме `requireAuth`,
  никаких фильтров по `owner_id`/`account_id` нет — но это будет применимо
  только когда появятся account-scoped роуты в Phase 2.
- **Magic-link для восстановления пароля** — таблица `auth_tokens` готова, но
  endpoint и email-провайдер пока не подключены. Ляжет в Phase 1.
- **2FA для админа** — спланирован на Phase 9.
- **Старый legacy-пользователь** (`telegram_id=261345477`, `Dev`) остался в БД
  как есть — у него нет email/password, через login он не пройдёт. Это ок;
  если он нужен — добавит email через тот же seed-скрипт.
