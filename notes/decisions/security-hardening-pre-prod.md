---
date: 2026-05-18
stage: pre-prod
---

# Security hardening — закрытие 4 уязвимостей перед prod

## Контекст

Перед выкладкой SaaS-фазы внешний аудит выявил 4 проблемы:

1. **CRITICAL — IDOR в upstream-proxy.** Любой залогиненный юзер мог
   передать произвольный blockchain-адрес в `/api/v1/upstream/:provider/*`
   и получить ответ от DeBank/Alchemy/Helius/Etherscan с админским
   ключом. Это (а) разглашение чужих портфелей за наш счёт, (б) тихая
   утечка платных квот через directory-scraping.
2. **CRITICAL — отсутствие rate-limit на heavy-sync endpoints.** На WIP-
   ветке появились модули `cex/*` (POST `*-sync`, `import-csv`, `reprobe`)
   и `chain-ops/sync` (POST принимает до 10 000 ops), каждый из которых
   фанит-аут в CCXT / DB-CTE. Без rate-limit один клиент мог зациклить
   sync и сжечь чужие квоты Bitget / разгрузить DB.
3. **AUTH — `/auth/refresh` и `/auth/logout` без rate-limit.** Поскольку
   глобальный `rate-limit` зарегистрирован с `global: false`, любой
   эндпойнт без `config.rateLimit` мог быть зациклен (brute-force
   refresh cookie, mass-invalidate sessions через logout).
4. **AUTH — portfolio.refresh ceiling.** На beta-test было поднято до
   `max: 1000` для QA; перед prod вернули `max: 10`.

## Решение

### Задача 1 — IDOR guard для upstream-proxy

Реализован модуль `apps/api/src/modules/upstream-proxy/address-guard.ts`:

* `extractAddresses(req)` — pure-функция, вытаскивает все
  blockchain-адреса из proxy-запроса по таблице ниже. Возвращает
  валидные (нормализованные) + malformed (для 400).
* `buildOwnedSet(rows)` — собирает Set владельцем-нормализованных
  адресов юзера за один SQL.
* `decide(req, owned, { isAdmin })` — итоговая политика: malformed → 400,
  чужой адрес → 403, admin → всегда allow.

В route handler'е (`upstream-proxy.routes.ts`) guard вызывается **до**
форварда. Список адресов юзера резолвится один раз за HTTP-запрос и
кэшируется в `req.__ownedSet` (in-request memoize). Все rejection'ы
аудируются в `api_usage` с error-кодом (`malformed` / `forbidden`).

#### Per-provider address-location таблица

| Provider  | Где искать адрес                                                 |
|-----------|------------------------------------------------------------------|
| DeBank    | `query.id` / `query.addr` / `query.user_addr` / `query.addresses` (CSV) / `query.addrs` / `query.wallet` |
| Helius    | Path: `v0/addresses/<ADDR>/...`; POST body: `body.accounts[]`, `body.addresses[]` |
| Etherscan | `query.address` (одиночный или CSV для `balancemulti`)           |
| Alchemy   | JSON-RPC body: `params[0]` (bare addr); `params[0].fromAddress` / `.toAddress` / `.owner` / `.ownerAddress` / `.from` / `.account`. Поддерживаются batch-массивы. |

Адреса в "non-user" слотах (`contractAddress`, `spender`, ERC-20 token
contract в `to` параметре `eth_call`) явно исключены — ownership на
контракт-адрес бессмысленна.

#### Нормализация

* EVM (`/^0x[a-fA-F0-9]{40}$/`) → lowercase.
* Solana (base58, 32–44 chars) → verbatim.
* Всё остальное в "адресном" слоте → invalid → 400.

#### Ownership-источник

```ts
WalletsRepository.listAddressesByOwner(ownerId)
  // wallet_addresses → wallets → accounts WHERE owner_id = $1
```

Один JOIN; кэшировать на уровне Redis пока **не** требуется.

#### Тесты (19 кейсов, `address-guard.test.ts`)

