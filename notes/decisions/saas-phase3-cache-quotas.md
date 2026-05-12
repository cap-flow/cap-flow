---
date: 2026-05-11
stage: SaaS Phase 3
---

# SaaS Phase 3 — Redis cache, per-user quotas, provider abstraction, api_usage

## Контекст

Phase 2 закрыла tenant model. Phase 3 — самый важный для **экономии
upstream-API-лимитов**. Без неё каждый юзер с своими ключами Alchemy/DeBank
в `localStorage` ломал бы общий план SaaS: 25 юзеров × N запросов = 25N
ударов по тем же кошелькам, нет общего кэша, нет видимости расходов, и
никаких per-user квот.

Требования владельца (исходное обсуждение):
- API-ключи **только у меня как у админа** → server-side ключи в env, из
  клиента полностью убраны.
- «отслеживать расходы по API всеми сервисами … условно блок по аналитике
  где я отслеживаю запросы по API» → `api_usage` таблица + admin dashboard.
- Защита от того, чтобы один юзер исчерпал квоту всех → per-user token bucket.

## Решение

**Три слоя на каждый upstream-вызов** (см. `quoted-provider.ts`):

```
   request
      │
      ▼
   1. Redis cache (shared key, e.g. price:coingecko:USDC)
      │ HIT? → log {cache_hit=1, status=200, ms=0} → return cached
      │ MISS ↓
      ▼
   2. Token bucket (per-user, per-provider, daily counter)
      │ EXCEEDED? → log {status=429, ms=0, error="quota …"} → 403 Forbidden
      │ OK ↓
      ▼
   3. Upstream HTTP call
      │ → log {cache_hit=0, status=200|err, ms=elapsed}
      │ on success: write to cache with TTL → return
      │ on error: propagate
```

**Cache** — Redis с per-provider, per-symbol ключами. Один юзер запросил
USDC → следующие 5 минут все остальные юзеры получают ответ из кэша
**бесплатно** (не списывая свою квоту, не уходя в CoinGecko). Это и есть
тот самый «общий кэш» из требований владельца.

**Per-user квоты** — daily token bucket в Redis (`INCR` + `EXPIRE` под
UTC-день). Дешёво, очевидно человеку. Лимиты конфигурируемы через env
(`QUOTA_<PROVIDER>_PER_DAY`); beta — щедрые (CoinGecko 2000/day,
Alchemy/Etherscan 5000/day), для логирования а не запрета.

**api_usage** — каждый upstream call **или** cache hit пишет строку:
`provider, endpoint, user_id, account_id, http_status, duration_ms,
cache_hit, error`. Дашборд админа сразу строит:
- расходы по провайдерам за период (с разбивкой errors / cache hit ratio)
- топ-юзеров по потреблению
- per-user текущее quota usage

**Provider abstraction** — `IPriceProvider` / `IBalanceProvider`
интерфейсы. Каждый upstream имеет два класса:
- raw client (`CoinGeckoClient`, `AlchemyClient`, …) — только HTTP.
- декоратор `QuotedPriceProvider` оборачивает с cache/quota/logging.

Сервисы зависят от интерфейса, не от конкретного класса → юнит-тесты
легко подменяют моками без подъёма Redis.

## Альтернативы

- **Sliding-window rate limiter** вместо daily bucket. Отвергли:
  провайдеры (CoinGecko/Alchemy) сами биллят на calendar-day границы;
  reset-семантика «обнуляется в полночь UTC» очевидна юзеру.
- **In-process LRU cache** вместо Redis. Отвергли: на 2+ инстансах API
  не разделяется, теряется сразу при перезапуске, не делится с worker'ом
  (Phase 4 — BullMQ тоже сидит в Redis).
- **Per-key TTL hint от провайдера** (e.g., Cache-Control). Отвергли:
  избыточно для MVP. Глобальный TTL 5 мин для цен достаточен; balances
  при подключении возьмут 60 сек.
- **Stale-while-revalidate** (вернуть кэш + перезапросить в фоне).
  Отложили: добавится в Phase 4 как опция для worker-driven refresh.
- **Сразу полноценные Alchemy/DeBank/Etherscan клиенты**. Сделали
  скелеты — wire-up самих звонков идёт когда мы будем мигрировать
  фронтенд (отдельная задача, может потянуть). Critical path —
  инфраструктура. CoinGecko — реальный, потому что (а) free tier, (б)
  даёт прямой E2E.

## Реализация

### Инфра
- `infra/docker-compose.dev.yml` — добавлен `redis:7-alpine` с
  `appendonly yes` + `maxmemory 256mb` + `allkeys-lru`. Порт 6379.
- `.env`: `REDIS_URL`, `ALCHEMY_API_KEY`, `DEBANK_API_KEY`,
  `ETHERSCAN_API_KEY`, `COINGECKO_API_KEY`, `QUOTA_*_PER_DAY`,
  `CACHE_PRICE_TTL_SEC`, `CACHE_BALANCE_TTL_SEC`.

### Плагины
- `apps/api/src/plugins/redis.ts` — `app.redis` (ioredis singleton).

