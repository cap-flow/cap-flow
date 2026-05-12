---
date: 2026-05-11
stage: SaaS Phase 2
---

# SaaS Phase 2 — multi-tenant data model, reference layer, impersonation

## Контекст

Phase 0-1 закрыли auth и onboarding. Phase 2 — самый ответственный технический
этап: разделение данных по тенантам и реструктуризация «методики анализа»
по слоям (см. предыдущий decision `saas-analytics-layers`).

К этому моменту в БД присутствовали реминисценции прошлой попытки SaaS:
per-account `networks`, `custom_cg_ids`, `token_prices` (все пустые), а также
`accounts.owner_id` уже было N:1 к users.

## Решение

**Три параллельных изменения**:

1. **Global reference layer создан**: `chain_registry`, `coingecko_registry`,
   `historical_prices` (все global, без `account_id`).
2. **Per-account override layer**: `cg_id_overrides` (account_id+symbol).
3. **Account CRUD + tenant isolation**: модуль `accounts/` с явной проверкой
   `ownerId === actor.id || actor.role === 'admin'` на каждом resource-scoped
   endpoint. Лимит «1 active account per user» enforced в `AccountsService.create`.
4. **Admin impersonation (view-mode)**: эндпоинт
   `POST /admin/users/:id/impersonate` создаёт новую сессию с
   `user_id = target`, `impersonated_by_id = admin`, `impersonation_mode = 'view'`.
   Access token идёт от лица target user; middleware прокидывает
   `req.user.impersonation = { impersonatorId, mode }`. Все действия во
   время такой сессии пишутся в `audit_log` с `as_admin = true` и
   `target_user_id` заполнен.

**Audit log расширен** (миграция `0001_phase2_reference.sql`):
- `as_admin boolean NOT NULL DEFAULT false`
- `target_user_id uuid REFERENCES users(id)`
- `ip varchar(45)`
- `user_agent text`

**Legacy per-account reference-таблицы оставлены как есть** (`networks`,
`custom_cg_ids`, `token_prices`) — они пустые, дроп выполнен будет отдельной
миграцией (Phase 3 — когда код-чтения этих таблиц мигрирует на global).

## Альтернативы

- **Row-level security (RLS) в Postgres** вместо middleware-фильтрации.
  Отложили — сначала middleware (быстрее в реализации, понятнее в audit-ходах,
  даёт чёткий 403); RLS добавится как defense-in-depth в Phase 3-4 поверх.
- **Импернесация через смену `users.id` в JWT** (выдать админу токен с
  чужим `sub`). Отвергли — теряем связь «кто за этим стоит», audit log
  не сможет различать admin-действия от user-действий, и нет revoke-флоу.
  Сейчас impersonation_by_id в session — single source of truth.
- **Edit-mode импернесация сразу**. Отложили в Phase 5 — требует
  `edit_requests` workflow с подтверждением target-юзером. На MVP view-mode
  достаточно для технического аудита.
- **Прокидывание `actor` через каждый сервис-метод явно** vs. неявно через
  middleware. Выбрали явно — каждый сервис принимает `actor: AuthUser`
  параметром и проверяет access сам. Делает unit-тесты тривиальными и не
  требует фастифай-контекста в сервисах.

## Реализация

### Schema (`packages/db/src/schema/`)
- `chain_registry.ts` — global registry (chain_id PK).
- `coingecko_registry.ts` — global registry (symbol PK).
- `historical_prices.ts` — global lazy cache (symbol+date composite PK).
- `cg_id_overrides.ts` — per-account override (account_id+symbol PK).
- `audit_log.ts` — расширен `as_admin`, `target_user_id`, `ip`, `user_agent`.

### Migration `drizzle/0001_phase2_reference.sql`
Идемпотентная (`ADD COLUMN IF NOT EXISTS`, `CREATE TABLE IF NOT EXISTS`).
Применяется командой:
```
cat packages/db/drizzle/0001_phase2_reference.sql | \
  docker exec -i capflow-postgres psql -U capflow -d capflow -v ON_ERROR_STOP=1
```

### Seed `apps/api/src/scripts/seed-reference-data.ts`
Идемпотентный upsert через `ON CONFLICT DO UPDATE`. 7 chains (Ethereum,
Optimism, BNB, Polygon, Base, Arbitrum, Avalanche), 36 tokens (стейблы:
USDC/USDT/DAI/FRAX/LUSD/USDE/EURC/EURS, нативы: ETH/WETH/BTC/WBTC/BNB/MATIC/
AVAX/ARB/OP, liquid staking: stETH/wstETH/rETH/cbETH/ezETH/weETH, DeFi: AAVE/
UNI/LINK/CRV/MKR/LDO/PENDLE/GMX, мемы: SHIB/PEPE/DOGE, прочее: SOL/ATOM).