DeBank / Helius / Etherscan / Alchemy extractors + `decide()` policy
(own → allow, other → 403, admin → bypass, malformed → 400, partial
batch → 403, empty path → allow, EVM checksum equivalence, unknown
provider → fail closed).

### Задача 2 — heavy-sync rate-limit (новая в этом раунде)

Добавлен общий литерал `HEAVY_SYNC_LIMIT` в `cex.routes.ts` и
`chain-ops.routes.ts`:

```ts
{ max: 5, timeWindow: "1 minute",
  hook: "preHandler",
  keyGenerator: (req) => req.user?.id ?? req.ip ?? "anon" }
```

Применён к:

* `POST /v1/cex/:id/transfers-sync`
* `POST /v1/cex/:id/internal-transfers-sync`
* `POST /v1/cex/:id/ledger-sync`
* `POST /v1/cex/:id/p2p-sync`
* `POST /v1/cex/:id/sync`
* `POST /v1/cex/:id/reprobe`
* `POST /v1/cex/:id/trades/import-csv`
* `POST /v1/cex/:id/p2p-orders/import-csv`
* `POST /v1/cex/deposit-seeds`
* `POST /v1/chain-ops/:walletId/sync`
* `GET  /v1/chain-ops/graph/internal-transfers` (6 параллельных
  service.find* — фактически heavy read)

#### Почему `hook: "preHandler"`

`@fastify/rate-limit` по умолчанию навешивается на `onRequest`,
который выполняется **до** preHandler-цепочки → `req.user` не
populated → keyGenerator проваливается на IP-fallback (NAT-bucket для
всех пользователей за одним IP). С `hook: "preHandler"` лимитер
встаёт после `app.requireAuth`, и per-user keying работает корректно
— это проверено отдельным тестом (`cex.rate-limit.test.ts`,
"keyGenerator is per-user, not per-IP").

#### Почему именно 5/min

* Sync-flow в норме = "после refresh wallet" = ~1 req/min на CEX
  account. 5× headroom покрывает multi-account / multi-tab.
* Bitget retail API rate-limit = 10 req/sec, но с длинными
  endpoints (`fetchMyTrades` for 20+ symbols) реально упирается в
  daily-quota → 5/min/user даёт суммарно ≤ 300/hour из всех
  юзеров, что укладывается в платный план.
* `chain-ops/sync` принимает batch до 10 000 ops × 5 req/min = до
  50 000 inserts/min/user в худшем случае — Postgres проглатывает.

#### Тесты

`auth.rate-limit.test.ts` (новый) — 2 кейса (refresh 30/15min,
logout 20/5min). `cex.rate-limit.test.ts` (новый) — 2 кейса
(heavy-sync 5/min, per-user bucket).

### Задача 3 — rate-limit на /auth/refresh, /auth/logout

* `/auth/refresh` → `max: 30 / 15 minutes`. Ключ — IP (юзер ещё не
  authed; cookie может быть spoofed). 30× нормального refresh-traffic
  (один refresh в 15 минут × multi-tab) — комфортный порог.
* `/auth/logout` → `max: 20 / 5 minutes`. User-инициированно,
  идемпотентно; 20 — заведомо выше любой реальной активности.
  KeyGenerator: `req.user?.id ?? req.ip` — если есть валидный
  access-cookie/bearer, лимит per-user; иначе per-IP.

**Не меняли `global: false`**. Аргумент: тяжёлые read-endpoints
портфеля сейчас не ограничены, и установка глобального дефолта
сломала бы агрессивные drill-down сценарии. Точечные лимиты безопаснее.

### Задача 4 — portfolio.refresh ceiling

Beta-test комментарий снят, `max: 1000` → `max: 10` в
`apps/api/src/modules/portfolio/portfolio.routes.ts:105`.

## Альтернативы

* **Pre-handler-плагин для guard'а вместо встроенного кода в route.**
  Отвергнуто: один route у upstream-proxy, и нужен доступ к
  проксируемому телу в нормализованной форме.