### Модули
- `apps/api/src/modules/redis/cache.ts` — `JsonCache.get/set/wrap` с TTL.
- `apps/api/src/modules/redis/token-bucket.ts` — `consume/peek/reset`.
- `apps/api/src/modules/api-usage/api-usage.repository.ts` — log + admin
  агрегации (summary по провайдеру, topUsers).
- `apps/api/src/modules/integrations/`
  - `types.ts` — `IPriceProvider`, `IBalanceProvider`, `ProviderError`,
    `ProviderNotConfiguredError`.
  - `coingecko.ts` — **реальный** client. Free tier без ключа,
    pro endpoint если `COINGECKO_API_KEY` задан.
  - `alchemy.ts`, `debank.ts`, `etherscan.ts` — скелеты с
    `not implemented yet` (правильный API).
  - `quoted-provider.ts` — декоратор cache/quota/logging.
- `apps/api/src/modules/prices/`
  - `prices.repository.ts` — resolve symbol → coingecko_id (per-account
    override → global → null).
  - `prices.service.ts` — combine repo + provider, throw 404 если symbol
    не размечен.
  - `prices.routes.ts` — `GET /api/v1/accounts/:id/prices/:symbol`,
    `preHandler: requireAuth`, под `requireAccountAccess` через сервис.
- `apps/api/src/modules/admin-usage/admin-usage.routes.ts` —
  `GET /admin/api-usage/summary?hours=N`, `/recent?limit=N`,
  `/quotas?userId=…`. Под `requireAdmin`.

### Endpoints
- `GET /api/v1/accounts/:id/prices/:symbol` — текущая цена. Auth + tenant
  check. Tight per-IP rate-limit 60/min.
- `GET /api/v1/admin/api-usage/summary?hours=N` — расходы по провайдерам +
  топ-10 юзеров за период.
- `GET /api/v1/admin/api-usage/recent?limit=N` — последние N вызовов.
- `GET /api/v1/admin/api-usage/quotas?userId=…` — текущий used/limit
  по всем провайдерам для конкретного юзера.

## E2E (live CoinGecko, 12/12 пройдено)

| # | Сценарий | Результат |
|---|---|---|
| 1 | GET prices/USDC без auth | 401 ✓ |
| 2 | GET prices/USDC (admin, cold) | 200, $0.999776 от coingecko, 517 ms |
| 3 | GET prices/USDC (admin, повтор) | 200, идентичная цена, **22 ms (cached)** |
| 4 | GET prices/ETH + WETH (cold) | оба 200, $2355.39 / $2356.97 |
| 5 | GET prices/UNKNOWN | 404 (no mapping in registry/overrides) |
| 6 | Alice GET prices/USDC | **cache hit** — не сжигает её квоту, тот же ответ |
| 7 | Alice GET prices/:adminAcct | 403 (tenant isolation работает поверх цен) |
| 8 | Admin /admin/api-usage/summary | `coingecko: 5 calls, 2 cacheHits, 0 errors`; topUsers `admin→4, alice→1` |
| 9 | Admin /admin/api-usage/quotas?userId=admin | `coingecko: 3/2000` (только cold) |
| 10 | Admin /admin/api-usage/recent | 5 строк с timestamps, cache flags, ms |
| 11 | Alice → /admin/api-usage/summary | 403 ✓ |
| 12 | Redis `KEYS price:*` | `price:coingecko:USDC/ETH/WETH`, TTL ~298s |

## Ограничения

- **Alchemy/DeBank/Etherscan скелеты, не реальные клиенты**. Их wire-up
  привязан к миграции фронтенда (отдельная задача): UI должен перестать
  стучать в localStorage за ключами и начать ходить через
  `/api/v1/accounts/:id/wallets/balances`. На текущей фазе закрыт
  **бэк-каркас** — провайдер абстракция готова, оборачивание
  cache/quota/logging универсальное.
- **Quota counter в Redis может разойтись с реальным потреблением
  upstream** при сетевых сбоях между decrement и call. Tradeoff: lost
  call vs over-quota. Сейчас INCR делается до HTTP-вызова — possible
  over-counting if HTTP падает; считаем acceptable, потому что
  предохраняет лимиты upstream'а.
- **Cache не invalidate-able по-явному** (только TTL expiry). На admin
  panel в Phase 5 добавится кнопка «сбросить prices cache» — это `DEL`
  по префиксу.
- **Per-user квота применяется только к cold calls** — что правильно
  (cache hits не стоят денег провайдеру), но это значит quota не
  отражает реальное потребление сервисом, а только реальное потребление
  *upstream API*. Для админа дашборд показывает оба числа (calls vs
  cacheHits) — он видит полную картину.
- **Нет защиты от cache stampede** (одновременных cold-misses на тот же
  ключ от 5 юзеров одновременно). На beta при 25 юзерах это редко;
  Phase 4 worker может добавить `SETNX`-lock pattern.
- **`historical_prices` ещё не заполняется** — нужен worker (Phase 4)
  который при cold-miss и для исторической даты пишет туда.
- **Legacy reference tables (`networks`, `custom_cg_ids`, `token_prices`)
  всё ещё существуют в БД пустыми**. Миграция `0002_phase3_drop_legacy_reference.sql`
  готова, но не применена — пользователь подтвердит до выполнения.