### API модули
- `apps/api/src/modules/accounts/`
  - `accounts.repository.ts` — findById, findActiveByOwner, countActiveByOwner,
    findPrimaryByOwner, create, createPrimary, update, archive.
  - `accounts.service.ts` — listForCurrentUser, getById (с
    `assertOwnerOrAdmin`), create (с лимитом для user), update, archive
    (юзер не может архивировать primary; admin — может).
  - `accounts.routes.ts` — GET/POST/GET-by-id/PATCH/DELETE под `requireAuth`.
- `apps/api/src/modules/admin-users/`
  - `admin-users.service.ts` — listUsers, findUserById, impersonate,
    endImpersonations.
  - `admin-users.routes.ts` — GET / списка, POST/DELETE
    `/:id/impersonate`, под `requireAdmin`.
- `apps/api/src/plugins/auth.ts` — middleware теперь читает
  `session.impersonated_by_id` и пробрасывает в `req.user.impersonation`.

### Env (новое)
- `IMPERSONATION_TTL_MIN` (default 60) — TTL для impersonated-сессий
  (короче обычного refresh — ограничивает blast radius).

## E2E (20/20 пройдено)

| # | Сценарий | Ожидание | Результат |
|---|---|---|---|
| 1-3 | Admin login → invite Bob → register Bob | OK | ✓ |
| 4 | Alice login (от Phase 1) | OK | ✓ |
| 5-6 | Alice и Bob каждый видят **только свой** аккаунт через GET /accounts | 1 each | ✓ |
| 7 | Alice POST /accounts (лимит 1 для user) | 403 | ✓ |
| 8-10 | Alice пытается GET/PATCH/DELETE bob's account | 403 / 403 / 403 | ✓ |
| 11 | Alice DELETE свой primary | 409 | ✓ |
| 12 | Alice PATCH свой описание | 200 + updated | ✓ |
| 13 | Admin POST /accounts (без лимита) | 201 | ✓ |
| 14 | Admin GET /admin/users | 4 пользователей | ✓ |
| 15 | Alice GET /admin/users | 403 | ✓ |
| 16 | Admin impersonate Alice | 200 + JWT (mode=view) | ✓ |
| 17 | /auth/me с impersonation токеном | возвращает Alice | ✓ |
| 18 | GET /accounts во время impersonation | возвращает аккаунты Alice | ✓ |
| 19 | Admin DELETE impersonation | revokedSessions=1 | ✓ |
| 20 | /me с revoked impersonation токеном | 401 | ✓ |
| audit | account.created (as_admin=false), account.updated (as_admin=false), admin.impersonation_started/ended (as_admin=true, target_user_id заполнен) | ✓ |

## Ограничения

- **`accounts.legacy_id` остался UNIQUE-индексом, но nullable** — это даёт
  «один null разрешён» в современных Postgres. Если миграция данных из
  legacy внесёт несколько записей с null legacy_id — индекс не помешает,
  но и не поможет дедуплицировать. Это OK на beta.
- **Edit-mode impersonation отложен в Phase 5** через `edit_requests`. На
  Phase 2 admin в impersonation-сессии **технически имеет тот же доступ что
  user** (т.к. JWT role = user). Безопасность тут опирается на audit log
  и flow «admin сам себе не разрешит писать вредное», что приемлемо для
  closed-beta. Phase 5 добавит gate на write-эндпоинты: проверять что
  `req.user.impersonation?.mode === 'edit'` для писатель-действий.
- **Tenant isolation enforced в сервисе**, не в SQL. SQL RLS — defence-in-depth
  на Phase 3-4.
- **Без advisory lock на email при регистрации** (Phase 1 ограничение всё
  ещё актуально).
- **Per-account legacy `networks`/`custom_cg_ids`/`token_prices` остались**
  для обратной совместимости; их дроп — отдельная миграция когда код
  перестанет их читать (Phase 3 при подключении price-cache).
- **`historical_prices` пустая** — заполнится lazy через worker (Phase 4),
  когда юзеры начнут запрашивать cost basis на исторические даты.
- **Reference seed не покрывает все экзотические токены** — для них юзер
  использует `cg_id_overrides`; админ периодически промотирует популярные
  overrides в `coingecko_registry` (вручную на старте; Phase 5 admin UI
  автоматизирует через «промоушн в global»).