* **Ownership-кэш в Redis.** Отложено до появления p95-метрик. Один
  PostgreSQL-запрос на проксируемый HTTP-call — приемлемо. JOIN
  индексирован (`accounts_owner_idx`).
* **Глобальный rate-limit с keyGenerator по user.id.** Откладываю до
  следующей итерации — нужны нагрузочные тесты.
* **Per-user rate-limit на /auth/refresh.** Невозможно без полноценной
  верификации refresh cookie до rate-limit'а — это переворачивает
  request lifecycle. IP-based достаточно против реальных угроз.

## Реализация

Файлы:

* `apps/api/src/modules/upstream-proxy/address-guard.ts` — guard.
* `apps/api/src/modules/upstream-proxy/address-guard.test.ts` — 19 тестов.
* `apps/api/src/modules/upstream-proxy/upstream-proxy.routes.ts` — вызов
  guard'а, аудит rejection'ов в `api_usage`.
* `apps/api/src/modules/wallets/wallets.repository.ts` —
  `listAddressesByOwner(ownerId)`.
* `apps/api/src/app.ts` — прокидывание `walletsRepo` в upstream-proxy.
* `apps/api/src/modules/auth/auth.routes.ts` — `config.rateLimit` на
  `/refresh` и `/logout`.
* `apps/api/src/modules/auth/auth.rate-limit.test.ts` — 2 теста.
* `apps/api/src/modules/cex/cex.routes.ts` — `HEAVY_SYNC_LIMIT` на 9
  heavy POST.
* `apps/api/src/modules/cex/cex.rate-limit.test.ts` — 2 теста.
* `apps/api/src/modules/chain-ops/chain-ops.routes.ts` —
  `HEAVY_SYNC_LIMIT` на `/sync` + `/graph/internal-transfers`.
* `apps/api/src/modules/portfolio/portfolio.routes.ts` — restore
  `max: 10` ceiling.

Прогон: `pnpm --filter @cap-flow/api test` → 796/796 passed
(включая 19 + 2 + 2 = 23 новых кейсов). 4 test suites не
загрузились из-за pre-existing `@cap-flow/db` package-resolution
ошибки — affect 0 уязвимостей, blocker не для безопасности.

## Ограничения / что осталось

* **Адресные типы за пределами EVM/Solana не валидируются** на формат
  (Tron T-prefixed, BTC bech32 etc). Сейчас в провайдерах
  upstream-proxy таких слотов нет; добавление Tron/BTC требует
  расширения регулярок.
* **Контрактные адреса не проверяются на ownership** — это by design.
  Защищает upstream-proxy общий rate-limit (60/min, 600/hour).
* **Helius `v0/token-metadata` POST** не извлекает адреса (там
  mint-ы, не wallet-owner). Если эндпойнт начнёт принимать кошельки —
  обновить extractor.
* **Глобального rate-limit нет.** Любой будущий POST без явного
  `config.rateLimit` снова открыт. Нужен code-review hook или линтер.
* **httpOnly cookie миграция, CSP-header, X-Frame-Options** — из
  аудита; в этот раунд не делали. Решение по cookie уже принято
  (`auth.cookies.ts` использует `httpOnly: true` и `sameSite`).
  Helmet включён глобально (`apps/api/src/app.ts:170`).
* **Per-route allowlist для upstream-proxy paths.** Сейчас policy на
  уровне `UpstreamProxyService.forward`. Расширение паттернов
  адресных слотов требует синхронного апдейта address-guard и доки
  выше.
* **Чёрные списки IP / WAF.** Out-of-scope для текущего раунда.

## Smoke-проверки (после merge в main)

1. `curl -X POST /v1/auth/refresh` 31 раз с одного IP → последний 429.
2. `curl -X POST /v1/cex/:id/sync` 6 раз от одного юзера → 6-й 429.
3. `curl /v1/upstream/debank/v1/user/total_balance?id=<not-mine>` →
   403 forbidden, audit row в `api_usage` с `error="forbidden"`.
4. `curl /v1/upstream/debank/v1/user/total_balance?id=0xdeadbeef` →
   400 malformed.
