---
updated: 2026-05-12
---


# ROADMAP

## ✅ Сделано

### Phase P6.1c–d — Prod env template + compose/Caddy validation (2026-05-12)

Закрывает оставшиеся куски P6.1 перед раскаткой на VPS:

- **`.env.prod.example`** в корне монорепо — строгий prod-template:
  - Каждая переменная помечена `[REQUIRED]` / `[OPTIONAL]`.
  - Inline-команды генерации секретов (`node -e "crypto.randomBytes(48).toString('hex')"`,
    `openssl rand -base64 32`).
  - `COOKIE_SECURE=true` зафиксирован (HTTPS only).
  - `COOKIE_DOMAIN=.cap-flow.ru` для будущих subdomains.
  - 4 upstream-ключа (`ALCHEMY/DEBANK/ETHERSCAN/HELIUS`) помечены как [REQUIRED],
    `COINGECKO/COINSTATS` — [OPTIONAL] (free-tier работает).
  - `CADDY_DOMAIN` + `CADDY_ACME_EMAIL` зафиксированы как обязательные.
  - Image-теги `API_IMAGE`/`WEB_IMAGE` с дефолтом `:latest` для CI-pin.
- **Compose validation**: `docker compose -f infra/docker-compose.yml config` с
  заполненными значениями шаблона — exit 0, ни одной warning о unset
  переменных.
- **Caddyfile validation**: установлен `caddy` (brew), `caddy validate` — Valid
  configuration. Применён `caddy fmt --overwrite` (минимальная косметика —
  убрал пустую строку перед глобальным блоком).

Следующий шаг: P6.2 — build images + deploy на cap-flow.ru. Runbook:
[`notes/DEPLOY.md`](DEPLOY.md) (provision VPS, GitHub Secrets, первый push).

### Phase P5.8 — Chain classifier history fetchers (2026-05-12)

Closing the dead-code gap in Phase 5: `ChainClassifierService` теперь
получает реальные fetcher'ы вместо `null, null`. При flag'е
`chain_classifier.enabled = true` для account'а worker реально
тащит транзакции и складывает в `metrics.chainClassifier`.

- **`DeBankClient.getHistory(address, opts?)`** в
  `modules/integrations/debank.ts`:
  - Endpoint `/v1/user/all_history_list?id=...&page_count=20&start_time=...`
  - Cursor: `start_time` от `time_at` последнего item'а предыдущей
    страницы
  - Merge: `token_dict` / `project_dict` / `cex_dict` через все
    страницы; dedupe по `tx.id`
  - Stop conditions: empty page, partial page (<20), maxPages
    (default 10 = ~200 tx), cursor не двигается
  - `ProviderError` на non-OK status; `ProviderNotConfiguredError`
    при отсутствии key'а
- **`HeliusClient.getTransactions(address, opts?)`** в
  `modules/integrations/helius.ts`:
  - Endpoint `/v0/addresses/{addr}/transactions?limit=100&before=...`
  - Cursor: `before` = signature последней tx предыдущей страницы
  - Dedupe по `signature`; loose `HeliusTransactionRaw` shape (strict
    parsing — в classifier модуле)
  - Stop conditions: empty page, partial page (<100), maxPages
    (default 10 = ~1000 tx), `timestamp >= lastTime`
  - **Graceful no-key**: возвращает `[]` если key не настроен (как
    `getBalances`)
- **Wire в `worker.ts`**: тонкие adapter'ы (5 строк каждый) кастят
  loose provider shapes в strict classifier types. Один `as unknown`
  cast на границе — честно, потому что классификатор владеет
  re-parsing'ом в `classifier/{debank,helius}_types.ts`.
- **Tests** — 14 кейсов:
  - DeBank (7): auth header, missing-key throw, pagination via
    start_time, accumulate dicts, maxPages cap, partial-page stop,
    dedupe across pages, 5xx propagation
  - Helius (7): auth query, no-key returns [], pagination via before
    cursor, maxPages cap, partial-page stop, dedupe overlapping
    signatures, 5xx propagation
- **Total api**: **457/457 green** (после P5.8 +14 тестов к 443).

### Phase S3.5 — Cookie-based session для viem (Alchemy через proxy) (2026-05-12)

Закрыта последняя дыра S-фазы: Alchemy ключ больше не уходит в
клиентский бандл. Frontend ходит на `/api/v1/upstream/alchemy/{chain}`
через viem `http()` транспорт; бекенд auth'ит запрос по **HttpOnly
cookie** (`cap_access`), который выставляется при login/refresh и
зачищается при logout.

- **`auth.cookies.ts`** — `ACCESS_COOKIE_NAME = "cap_access"`,
  `setAccessCookie` / `clearAccessCookie`:
  - HttpOnly + Secure (когда `COOKIE_SECURE=true` в prod)
  - **SameSite=lax**: блокирует cross-origin state-changing
    запросы, но пропускает viem-вызовы с `credentials: "include"`
  - **path=/api/v1/upstream** — браузер шлёт cookie ТОЛЬКО на
    upstream-proxy endpoints, не на остальные API (минимизация
    XSS attack surface)
  - maxAge = `min(JWT_ACCESS_TTL_MIN * 60, 24*3600)` — даже при
    утечке cookie живёт не дольше 24 часов
- **`extractAccessToken(req)`** — pure helper: Bearer header
  (preferred) → fallback на `cap_access` cookie → null. 8 unit-тестов
  покрывают header/cookie precedence, пустые токены, не-Bearer
  схемы.
- **`auth.routes.ts`**:
  - `login` + `refresh` → `setAccessCookie(reply, accessToken, ...)`
    одновременно с `setRefreshCookie`
  - `logout` → `clearAccessCookie` симметрично
- **`plugins/auth.ts`**: `requireAuth` теперь через
  `extractAccessToken`, поддерживает оба пути auth (header + cookie).
- **Frontend**:
  - `alchemyRpcUrl(dep, _apiKey)` восстановлен →
    `/api/v1/upstream/alchemy/{subdomain}`, apiKey игнорится
  - В 4 viem-callers'ах (`v3/positions`, `v3/liquidity_events`,
    `v3/historical_pool_price`, `aave/data_provider`) добавлен
    `fetchOptions: { credentials: "include" }` — браузер
    автоматически шлёт `cap_access` cookie
  - `integrations.ts` `alchemyApiKey = SERVER_MANAGED` (как и
    остальные 3), `VITE_ALCHEMY_API_KEY` больше не читается
- **Bundle verification** (`pnpm vite build` → grep):
  - DeBank key (206a22f...) — **0 occurrences** ✅
  - Etherscan key (H7W5XEJSW7...) — **0 occurrences** ✅
  - Alchemy key (a-p-YS5FW5...) — **0 occurrences** ✅
- **Tests**: 443/443 green (8 новых для auth.cookies + tsc clean).

### Phase S4 — Удаление client-side API-ключей из бандла (2026-05-12)

Завершение SaaS-режима для ключей: юзеры **больше не вводят и не
видят** настройки DeBank/Helius/Etherscan. Все запросы идут через
backend upstream-proxy с admin-ключами. Verified: production build
grep — keys 0/0/0 в бандле, кроме Alchemy (известная утечка до S3.5).

- **`apps/web/src/lib/integrations.ts`**:
  - DeBank/Helius/Etherscan defaults = `"managed-by-server"`
    sentinel (non-empty → проходит `if (key.trim())` gating'и в
    `LoadedWalletsProvider`, никак не уходит в HTTP)
  - **localStorage migration**: даже если у юзера в localStorage
    лежит реальный ключ из до-SaaS-эры — финальный merged-объект
    принудительно overrides эти 3 поля. Старый ключ юзер не видит
    и не может вернуть
  - `VITE_*` env-vars **больше не читаются** для server-managed
    провайдеров. Vite tree-shaking исключает их из бандла. Read
    остался только для **`VITE_ALCHEMY_API_KEY`** (узкий single
    literal access, не whole-object `import.meta.env`)
  - Vybe/Jupiter/CoinStats/Solscan/Shyft defaults = `""` (фичи
    disabled через `SHOW_NON_EVM_PROVIDERS = false`)
- **`apps/web/src/pages/SettingsPage.tsx`**:
  - `IntegrationsSection` → один `ManagedByAdminBanner` с зелёным
    `ShieldCheck` иконкой и текстом «API-ключи управляются
    администратором»
  - Удалены 4 dead-функции: `ProviderGroupHeader` (~40 строк),
    `KeyCard` (~140 строк), `SolscanTestButton` (~130 строк),
    `ShyftTestButton` (~110 строк). Всего ~420 строк
  - Зачищены `Eye`/`EyeOff`/`useIntegrations` imports
- **Bundle verification** (`pnpm vite build` → grep на ключи в
  `dist/assets/*.js`):
  - DeBank key (206a22f...) — 0 occurrences ✅
  - Etherscan key (H7W5XEJSW7...) — 0 occurrences ✅
  - Alchemy key (a-p-YS5FW5...) — 1 occurrence (known leak,
    задокументировано в `v3/chains.ts:alchemyRpcUrl` TODO; чинится
    в S3.5 — cookie-based session для viem `http()` transport)
- **Tsc**: clean для всех S3-S4 затронутых файлов.

### Phase S3 — Frontend через backend upstream-proxy (2026-05-12)

DeBank / Helius / Etherscan клиенты на фронтенде перенесены на
backend-proxy. Ключи к этим провайдерам больше **не нужны клиенту**
и не запекаются в production-бандл. Минимальная инвазия: тронут
только transport-layer (`request` функции), сигнатуры публичных
методов с параметром `accessKey` / `apiKey` сохранены — call-sites
не трогали (S4 их подчистит).

- **`apps/web/src/lib/api/client.ts`** — добавлен `apiFetch(path,
  init?)`: authenticated raw fetch (Bearer от tokenStore +
  single-flight refresh + credentials:include). Возвращает `Response`,
  caller сам парсит body (Zod-валидация неуместна — это foreign
  upstream).
- **`debank.ts`** — `BASE = "/v1/upstream/debank"`, `request` через
  `apiFetch`. `accessKey` параметр игнорится (compat для существующих
  call-sites). Auth/refresh — наш Bearer; `DeBankAuthError` теперь
  значит «backend сказал что нет admin-key» или «401 на upstream».
- **`helius.ts`** — `BASE = "/v1/upstream/helius"`, аналогично.
- **`etherscan_logs.ts`** — `PROXY = "/v1/upstream/etherscan"`,
  через `apiFetch`, `apikey` параметр игнорится.
- **`v3/chains.ts:alchemyRpcUrl`** — **отложено в S3.5**. viem `http()`
  transport использует static `fetchOptions` — динамически
  инжектить refreshable Bearer нельзя. Требуется cookie-based access
  session (httpOnly, выдаётся login/refresh), чтобы
  `credentials: "include"` несла auth автоматически. Документировано
  в TODO в коде; для беты предлагается low-quota Alchemy ключ +
  ротация после S3.5.
- **Tests** — frontend tsc clean (рефакторинг сохраняет сигнатуры),
  API suite 435/435 green.

### Phase S2 — Per-user rate-limit for upstream-proxy (2026-05-12)

Защита admin'овских API-квот (DeBank Pro $199/mo, Helius paid,
Alchemy paid) от runaway-юзеров. Fixed-window dual-bucket:
**60 req/min + 600 req/hour per user**.

- **`rate-limit.ts`** — `UpstreamRateLimitService` поверх
  `RateLimitStore` интерфейса (clean separation для тестов):
  - `InMemoryRateLimitStore` — for vitest, `clock` injection для
    timeline-control
  - `RedisRateLimitStore` — `pipeline().incr().expire().exec()`,
    атомарно, 2 round-trip total
- **Decision shape**: `{allowed, remainingMinute, remainingHour,
  retryAfterSeconds}`. retry-after правильно считается из границы
  бакета (а не plain `windowSec`).
- **Wire в `upstream-proxy.routes.ts`**: новый preHandler-вызов
  до `service.forward`. На reject — HTTP 429 +
  `Retry-After` / `X-RateLimit-Remaining-Minute` /
  `X-RateLimit-Remaining-Hour` headers + audit-запись `error:
  "rate_limited"` в `api_usage`.
- **DI в `app.ts`**: `RedisRateLimitStore(app.redis)` + config
  `{perMinute: 60, perHour: 600}`.
- **Tests** — 8 кейсов:
  - под лимитом (count remainingMinute)
  - 4-й запрос при limit=3 reject
  - per-user isolation
  - minute window rollover (clock+61s)
  - hour-cap reject даже если minute-cap fresh
  - hour window rollover (clock+3600s)
  - retry-after math (правильная граница бакета)
  - InMemoryRateLimitStore TTL semantics

**Total api-модуль**: **435/435 green**.

### Phase S1 — Upstream API proxy (2026-05-12)

**Security блокер для public-beta**. Раньше DeBank/Helius/Alchemy/
Etherscan ключи (`VITE_*`) запекались в frontend-бандл — любой юзер
мог их вытащить через DevTools и слить admin'овский DeBank Pro
($199/mo). Phase S1 закрывает дыру: frontend ходит за этими
провайдерами **через backend-proxy** с server-side ключами.

- **`upstream-proxy.service.ts`** — `UpstreamProxyService.forward(req)`:
  - Registry 4 провайдеров: DeBank, Helius, Etherscan, Alchemy
    (остальные — Jupiter/Vybe/CoinStats/DefiLlama — добавятся
    incrementally по мере того как frontend их использует)
  - Auth strategies: `header` (DeBank AccessKey), `query` (Helius
    api-key, Etherscan apikey), `alchemy` (path `/v2/{KEY}` +
    chain subdomain)
  - **Path allow-list per провайдер** (SSRF/scrape-protection):
    DeBank `^v1\/(user|token|cache|protocol|chain|cex|asset|tx|nft)`,
    Helius `^v0\/(addresses|transactions|nfts)` либо `^v1\/.+`,
    Etherscan `^v2\/api` либо `^api`, Alchemy — whitelist 7
    chain-subdomains (eth/arb/opt/base/polygon/bnb/avax mainnet)
  - **Key never overrideable by client**: `searchParams.set` (не
    `append`) перезаписывает любой `api-key=`, который пытался
    подкинуть hostile-клиент
  - **Authorization header не форвардится** на upstream
  - **Key редактится в error messages** (`redactKey` чистит URL
    даже если fetch вылез с stringified URL)
  - Errors типизированы: `unknown_provider | missing_api_key |
    forbidden_path | network | internal`
- **`upstream-proxy.routes.ts`** — Fastify route `* /v1/upstream/
  :provider/*`:
  - JWT-required (`app.requireAuth` preHandler)
  - Body / query forwarded; method preserved (GET/POST/PUT/DELETE/PATCH)
  - Upstream response mirrored verbatim (status + body + Content-Type)
  - Per-user audit в существующую `api_usage` таблицу
    (`provider: "upstream:<name>"`, userId, endpoint, status, duration)
  - `UpstreamProxyError.kind` → HTTP status (404/503/403/502/500)
- **DI в `app.ts`**: prefix `/upstream` под `/api/v1`, использует
  существующий `apiUsageRepo`.
- **Tests** — 20 кейсов:
  - DeBank: AccessKey header, SSRF path-block, missing-key error
  - Helius: api-key в query, preserve other params, client cannot
    override api-key
  - Etherscan: apikey в query
  - Alchemy: per-chain subdomain, path-key injection, whitelist
    accepts 6 chains, reject non-whitelisted (`evil.example.com`)
  - General: unknown provider, no Authorization echo, 5xx propagate,
    network exception → typed error
  - Key redaction in error messages

**Total api-модуль**: **427/427 green**.

### Phase P5.7 — Chain classifier wire-up under feature flag (2026-05-12)

Финальный кусок Phase 5 — оркестратор `ChainClassifierService`
склеивает все pure-модули (P5.1-P5.6), gate'ится feature-flag'ом
`chain_classifier.enabled` (account-scoped), интегрирован в
`PortfolioRefreshService` fail-soft контрактом.

- **`chain_classifier.service.ts`** —
  `ChainClassifierService.analyzeAccount({accountId, addresses})`:
  1. Resolve flag через `FeatureFlagsService.enabled(...)`. OFF →
     short-circuit (`{enabled: false, classified: 0, ...}`), 0 fetcher
     calls.
  2. EVM addresses: вызов `EvmHistoryFetcher(addr)` → `classifyHistory`
     (P5.3). All addresses сложены в общий `ownAddresses` Set.
  3. Solana: вызов `SolanaHistoryFetcher(addr)` → `classifyHeliusHistory`
     (P5.4).
  4. Сводный `computeLpCloseAttribution` (P5.5) поверх всех ops.
  5. Per-address exception → `errors[]`, остальные адреса
     продолжают (fail-soft на уровне сервиса).
  6. Result: `{enabled, classified, byType, lpAttributions,
     skippedEvm, skippedSolana, errors[]}`.
- **Fetcher DI**: `EvmHistoryFetcher` / `SolanaHistoryFetcher` —
  function types, `null` = capability absent (skip addresses этой
  сети, count в `skippedEvm/skippedSolana`). Реальные адаптеры на
  DeBank/Helius transaction-feed клиенты приедут отдельным stage
  (P5.8+), когда понадобятся; **архитектурный seam уже на месте**.
- **`PortfolioRefreshService` wire**:
  - Constructor +1 параметр `ChainClassifierService`
  - Inline `try/catch` после ledger cost-basis: при exception →
    `metrics.chainClassifierError`, balances и costBasis не задеты
  - Result в `metrics.chainClassifier: {enabled, classified, byType,
    lpAttributions, skippedEvm, skippedSolana, errors[]}`
- **`worker.ts` DI**:
  - Dedicated `ioredis` connection для flags JsonCache (отдельная от
    BullMQ, чтобы flag reads не конкурировали с queue traffic)
  - `FeatureFlagsService` instantiation
  - `ChainClassifierService(flags, null, null)` — fetchers null до
    отдельного wire-up'а DeBank/Helius history
- **Tests** — 9 кейсов для `ChainClassifierService`:
  - flag OFF → short-circuit, 0 fetcher calls
  - flag ON → fetcher called
  - EVM classification + byType counts (no project → swap)
  - LP attribution: 1 add + 1 close same protocol → 1 attribution
  - Solana path с fetcher
  - skippedSolana counter при null fetcher
  - fail-soft на throw в fetcher
  - 1 address fails, остальные работают
  - канонический flag key `chain_classifier.enabled` + accountId ctx
- **Total classifier-модуль**: **407/407 green**, 12 файлов.
- **Phase 5 ИТОГ**: 7/7 этапов закрыты, **407 unit-тестов**, нулевой
  regression в существующих модулях.

### Phase P5.6 — DefiLlama historical-prices fetch + cache (2026-05-12)

Сетевой слой для historical-prices через `https://coins.llama.fi`,
питающий `lp_attribution.movementUsd()` (P5.5) и будущий
PortfolioRefreshService wiring (P5.7).

- **`defillama_prices.ts`** — port `fetchHistoricalPrices(items,
  signal?)` из web `defillama.ts`. Контракт сохранён: вход —
  `[{coin, timestamp}]`, выход — `Map<cacheKeyFor(coin, ts), price>`
  (lookup через `priceFromMap`).
- **Отличия от web**:
  - In-memory `Map` cache (process-local). Historical-цены
    immutable → не expirят пока процесс жив. Restart очищает.
  - Direct `https://coins.llama.fi` (без Vite-прокси).
  - `defillamaBaseUrl()` override через `DEFILLAMA_BASE_URL` env —
    для тестов / dev-mock.
  - `__resetDefillamaCache()` для test isolation.
- **Алгоритм**:
  1. Drain cache по `cacheKeyFor(coin, ts)`
  2. Group misses по hour-bucket (`bucketTs`) + dedup coin'ов
     внутри bucket'а (Set)
  3. Chunked GET 50 coin'ов на URL: `/prices/historical/{ts}/{csv}?searchWidth=4h`
  4. Per-chunk error swallow (network / non-OK status) — не валим
     остальные buckets
  5. Записываем результат в cache + return Map
  6. Abort signal проверяется между chunk'ами + buckets
- **Tests** — 15 кейсов: empty input (no fetch), single coin baseline,
  cache hit/miss/reset, bucket grouping (same/diff hour),
  dedup-within-bucket, chunking >50 / =50 / <50, error resilience
  (500 status / network throw / price=0 / missing price), abort
  prevents subsequent chunks.
- **Total classifier-модуль**: **398/398 green**, 11 файлов.

### Phase P5.5 — Classifier port: LP close attribution (2026-05-12)

Распределение USD-стоимости LP-депозитов по последующим закрытиям
позиции. Без этого закрытие LP считается как «материализация прибыли»
по spot, не привязанной к тому, сколько пользователь реально вложил.

- **`defillama_keys.ts`** — pure subset of legacy `defillama.ts`:
  `defillamaCoinKey(chain, tokenId, symbol)` — (chain, tokenId, symbol)
  → DefiLlama coin id. Native (`tokenId === chain`), legacy `"eth"`,
  EUR-stables (coingecko:euro-coin / monerium-eur-money / etc.),
  EVM address → `{llamaChain}:{address.lower()}`, Solana mint →
  `solana:{mint}`, symbol fallback (ETH/WETH → eth, SOL → sol,
  BTC/WBTC → coingecko:bitcoin). `bucketTs` (hour bucketing),
  `cacheKeyFor(coin, ts)`, `priceFromMap(map, coin, ts)`. Чистый —
  fetch/cache I/O пойдут в P5.6.
- **`lp_attribution.ts`** — port `attributeLpCloses` +
  `computeLpCloseAttribution`:
  - Группировка по `(protocolId, chain)`
  - depositUsd = Σ USD-стоимости out-side legs всех `lp_add`-ов
  - закрытия (`lp_remove`) разносятся пропорционально их `closeUsd`
    от суммарного closeUsd группы
  - per-symbol split внутри закрытия — пропорционально `m.usd /
    closeUsd_i`
  - `movementUsd` resolution: USD-stable → $1; иначе hist-price
    через DefiLlama (`priceFromMap`); fallback → `m.usd`; иначе 0
  - WETH → ETH нормализация в финальной map
  - failed + junk-tagged ops пропускаются
- **Tests** — 15 кейсов для `computeLpCloseAttribution` (single
  open/close, multiple closes prorated, multiple opens summed,
  separate protocols/chains, failed/junk filtered, hist-price
  fallback positive+negative, WETH→ETH normalization, input sort
  stability) + 22 для defillama_keys (native, EUR stables, EVM/Sol
  addresses, symbol fallback, edge cases, cacheKeyFor bucketing).
- **Total classifier-модуль** теперь **383/383 green**, 10 файлов.

### Phase P5.4 — Classifier port: Solana classifier (2026-05-12)

Solana ветка classifier'а: Helius transactions → ClassifiedOp[].
Сохраняет совместимость с EVM-веткой (тот же `ClassifiedOp` тип) →
один reducer обрабатывает обе сети.

- **`helius_types.ts`** — slice `HeliusTransaction`,
  `HeliusNativeTransfer`, `HeliusTokenTransfer`, `HeliusInstruction`.
- **`spl_tokens.ts`** — registry mint → meta (USDC/USDT/PYUSD/USDH
  stables + JitoSOL/mSOL/JLP positions + основные SPL).
  Helpers: `symbolForMint`, `isStableMint`, `priceForMint`
  (stables = $1, остальные = null), `positionForMint` (с heuristic
  для Kamino kXxx / Solend cXxx / MarginFi MFI), `looksLikeSpam`
  (1-2 letter blacklist + URL patterns + name field check).
  Также `classifySolSource` (Helius `source` → ProtocolInfo с 40+
  программ Jupiter/Raydium/Orca/Solend/Kamino/Marinade/Jito/Drift/
  Wormhole/...) и `isSolCexAddress` (7 hot-wallet addresses).
- **`solana_classifier.ts`** — `classifyHeliusHistory(raw, ctx)`.
  Иерархия сигналов:
  1. failed (transactionError set)
  2. CEX detection (counterparty address ∈ SOL_CEX_ADDRESSES)
  3. Internal transfer (other own wallet в participants, no protocol)
  4. **Helius `type` switch** (SWAP/STAKE_SOL/DEPOSIT/WITHDRAW/BORROW/
     REPAY/ADD_LIQUIDITY/CLAIM_REWARDS/...) с context-aware
     DEPOSIT/WITHDRAW (lending vs perp)
  5. Movement direction heuristics per category (lending receives →
     borrow, sends → repay; perp/yield sends → lp_add; bridge sends
     → bridge_out)
  6. **Net-balance swap fallback** для Jupiter multi-leg (fees в
     SOL + основной swap дают net-in/net-out по mint'ам)
  7. Plain transfer_in/out / unknown
- **Tests** — 32 теста (sort+dedupe, failed, CEX, internal transfer,
  Helius type dispatch для 11 типов, heuristics для lending/perp/
  bridge, net-balance swap, plain transfer, movement enrichment,
  base fields). Также 39 тестов для spl_tokens.
- **Total classifier-модуль** теперь **346/346 green**, 8 файлов
  (`types`, `debank_types`, `helius_types`, `protocols`, `junk_filter`,
  `token_roles`, `spl_tokens`, `classifier`, `solana_classifier`).

### Phase P5.3 — Classifier port: EVM classifier core (2026-05-12)

Главный кусок Phase 5 — `classifyHistory(raw, ctx)`: чистая функция,
превращает сырой DeBank-history в `ClassifiedOp[]` с финансовыми
категориями. Junk-detection прогоняется вторым проходом.

- **`apps/api/src/modules/classifier/debank_types.ts`** — slice внешних
  API типов (`DeBankHistoryItem`, `DeBankToken`, `DeBankProject`,
  `DeBankTx`, `DeBankSendOrReceive`, `DeBankTokenApprove`). Сетевой
  клиент остаётся отдельно в `modules/integrations/`.
- **`classifier.ts`** — port `classifyHistory`, `classifyLending`,
  `classifyDex`, helper'ы `buildMovements / toMovement / base`. Сорт
  «старые → новые», dedupe по `chain:id`, корректная enrichment'а
  movement'ов через `protocols.ts` + junk-теги в `op.notes`.
- **Branch coverage**:
  - failed (status=0) с junk:mev_failure/failed
  - approve guard (1inch-swap не помечается approve)
  - CEX deposit_fiat / withdraw_fiat
  - transfer_in/out между своими адресами (не срабатывает если есть
    protocol)
  - bridge_in / bridge_out (Stargate)
  - Lending receipt-based (Aave): borrow / repay / lend_supply /
    lend_withdraw + combined-supply-borrow + combined-withdraw-repay
  - Lending receipt-less (Morpho Blue): borrow / repay (allStables) /
    lend_supply (non-stable collateral / GLV) / compound-supply-borrow
  - Staking/restaking: stake / unstake / claim_rewards
  - Yield/Perp async deposits (GMX V2): Tx A (sends-only) / Tx B fill
    (receives-only protocol-token) / withdraw symmetry / internal swap
  - DEX/LP: swap / lp_add (recv LP) / lp_remove (sent LP) /
    v3-increase-liquidity (sends only) / v3-collect-fees (receives only)
  - Plain swap (1in/1out без project), plain transfer_in/out, unknown
- **Tests** — 43/43 green; общий прогресс classifier-модуля 275/275.

### Phase P5.2 — Classifier port: token_roles (2026-05-12)

Контекстная классификация роли токена в КОНКРЕТНОМ протоколе. Без
этого слоя classifier путал GLV-в-Morpho (collateral) с
GLV-в-GMX (receipt). TDD: тесты → red → port → green.

- **`apps/api/src/modules/classifier/token_roles.ts`** — port из
  `apps/web/src/lib/portfolio/token_roles.ts`.
- Экспорты: `TokenRole`, `registerReceiptLessOracle`,
  `isReceiptLessProtocol`, `isReceiptOfProtocol`,
  `isDebtReceiptOfProtocol`, `classifyTokenRole`.
- Иерархия детекции:
  1. **`RECEIPT_CONTRACTS`** whitelist (contract-address) — точно,
     без false-positives. GMX V2 GM markets, GLV vaults, Aave V3
     aTokens / variableDebt, Fluid fVLT NFT.
  2. **Symbol-pattern matching** per family (Aave aXxx/cXxx, Compound
     cXxx, Fluid fVLT, GMX GM/GLV/GLP, Flash FLP, Lido/Rocket/EigenLayer
     LSTs, Pendle PT/YT, Aerodrome/Velodrome, Uniswap-family LP).
  3. Default `false` — лучше "underlying" чем неверный receipt.
- **Receipt-less protocols** (Morpho Blue, Drift Spot, Adrena):
  positions live внутри контракта, в кошельке нет receipt'а.
  Hardcoded list + external oracle hook (`registerReceiptLessOracle`)
  для DefiLlama-backed автодетекта неизвестных протоколов.
- **`isDebtReceiptOfProtocol`** — отличает variableDebt/stableDebt
  (Aave) от обычных aTokens. Critical для classifier: borrow ≠ supply.
- **Tests** — 65/65 green:
  - Contract whitelist (chain-prefix strip, GMX/GLV/Aave)
  - Aave aTokens vs underlying vs debt-receipts
  - Morpho Blue: ВСЕ токены underlying (даже GLV / aUSDC / stETH)
  - Compound, Fluid, GMX, Flash, Lido/RP/EF/Renzo/Kelp, LBT,
    Pendle PT/YT, Uniswap-family
  - Oracle: hardcoded > oracle > false fallback
  - `classifyTokenRole` dispatcher с null protocolId fallback

### Phase P5.1 — Classifier port: protocols + junk_filter (2026-05-12)

Стартовый кусок Phase 5 — pure functions, без I/O. TDD: тесты до
порта, реализация под зелёные тесты.

- **`apps/api/src/modules/classifier/types.ts`** — slice from
  `apps/web/src/lib/portfolio/types.ts`: `OpType`, `ProtocolCategory`,
  `ProtocolInfo`, `TokenMovement`, `ClassifiedOp`. Расширяется в P5.3+.
- **`protocols.ts`** — `classifyProtocol`, `isEurStableSymbol`,
  `tokenFamily`, `isStableSymbol`, `isProtocolToken`,
  `isLendingReceipt`. 1-в-1 port из web; адаптирован под NodeNext
  `.js` imports. Покрытие — 50+ протоколов (Aave/Fluid/Compound/
  Morpho/Spark, Uniswap/Curve/Balancer, Lido/Rocket/Ether.fi,
  GMX/Hyperliquid/dYdX, Stargate/Across/LayerZero).
- **`junk_filter.ts`** — `classifyJunk` (mev_failure / failed / dust /
  scam_airdrop / unknown_phantom / empty_movement), `isJunkOp`,
  `junkReason`. KNOWN_AIRDROP_TOKENS allow-list (LDO/ARB/OP/JTO/JUP/
  ZK/...) защищает legitimate airdrops от ложных срабатываний.
- **Tests** — 167/167 green:
  - `protocols.test.ts` — 132 теста (классификация всех категорий,
    case-sensitivity для aTokens/cTokens, normalization tokenFamily,
    false-positive guard для ARB/AAVE/AVAX и т.п.)
  - `junk_filter.test.ts` — 35 тестов (failed-tx short-circuit, dust
    threshold, scam patterns, no double-tag scam+phantom)

### Phase F4.5 — Cost-basis widget на дашборде (2026-05-12, **откатан**)

Сделан и убран в той же сессии. Причина: отдельная карточка-виджет
ввела в заблуждение — концептуально cost basis из журнала должен
интегрироваться в «Сводку по капиталу» / `CapitalHero` одной серией,
не существовать как параллельная сущность. Архитектурно правильный
момент для интеграции — после Phase 5 (chain classifier), когда
`operations` будет автоматически наполняться промоутированными
on-chain записями и ledger WAC станет полным WAC (а не только
тем, что пользователь импортирует руками).

Удалены: `apps/web/src/features/portfolio/{api,hooks,CostBasisWidget}.ts(x)`,
i18n keys `costBasis.*`. Backend (`metrics.costBasis` в snapshot) и
импорт-страница `/operations` сохраняются — это data layer для будущей
интеграции.

### Phase F4.4 — Import UI (JSON paste) (2026-05-12)

Поверх read-only UI добавлена панель импорта операций.

- **Zod-схема `importItemSchema`** + `importItemsSchema = array.min(1).max(5000)`
  в `apps/web/src/features/operations/api.ts`. Полностью зеркалит серверную
  схему из `operations.routes.ts` (legacyId/date YYYY-MM-DD/type enum +
  все опциональные numeric/text поля).
- **`ImportPanel`** компонент в `OperationsPage.tsx`: textarea для JSON,
  кнопки `Импортировать / Подставить пример / Закрыть`. Раздельная
  обработка parse error (плохой JSON) и validation error (Zod), success
  показывает `{inserted, updated, total}` через `useImportOperations`
  мутацию. Hook автоматически invalidate'ит `list` + `stats`.
- **Toggle** через кнопку в header страницы (`Импорт` ↔ `Закрыть`).
- **Example payload** — 2 готовые операции (buy ETH/USDC + swap USDC/SOL)
  загружаются одним кликом.
- **i18n** en/ru: `operations.import.*` (title/hint/toggle/submit/close/
  example/errorParse/errorValidation/success). Success-строка использует
  3-аргументный t() с интерполяцией `{0} {1} {2}`.

### Phase F4 — Operations UI read-only (2026-05-12)

Frontend-обвязка для Phase 4 backend'а. Read-only журнал
импортированных операций, доступный из sidebar.

- **API-клиент** `apps/web/src/features/operations/api.ts` —
  Zod-схемы `operationSchema` / `operationsStatsSchema` /
  `importResultSchema`, `operationsApi` object с методами
  `list / stats / import / delete`. URLSearchParams для
  `{from, to, limit, offset}` фильтров.
- **React Query hooks** `apps/web/src/features/operations/hooks.ts` —
  `useOperations`, `useOperationStats`, `useImportOperations`,
  `useDeleteOperation`. Cache keys `["operations", "list"|"stats", accountId, …]`,
  staleTime 30s, мутации invalidate'ят `list` + `stats`.
- **Страница `/operations`** (`apps/web/src/pages/OperationsPage.tsx`) —
  read-only stats-карточки (count, lastUpdatedAt) + таблица с date
  фильтрами + reset. Type badges, network, fromName/toName,
  amount1/amount2, priceUsd. Empty-state и error-state.
- **Sidebar nav** entry `nav.operations` (Operations / Операции,
  иконка `ScrollText`), роут в `App.tsx` под `ProtectedRoute`.
- **i18n** en/ru: `operations.title`, `.subtitle`, `.stats.*`,
  `.filter.*`, `.empty.*`, `.error`, `.col.amount`, `.col.value`.

### Phase 4 — Cost basis из operations ledger (2026-05-12)

Первый кусок cost-basis tracker'а на сервере. Полный chain-classifier
порт оставлен на **Phase 5** (5-7 микро-этапов).

- **TS-схема** для legacy `operations` таблицы
  (`packages/db/src/schema/operations.ts`): enums `op_type` /
  `op_source` / `funds_kind`, 29 numeric/text колонок, unique
  `(account_id, legacy_id)`.
- **Operations module**
  (`apps/api/src/modules/operations/{repository,service,routes}.ts`) с
  4 endpoint'ами под `/api/v1/accounts/:id/operations[/...]`:
  GET list (с date-фильтрами + limit/offset), GET stats
  (count + lastUpdatedAt), POST import (batch до 5000 строк), DELETE.
  Tenant isolation через `accounts.getById(actor)`. Idempotent batch
  через `INSERT ... ON CONFLICT (account_id, legacy_id) DO UPDATE`,
  insert/update счётчик через Postgres `xmax = 0` трюк.
- **Pure cost-basis WAC** в
  `apps/api/src/modules/cost-basis/cost-basis.ts`:
  `computeCostBasis(ops)` — cumulative `avg = Σ paid_usd / Σ
  bought_amount` per symbol. Поддерживает `buy / sell / swap /
  transfer / deposit / withdraw / fee`. Crossed swap (asset→asset) —
  только decrement без новой basis (требует hist-price, отложено в P5).
- **Inline вызов в `PortfolioRefreshService`**: при каждом refresh
  worker читает всю историю (`OperationsRepository.listAllForReplay`),
  считает WAC, пишет в `metrics.costBasis: []`. Расчёт в `try/catch`
  — ошибка проглатывается в `metrics.costBasisError`, balances и
  totalUsd не затронуты (fail-soft контракт).
- Snapshot `metrics` теперь дополнительно содержит:
  ```
  operationsCount: 0..N,
  costBasis: [
    {symbol, avgUsd, runningAmount, totalPaidUsd, totalBoughtAmount, lastUpdate}
  ],
  costBasisError?: "..."
  ```
- Audit events: `operations.import` (с inserted/updated/total),
  `operations.deleted`.

См. [[decisions/saas-phase4-cost-basis]].

### Phase 3c — Solana balances (Helius) + Wallets UI (2026-05-11)

Закрыли вторую экосистему + frontend для wallet management.

- **`/wallets` page** (user-side): split master/detail, create/rename/delete
  wallets, add/delete addresses (EVM + Solana + Tron + BTC + Other types),
  EVM chain selector. Sidebar link добавлен.
- **`HeliusClient`** в `apps/api/src/modules/integrations/helius.ts` —
  реальный fetch к `api.helius.xyz/v0/addresses/:addr/balances`,
  graceful no-key fallback (returns empty без ошибки).
- **Pipeline разделил per-network branches**: EVM → DeBank, Solana →
  Helius, остальное → `metrics.addressesSkipped` для tech-audit.
- **Snapshot metrics** теперь содержат `addressesEvm`, `addressesSolana`,
  `addressesSkipped`, `refreshedFrom[]`, `perAddress[]` с `kind` discriminator.
- `totalUsd` пока EVM-only — Solana per-SPL pricing требует mint→cg_id
  mapping (отдельный slice, не блокирует pipeline).
- Env: добавлены `HELIUS_API_KEY` + `COINSTATS_API_KEY` (последний под
  Phase 3d если решим использовать Coinstats как multi-chain agregator).
- **E2E**: Solana адрес добавлен (Mango Markets v4), worker отработал
  без ошибок при отсутствии key, snapshot c `addressesSolana: 1,
  refreshedFrom: ["debank"]` (Helius graceful skip).

См. [[decisions/saas-phase3c-solana]].

### Phase 3b — wallets CRUD + real refresh pipeline (DeBank) (2026-05-11)

Закрыта последняя дыра между «есть аккаунт» и «видим реальные деньги».

- **TS-схема** для `wallets` + `wallet_addresses` (таблицы уже в БД от
  legacy, без миграции — только Drizzle типизация).
- **Wallets CRUD** под `/api/v1/accounts/:id/wallets[/:wid][/addresses[/:aid]]`:
  GET/POST/PATCH(rename)/DELETE для wallets, GET/POST/DELETE для
  addresses. Tenant isolation через `accounts.getById(actor)` на каждой
  мутации. Unique `(account_id, name)` и `(wallet_id, address)`.
- **Real refresh pipeline**: `PortfolioRefreshService.refreshAccount`
  теперь подтягивает `wallet_addresses` по аккаунту, для каждого EVM
  адреса вызывает `DeBankClient.getTotalBalance` (один call по всем
  chains), суммирует USD, пишет snapshot с `metrics.perAddress[]`.
- Каждый upstream call идёт через `api_usage` лог.
- Non-EVM адреса (solana/tron/btc/other) принимаются в БД, но в TVL не
  resolve-ятся — записываются в `metrics.addressesSkipped`.
- **E2E с реальным DeBank**: создали wallet → добавили Vitalik's
  address → manual refresh → snapshot c `totalUsd: 1,276,679.17`,
  `refreshedFrom: ["debank"]`. Platform aggregate `totalUsd` тоже
  подскочил с $0 на $1.27M.
- Tenant isolation: Alice → admin's `/wallets` = **403**, своя пустая.
- audit_log: `wallet.created`, `wallet.address_added`.

См. [[decisions/saas-phase3b-wallets-refresh]].

### Post-Phase 8 polish: real provider clients + sidebar links (2026-05-11)

Три маленьких этапа после закрытия Phase 0–8 backend + frontend ветки A.

- **Этап 1: Sidebar polish.** Добавлены ссылки на новые страницы в обеих
  навигациях. User: `/billing` (CreditCard), `/preferences` (BellRing).
  Admin: `/admin/billing` (CreditCard), `/admin/feature-flags` (Flag).
  i18n ключи `nav.billing` / `nav.preferences` для ru+en.
- **Этап 2: реальные Tronscan + Etherscan клиенты** для billing
  auto-credit. `TronscanClient` ходит на `apilist.tronscanapi.com/api/token_trc20/transfers`
  с USDT_TRC20 contract фильтром, парсит amount по 6-decimal scale,
  маппит binary `confirmed` → 200. `EtherscanUsdtClient` ходит на
  `api.etherscan.io/api?module=account&action=tokentx` с USDT_ERC20
  contract фильтром, считает confirmations integer-ом. Оба сохраняют
  graceful-fallback к пустому массиву если ключ не задан.
- **Этап 3a: реальные Alchemy + DeBank клиенты** для wallet balances.
  `DeBankClient` использует `AccessKey` header, ходит на
  `/v1/user/total_balance` (агрегат USD по chains) и `/v1/user/all_token_list`
  (per-chain breakdown). `AlchemyClient` использует chain-specific
  endpoints + JSON-RPC `alchemy_getTokenBalances`, возвращает raw hex
  balances → BigInt → decimal string (для 18-decimal positions).
- **Этап 3b (НЕ начат)**: wallets CRUD + wire-up в `PortfolioRefreshService`.
  Это полноценная следующая фаза — нужна schema для `wallets` /
  `wallet_addresses` в TS, endpoints `/accounts/:id/wallets[/:wid]`,
  замена stub в `PortfolioRefreshService.refreshAccount` на реальный
  pipeline (iterate wallets → DeBank+Alchemy → price resolution →
  cost basis → metrics).
- **Ключи не перенесены автоматически** (sandbox заблокировал
  exploration credential-файлов). Перенести в `apps/api/.env` —
  `ALCHEMY_API_KEY`, `DEBANK_API_KEY`, `ETHERSCAN_API_KEY` —
  значения из `apps/web/.env.local` (где они под VITE_*).

### SaaS Frontend — branch A: web UI поверх Phase 0–8 (2026-05-11)

Закрыта user-side часть + админский billing/flags. Backend инфраструктура
из Phase 0–8 теперь полностью обвешана UI.

- **Новые public страницы**: `/invite/:token` (preview + register +
  auto-login), `/reset-password` (request, всегда 204), `/reset-password/:token`
  (confirm + redirect к login).
- **Новые user страницы**: `/billing` (status badge, USDT TRC20/ERC20
  адреса с idempotent allocation, история платежей), `/preferences`
  (telegram link/unlink, матрица subscription × channel).
- **Новые admin страницы**: `/admin/billing` (split master/detail —
  список юзеров слева, panel справа с manual credit + refund), 
  `/admin/feature-flags` (groupBy key, inline toggle/delete, форма upsert).
- **API client**: добавлен `api.put<T,B>` (нужен для feature-flags
  upsert + notifications subscriptions).
- **Auth-каркас уже был**: AuthProvider с single-flight refresh,
  AdminShell + ProtectedRoute + ImpersonationBanner, React Query, i18n.
- **E2E 14/14** (HTML + API через vite proxy): все маршруты возвращают
  200, все endpoint-ы отдают валидный JSON, upsert flag/notification
  работают, billing status для Alice показывает active 365d, telegram
  start выдаёт code + (пустой пока) deepLink.

См. [[decisions/saas-frontend-A]].

### SaaS Phase 8 — crypto subscription billing (USDT TRC20/ERC20) (2026-05-11)

Финальный кусок бета → платная подписка.

- **Тарифы 3/6/12 мес** ($100/$180/$300, env-driven), mapping на
  существующий `payment_plan` enum (`quarterly/semiannual/yearly`).
- **Receive-адреса**: pool из env, allocation per (user, network) с
  unique индексом — повторный POST `/me/billing/payment-address`
  возвращает тот же адрес.
- **Auto-credit pipeline**: BullMQ recurring scan каждые 5 мин →
  `payment_transactions` upsert (idempotent на `(network, tx_hash)`)
  → credit когда confirmations ≥ threshold и amount ≥ plan price.
  `IBlockchainProvider` skeletons (Tronscan/Etherscan) включатся в
  Phase 8b — pipeline уже работает на mocked providers.
- **Stacking rollover**: оплата поверх активного периода продлевает с
  current `period_end`, юзер не теряет дни. E2E: $100+$300 → 450d left.
- **Grace 3 дня** после `period_end`. Дальше `expired` → POST refresh
  для не-admin = 403 (admin не блокируется).
- **Endpoints**:
  - `GET /api/v1/me/billing`, `POST /me/billing/payment-address`,
    `GET /me/billing/payments`
  - `GET/POST /api/v1/admin/users/:id/billing[/credit|/refund]`
- **audit_log**: `billing.address_allocated`, `billing.credited_manual`,
  `billing.credited_auto`, `billing.refunded`.
- **E2E 16/16**: status beta→active→expired, address allocation
  idempotency, manual credit + stacking, refund (-amount), 403 для under-min
  amount, 401/403 для не-владельцев, grace-block для refresh.

См. [[decisions/saas-phase8-billing]].

### SaaS Phase 7 — notifications: email + Telegram skeleton (2026-05-11)

Первый исходящий канал к пользователю.

- **Email через Resend + stdout-fallback** (`EmailClient.isLive`). Когда
  `RESEND_API_KEY` пуст — печатает `[email-stub] to=... subject="..."`,
  audit пишет `mode=stdout`. С ключом — реальная HTTP-отправка, `mode=resend`.
- **NotificationsService** единый façade: `send({user, type, subject,
  bodyText, transactional?})` + convenience `sendPasswordReset`,
  `sendInvite`. Гейт через `notification_subscriptions` (кроме transactional).
- **Telegram skeleton**: `telegram_links` (pending/linked/revoked),
  `POST /me/telegram/start` (one-time code + `t.me/<bot>?start=` deep-link),
  `GET /me/telegram`, `DELETE /me/telegram`. `TelegramService.completeLink`
  готов к вызову bot-listener'ом в Phase 7b.
- **Subscriptions**: `GET/PUT /me/notifications` для (type, channel)
  opt-in/opt-out. Default = true (важные алерты приходят сами).
- **Hooks**: password-reset теперь шлёт email через сервис (раньше был
  прямой stdout); invite-create отправляет приглашение получателю
  (admin-ответ всё равно содержит URL — email convenience, не hard-fail).
- **E2E 13/13**: email-stub печатается для invite + reset, telegram
  state machine (none→pending→none после unlink), subscriptions PUT/GET,
  401 без auth, audit-row `notification.email_sent mode=stdout`.

См. [[decisions/saas-phase7-notifications]].

### SaaS Phase 6 — feature flags, canary rollout (2026-05-11)

Каркас безопасных выкаток + версионирование методики.

- **Resolver precedence**: user override → account override → global → default(false)
- **Endpoints**:
  - `GET/PUT/DELETE /api/v1/admin/feature-flags[/:key|/:id]`
  - `GET /api/v1/me/feature-flags?keys=a,b,c` — bulk seed для фронта
- **Service helper** для веток в коде: `if (await flags.enabled('cost_basis_v2', {userId})) {...}`
- **Cache**: Redis ключи `flag:{key}:u={userId|-}:a={accountId|-}`, TTL 30s;
  wildcard SCAN+DEL invalidation на upsert/delete.
- **Canary workflow** (документирован): commit → `global=false` → user-overrides
  для бета-кохорты → flip `global=true` → drop overrides.
- **SQL bug fix**: `or()` вместо `sql.join('OR')` в `fetchForResolution`
  (предыдущий draft возвращал все ряды флага). E2E с unknown-keys regression поймала.
- **E2E 18/18**: precedence (user>global в обе стороны), cache hit/invalidation,
  validation, admin-only access.

См. [[decisions/saas-phase6-feature-flags]].

### SaaS Phase 5 — admin panel API surface + bull-board UI (2026-05-11)

«Единое окно» админа на стороне backend. Шесть admin-only модулей, все
под `requireAdmin`:

- **`admin/portfolios`** — таблица всех аккаунтов платформы (логин · TVL ·
  last refresh · errors24h · trigger) + `/aggregate` для KPI шапки.
  Реализовано через correlated subqueries — один SQL-roundtrip на запрос.
- **`admin/metrics/saas`** — users by status, DAU/WAU/MAU (через
  `sessions.last_used_at`), новые юзеры за 24h/7d/30d, invite-воронка
  (pending/consumed/revoked/expired), активация (within24h%,
  firstRefreshWithin7d%).
- **`admin/audit`** + `action-counts` — фильтр по actorId/targetUserId/
  action/asAdmin/accountId/sinceHours, гистограмма по action.
- **`admin/tech-audit`** — авто-детектор аномалий: users-without-accounts,
  account-never-refreshed (>24h), account-stale-snapshot (>7d),
  upstream-errors-spike (≥5 errs/24h), admin-not-verified,
  invite-near-expiry (<12h). Каждый checker — pure SQL функция,
  добавление нового тривиально.
- **`admin/queue/status`** — JSON counts (active/waiting/delayed/
  completed/failed) + список recurring schedulers с next-fire.
- **`admin/queue/ui/*`** — полноценный **bull-board v7** dashboard,
  смонтирован под admin-gate. Базовый path `/api/v1/admin/queue/ui`
  абсолютный, потому что bull-board запекает его в HTML.
- **`admin/users` расширен** — `PATCH /:id/status` (с revoke всех
  сессий при blocked/pending), `PATCH /:id/role`. List возвращает
  per-user `accountCount`, `lastSnapshotAt`, `lastSnapshotUsd`.

Packages: `@bull-board/api`, `@bull-board/fastify` (v7).

**E2E 10/10** через `apps/api/src/scripts/phase5-e2e.ts`: admin login →
каждый endpoint → проверка формы ответа. Bull-board UI: 401 без токена,
200 HTML с админским JWT.

См. [[decisions/saas-phase5-admin-panel]].

### SaaS Phase 5 — admin panel API (2026-05-11)

Закрыт видимый-админу backend: список юзеров с агрегатами, аналитика
портфелей, SaaS-метрики, audit log viewer, авто-детектор аномалий, queue
health. Frontend админ-панели подключится поверх — все endpoints готовы.

- `GET /admin/users` — фильтры (status/role/search) + per-user агрегаты
  (accountCount, lastSnapshotAt, lastSnapshotUsd).
- `PATCH /admin/users/:id/status` — suspend/unsuspend; не-active автоматически
  revoked все сессии.
- `PATCH /admin/users/:id/role` — admin/user/viewer.
- `POST /admin/users/:id/impersonate` + `DELETE /admin/users/:id/impersonate` —
  view-mode impersonation; `/me` теперь возвращает `impersonation: {…}` для
  банера «вы под Alice».
- `GET /admin/portfolios` — таблица аккаунтов: owner email, TVL,
  snapshots24h, errors24h, lastTrigger.
- `GET /admin/portfolios/aggregate` — платформенный TVL, snapshots/errors за 24h.
- `GET /admin/metrics/saas` — users by status, DAU/WAU/MAU, new users,
  invites by status, activation (within24h + first-refresh-7d).
- `GET /admin/audit` — paginated viewer с filters (actorId, targetUserId,
  action, asAdmin, accountId, sinceHours).
- `GET /admin/audit/action-counts?hours=N` — top events.
- `GET /admin/tech-audit` — auto-detector: 6 чекеров (users-without-accounts,
  account-never-refreshed, account-stale-snapshot, upstream-errors-spike,
  admin-not-verified, invite-near-expiry).
- `GET /admin/queue/status` — counts + schedulers для portfolio-refresh queue.
- **E2E**: 11/11 пройдено. Impersonation корректно прокидывает context в
  `/me`; suspend юзера revoked его сессии + блокирует login.

См. [[decisions/saas-phase5-admin-panel]].

### SaaS Phase 4 — BullMQ worker, scheduled portfolio refresh (2026-05-11)

Асинхронный контур закрыт: API только enqueue-ит, реальный refresh
происходит в отдельном worker процессе.

- **Архитектура**: 2 процесса (API + worker), общая Redis + Postgres.
- **BullMQ 5** queue `portfolio-refresh`:
  - **recurring**: scheduler id `account-<uuid>`, every 1h, deterministic
    jitter per account (stable hash от UUID — те же 25 аккаунтов не палят
    upstream в :00:00 одновременно).
  - **manual**: jobId `manual-<uuid>-<ts>`, 1-sec dedup.
- **Worker bootstrap**: при старте проходит по всем active accounts и делает
  `upsertJobScheduler` (идемпотентно). Worker concurrency = 5.
- **Refresh service** — пока stub: пишет deterministic snapshot с
  `metrics: {stub: true, trigger, totalUsd: 0, openPositions: 0}`. Реальный
  pipeline (Alchemy + DeBank + cost basis) подключится при миграции
  фронтенда — заменится **только тело метода**, остальное готово.
- **Endpoints**:
  - `POST /api/v1/accounts/:id/refresh` — manual trigger, 202 + jobId.
  - `GET /api/v1/accounts/:id/refresh-status` — latest snapshot + recent jobs.
- **Infra**: Redis `maxmemory-policy` поменян на `volatile-lru` (cache
  evict-абл, job-records защищены).
- **E2E 6/6**: bootstrap создал 4 cron snapshots, manual refresh
  обработался за 2 сек, tenant isolation работает поверх queue
  (Alice → admin's account = 403). audit_log: cron=4, manual=2.

См. [[decisions/saas-phase4-bullmq-worker]].

### SaaS Phase 3 — Redis cache, per-user quotas, provider abstraction (2026-05-11)

Каркас «один upstream-вызов = cache → quota → live + log» закрыт.

- **Redis** в `infra/docker-compose.dev.yml` (256MB, allkeys-lru, persist).
- **JsonCache** + **TokenBucket** (UTC-day counter с auto-EXPIRE).
- **Provider abstraction**: `IPriceProvider` / `IBalanceProvider` интерфейсы.
  Реальный `CoinGeckoClient` (free tier без ключа, pro если ключ задан) +
  скелеты `AlchemyClient`, `DeBankClient`, `EtherscanClient` (wire-up
  привязан к миграции фронтенда).
- **QuotedPriceProvider** оборачивает любого raw-провайдера: shared cache
  (TTL 5 мин по умолчанию), per-user daily quota, api_usage log на каждый
  cold call **и** на каждый cache hit.
- **Endpoints**:
  - `GET /api/v1/accounts/:id/prices/:symbol` — текущая цена через cache.
  - `GET /api/v1/admin/api-usage/summary?hours=N` — per-provider stats +
    top users.
  - `GET /api/v1/admin/api-usage/recent?limit=N` — последние вызовы.
  - `GET /api/v1/admin/api-usage/quotas?userId=…` — used/limit per provider.
- **E2E live CoinGecko**: 12/12. Admin прогрел `USDC` (517 ms cold), Alice
  получила тот же ответ из кэша (без сжигания своей квоты), tenant
  isolation работает поверх цен (Alice → admin's account = 403).
- **Миграция `0002_phase3_drop_legacy_reference.sql`** готова к применению:
  дропает пустые legacy `networks/custom_cg_ids/token_prices`. Не применена
  без явного подтверждения.

См. [[decisions/saas-phase3-cache-quotas]].

### SaaS Phase 2 — multi-tenant + reference data + impersonation (2026-05-11)

Реализация архитектуры трёх слоёв (см. [[decisions/saas-analytics-layers]])
и tenant isolation:

- **Global reference таблицы**: `chain_registry` (7 chains: ETH/OP/BSC/Polygon/
  Base/Arbitrum/Avalanche), `coingecko_registry` (36 токенов — стейблы, LST,
  DeFi blue chips, мемы), `historical_prices` (lazy cache на (symbol, date)).
- **Per-account overrides**: `cg_id_overrides` для экзотики.
- **Accounts CRUD**: `GET/POST/GET-:id/PATCH/DELETE /api/v1/accounts`. Лимит
  1 active account для user; admin без лимита. Primary account защищён от
  архивации юзером. Tenant isolation проверяется в `AccountsService.assertOwnerOrAdmin`.
- **Admin user management**: `GET /api/v1/admin/users` (список),
  `POST /admin/users/:id/impersonate` (выдаёт JWT от лица target user в
  view-mode), `DELETE /admin/users/:id/impersonate` (revoke). Impersonation
  TTL 60 мин (короче обычного refresh).
- **Audit log расширен**: `as_admin`, `target_user_id`, `ip`, `user_agent`.
  Все admin-действия (включая impersonation) пишутся с `as_admin=true`.
- **E2E**: 20/20 кейсов пройдено: изоляция (Alice ↛ Bob), лимиты (1/per-user),
  impersonation + revoke, audit-метки.

См. [[decisions/saas-phase2-multi-tenant]].

### SaaS Phase 1 — invites, onboarding, password reset (2026-05-10)

Закрыт пробел «как новые юзеры попадают в систему».

- **Invite-флоу**:
  - `POST /api/v1/admin/invites` (admin) — создать invite на email,
    возвращает raw token + готовый URL ровно один раз (в БД только SHA-256).
  - `GET /api/v1/invites/:token` (public) — preview: email + expires.
  - `POST /api/v1/invites/:token/register` (public) — регистрация:
    password + name, email берётся из инвайта (жёсткая привязка), создаёт
    user + primary account "Main" + auto-login (JWT + cookie).
  - `DELETE /api/v1/admin/invites/:id` (admin) — отозвать pending.
  - `GET /api/v1/admin/invites?status=…` (admin) — список с lazy-маркой
    expired.
- **Password reset**:
  - `POST /auth/password/reset-request` — всегда 204 (no enumeration).
    Email-провайдера пока нет → URL печатается в stdout сервера.
  - `POST /auth/password/reset-confirm` — меняет пароль и **revoked все
    активные сессии** юзера.
- **Audit log** пишет 6 новых событий (`invite.created/consumed/revoked`,
  `user.registered`, `password.reset_requested/_confirmed`).
- **Rate limits**: register 5/15min, preview 20/min, reset 5+10/15min.
- **E2E**: 17/17 кейсов пройдено через curl, включая повторное использование,
  revoke, expired, попытку user'а сходить в админский endpoint (403).

См. [[decisions/saas-phase1-invites]].

### SaaS Phase 0 — auth, multi-tenancy foundation (2026-05-10)

Capflow выходит из single-user режима в SaaS. Phase 0 — фундамент:
- **Аутентификация**: email + password (argon2id), JWT access (15 min) +
  refresh token в httpOnly cookie c sliding rotation, audit log на login/logout.
- **Роли**: admin / user / viewer через существующий `user_role` enum.
- **Middleware**: `requireAuth` блокирует все приватные роуты до валидной
  сессии в БД, `requireAdmin` для админских.
- **Multi-tenancy**: `accounts.owner_id` (N:1 → users), новые поля
  `is_primary`, `settings`, `archived_at`. Изоляция per-account будет в Phase 2.
- **Интеграция со существующей БД**: подхватили inherited schema (27 таблиц)
  через `pg_dump`-инспект, добавили auth-расширения через ручную SQL миграцию
  `0000_phase0_auth.sql`, написали Drizzle-схему для нужных Phase 0 таблиц.
- **Новое в БД**: таблицы `invites` (email-bound одноразовые токены) и
  `api_usage` (учёт запросов к Alchemy/DeBank/Etherscan).
- **Endpoints**: `POST /api/v1/auth/{login,refresh,logout}`, `GET /auth/me`.
  Rate-limit на login 5/15min.
- **Seed**: `apps/api/src/scripts/seed-admin.ts` — идемпотентно создаёт админа
  и его primary account.
- **E2E**: 10/10 curl-кейсов прошли (login/refresh/logout/401-сценарии).

См. [[decisions/saas-phase0-auth]].

## ✅ Сделано — pre-SaaS

### Этап 1 — IL колонка убрана
Убрана колонка «IL (V3)» из листа открытых позиций.

### Этап 2 — V3 popup (статика)
Иконка ℹ️ рядом с бейджем «LP» для V3-позиций. В попапе:
- Текущая пропорция активов
- HODL vs LP, IL $ и %
- Депозит (что вносил)

### Этап 3 — V3 RPC интеграция
- Поле `alchemyApiKey` в Settings → Интеграции
- Чтение Uniswap V3 NFT позиций через viem multicall
- Поддержка Uniswap V3, PancakeSwap V3, SushiSwap V3
- Сети: ETH, Arbitrum, Optimism, Polygon, Base, BNB, Avalanche
- Pa, Pb, currentPrice из контрактов пула

См. `apps/web/src/lib/v3/`.

### Этап 4 — V3 exit-математика
В попапе для V3:
- ↑ Выход вверх (Pb): сколько base продаст, средняя цена, PnL vs депозит, vs HODL
- ↓ Выход вниз (Pa): сколько base докупит, средняя цена, PnL vs депозит, vs HODL
- Безубыток `P_break = depositUsd / amount0AtPa`
- Багфикс: канонизация WETH↔ETH для матча депозита и pool-токена

### Этап 5 — Cost basis от LP закрытия
- В `cost_basis_tracker.ts` двухпроходный алгоритм атрибуции `lp_add → lp_remove`
- При закрытии LP-позиции токены приходят с cost basis от исходного депозита, а не по spot
- Бейдж в Реестре операций «cost basis +$X» под `lp_remove`-операциями
- См. [[decisions/lp-cost-basis]]

### Этап 6 — отменён
Раскрытие истории lending-позиций удалено, оставлено переименование HR → HF.
HF красится по уровню (зелёный ≥1.5 / оранжевый 1.15-1.5 / красный <1.15 с пульсацией).

### Этап 7 (частично) — формат данных таблицы
- Дата в формате `DD.MM.YYYY`, заголовок «Дата открытия»
- Шапка: 6 карточек (Открытых позиций, Инвестировано, Итого активы, Fee lifetime, Total PnL, Total APR)
- Капитал: 3 карточки (Свой капитал, Кредитный капитал, Fee APR lifetime)
- 17 колонок: + PnL позиций, Fee, Итого активы, Total PnL, Total APR, Вес%

### Этап 8 — fee lifetime + ручная метка credit
- В `OpenPosition` добавлены `feesClaimedUsd`, `feesLifetimeUsd`, `feeAprLifetime`
- Сумма всех `claim_rewards` ops по hist-ценам
- Ручная отметка позиций как кредитных через checkbox в строке таблицы
- Хранится в `localStorage` ключ `capflow.credit_overrides`
- См. [[decisions/credit-attribution]]

### Этап 9 (фаза 1) — CoinStats интеграция, фундамент
- Поле `coinstatsApiKey` в `Integrations` + карточка в Settings
- Vite прокси `/coinstats/*` → `https://openapiv1.coinstats.app/*`
- Модуль `apps/web/src/lib/coinstats.ts` с базовыми функциями:
  `fetchWalletBalance`, `fetchWalletDefi`, `fetchWalletTransactions`,
  `syncWallet`, `fetchSupportedBlockchains`
- Поддерживается 147 сетей (TON, Bitcoin, Aptos, Sui, Cosmos-экосистема,
  Cardano, новые EVM L2 как Berachain/Monad/HyperEVM/Sonic)
- Тест из браузера успешен: ключ работает, прокси отдаёт 2 спот-токена
  на тестовом Solana-кошельке

### Этап 9 (фаза 2) — UI и загрузка для CoinStats-кошельков
- `WalletChain` расширен значением `"coinstats"`, в `SavedWallet` опциональный `connectionId`
- В `lib/coinstats_chains.ts` курируемый каталог из 76 сетей в 4 группах
- В форме «Добавить кошелёк» (RegistryPage) grouped `<select>` с
  optgroup'ами: DeBank · Helius · CoinStats Bitcoin&UTXO · L1 non-EVM ·
  Cosmos · Новые EVM L2
- В `LoadedWalletsProvider` добавлена ветка для `chain === "coinstats"`:
  ops пропускаются (Уровень 0), live-state через `/wallet/balance` +
  `/wallet/defi`, адаптируется в `LiveSnapshot`
- Адаптер `adaptCoinStatsLive` в `live_adapters.ts`

### Этап 10a — Jupiter Portfolio как live-источник Solana DeFi
- Поле `jupiterApiKey` в `Integrations` + карточка в Settings → Интеграции
- Vite-прокси `/jup-portfolio` → `https://api.jup.ag/portfolio` (header `x-api-key`)
- `fetchJupiterPortfolio()` + типы `JupiterPortfolio*` в `lib/jupiter.ts`
- Адаптер `adaptJupiterPortfolioLive` в `live_adapters.ts`
- В Solana-ветке `LoadedWalletsProvider`: Jupiter Portfolio первым; если
  вернул позиции — Vybe не запускается
- **Ограничение бета-API:** покрывает только Jupiter-родные платформы (JLP,
  perp, DCA, limit orders, JUP staking). Внешние протоколы (Flash Trade,
  Drift, Kamino) не подключены — для них inferred-позиции из истории.

### Этап 10b — Inferred-позиции из истории ops
- В `open_positions.ts` функция `buildInferredPositions()`: для каждого
  `(wallet, chain, protocolId)` суммирует `Σ usdOut(open) − Σ usdIn(close)` по
  `lp_add/lend_supply/stake/perp_open` и парным закрытиям. Если нетто > $1
  и нет live-позиции с тем же ключом — создаёт `OpenPosition` с
  `inferred: true`. Подхватывает claim_rewards в `feesClaimedUsd`.
- В UI: бейдж «из истории» рядом с названием протокола в строке таблицы.
- Закрывает видимость Flash Trade и любых других Solana-протоколов без
  live-источника.

### Этап 10c — Manual overrides для currentValueUsd и feesUsd
- Хранилище `lib/portfolio/position_overrides.ts`: localStorage
  `capflow.position_overrides` → `Record<positionKey, {currentValueUsd?, feesUsd?}>`.
  Ключ позиции тот же что в `credit_overrides` для консистентности.
- В `OpenPositionsPage` каскадный пересчёт: при override `currentValueUsd`
  → `currentUsd`, `priceOnlyPnl`, `Total PnL`, `Total APR` пересчитываются.
  При override `feesUsd` → `feesLifetimeUsd`, `feeApr`, `feeAprLifetime`
  пересчитываются.
- UI: кликабельная ячейка "Текущая$" → window.prompt; рядом с "Fee" иконка
  ✎ (становится ●, если override активен). Пустая строка снимает override.
- Удалена мёртвая ветка SonarWatch (sonar.watch DNS NXDOMAIN, корень
  редиректит на jup.ag/portfolio после поглощения Jupiter'ом).

### Этап 10e — Chain-group + per-wallet chips, auto-detection badge
- Общий [Chip](apps/web/src/components/ui/Chip.tsx) — извлечён из
  OpenPositionsPage в `components/ui/`. Поддерживает оттенок маркера для
  EVM (cyan), Solana (#14F195), CoinStats (purple).
- Helper [chain_groups.ts](apps/web/src/lib/chain_groups.ts):
  `chainGroupOfWallet(w) → "evm" | "sol" | "coinstats"`. Группирует все
  будущие чейны (Sui/TON/Aptos/Cosmos/новые EVM L2) под зонтиком
  CoinStats.
- В [RegistryPage](apps/web/src/pages/RegistryPage.tsx) и
  [OpenPositionsPage](apps/web/src/pages/OpenPositionsPage.tsx) ряд чипов
  «ИСТОЧНИК: Все · EVM · Solana · CoinStats» появляется когда у
  пользователя >1 chain-группы. Per-wallet чипы автоматически фильтруются
  по выбранной группе.
- В `ClassifiedOp` добавлено поле `detection?: "explicit" | "auto"`.
  Solana-classifier ставит `"auto"` когда swap классифицирован generic
  net-balance fallback'ом (то есть протокол не зарегистрирован в реестре
  и Helius не дал явный type=SWAP).
- В Registry рядом с именем протокола рендерится бейдж 🟡 **AUTO** для
  таких операций — пользователь видит «эту swap я определил эвристикой,
  стоит верифицировать».

### Этап 14 — V3 LP cost basis через Etherscan + pool slot0 (authoritative on-chain)
- Решает рецидивирующий баг startUsd для V3 NFT с множественными
  IncreaseLiquidity events. POS-001 XAUt: DeBank вернул только 1 mint
  $56.30, на цепочке 3 increases = $159.04 (3× больше). POS-009/POS-010:
  одинаковый openHash для двух разных NFT в одном пуле.
- Добавлен Etherscan v2 unified API клиент (`apps/web/src/lib/etherscan_logs.ts`).
  Free tier: 5 req/sec, нет block-range limit (vs Alchemy 10 blocks).
  Multi-chain через chainId param.
- React hook `useV3LiquidityEvents` фетчит `IncreaseLiquidity` +
  `DecreaseLiquidity` events для каждого live V3 NFT с module-cache +
  localStorage persist + in-flight Promise dedup.
- **Цены через pool slot0** (а не DefiLlama hist): для каждого event'а
  читаем `pool.slot0().sqrtPriceX96` на `blockNumber - 1` через Alchemy
  archive — это та же цена что контракт использовал при mint'е. Для
  volatile/volatile pool'ов используем USD-anchor (WETH/USDC slot0 на
  том же блоке) для derive USD-цены. EUR-stables работают автоматически
  (EURC/USDC ratio в пуле = EUR/USD rate).
- `applyV3CostBasisOverride` — 3-фазный matching algorithm:
  - Phase 1: openHash → mintTxHash (skip при дубликатах в группе)
  - Phase 1.5: greedy match by current token amounts (основной механизм)
  - Phase 2: pro-rata fallback
- `OpenPosition.matchedV3TokenId` поле для per-NFT UI rendering
  (показывает `#{tokenId}` каждой позиции вместо "N NFTs")
- Подтверждение: POS-010 PAXG/USDC формула пользователя `0.10148 ×
  $5,128 + 660.48 × $1 = $1,180.85` ↔ slot0 $1,180.82 (Δ $0.03 от
  float-precision sqrtPriceX96)
- См. [decisions/v3-etherscan-cost-basis](decisions/v3-etherscan-cost-basis.md)

### Этап 13 — Receipt-token cost basis fix (distinct-receipts heuristic)
- Решает рецидивирующий баг GMX V2 / GLV / Fluid Vault startUsd
- Проблема: DeBank API возвращает `m.usd` для входящих receipt-токенов
  как `current_spot × amount`, а не цену в момент минта. DefiLlama для
  derivative tokens (GM, GLV, BPT, fVLT) цены не имеет.
- Также `supplyTokens` decomposition от DeBank даёт synthetic per-asset
  breakdown по live-redemption ratio, что для cost basis ошибочно
- Решение: distinct-receipts heuristic в `open_positions.ts:1497-1517`:
  - 1 receipt → use `positionLevelDeposit` (out-side USD only)
  - ≥2 receipts → use `MAX(positionLevelDeposit, supplySumStartUsd)`
- 6 позиций тестового кошелька `0x3df3ce…` показывают корректный startUsd
  с погрешностью ≤ $1 (gas)
- См. [decisions/receipt-token-cost-basis](decisions/receipt-token-cost-basis.md)

### Этап 10d — Solana swap classifier: net-balance fallback + DFlow
- Корень проблемы swap'а 2026-03-05 на DFlow: tx классифицирована как
  `unknown` вместо `swap` (соответственно cost basis SOL не считал эту
  покупку). `buildMovements` корректно собирал все 5 движений (-0.001 SOL,
  -0.002 SOL, +0.068 SOL, -6 USDC, +0.066 SOL); классификатор не имел
  правила для DEX-категории + протокол DFLOW не зарегистрирован.
- В [spl_tokens.ts](apps/web/src/lib/portfolio/spl_tokens.ts): добавлен
  `DFLOW: { name: "DFlow", category: "dex" }`.
- В [solana_classifier.ts](apps/web/src/lib/portfolio/solana_classifier.ts)
  расширен «пустой swap fallback»: вместо строгого 1+1 теперь считаем
  нетто per-mint и матчим если есть хотя бы один mint с net > 0 и
  один с net < 0. Это покрывает мульти-leg маршруты (Jupiter/DFlow с
  дробными SOL-fee + основным выходом).
- Verification: после очистки кэша Solana и reload — `unknown` ops
  упало с 2 до 0, swap'ов добавилось 2 (DFlow USDC→SOL и
  ASSOCIATED_TOKEN_PROGRAM USDT→USDC).

## 🔜 В очереди

### Этап 12 — Cost basis architecture ✅ ЗАВЕРШЁН 2026-05-09

**Статус: Фазы 1-7 завершены за один продлённый сеанс.**

5-уровневый фреймворк для корректного учёта cost basis через цепочку
«купил → положил → довложил → частично снял → продал → купил снова»
с переходом токена между протоколами (GMX → Morpho → CEX, и т.д.).

#### ✅ Фаза 1 (2026-05-09): Contextual classifyTokenRole + whitelist

- `apps/web/src/lib/portfolio/token_roles.ts` дополнен:
  - `RECEIPT_CONTRACTS` — whitelist contract-адресов receipt-токенов
    per protocol (GMX V2 GM markets, GLV vaults, Aave aTokens)
  - `RECEIPT_LESS_PROTOCOLS` — explicit whitelist (Morpho Blue, Drift,
    Adrena), для которых нет receipt'а в кошельке
  - `isReceiptOfProtocol(symbol, protocolId, tokenId?)` теперь проверяет
    contract whitelist первым приоритетом, затем symbol patterns
  - `isReceiptLessProtocol(protocolId)` — для receipt-less детекта
- `cost_basis_tracker.ts` для `lp_add` использует `isReceiptOfProtocol`
  вместо глобального `m.isProtocolToken` — корректно учитывает
  cross-protocol receipts (GLV в Morpho = collateral, не receipt)

#### ✅ Фаза 2 (2026-05-09): Receipt-less protocol cost basis

- `currentCostBasisForPosition` теперь поддерживает receipt-less mode:
  - Детект через `isReceiptLessProtocol(protocolId)` (explicit whitelist)
  - Для Morpho Blue: суммирует `depositUsdFromOp(op)` для `lend_supply`
    и `lp_add` ops (НЕ для `repay`/`borrow`)
  - `depositUsdFromOp` использует контекстную проверку `isReceiptOfProtocol`
    вместо глобальной — GLV-supply в Morpho корректно учитывается как
    out-side underlying, а не как receipt
- **Результат: POS-006 (Morpho Blue с GLV collateral) показывает
  startUsd $17,611 при реальной cost basis $17,608 (отклонение ±$3)**.
  Раньше показывало $17,993 (decomposition WETH+USDC через avgAtOpen).

См. [decisions/cost-basis-architecture](decisions/cost-basis-architecture.md)
и [decisions/receipt-token-cost-basis](decisions/receipt-token-cost-basis.md).

#### ✅ Фаза 3 (2026-05-09): LotTracker модуль

- `apps/web/src/lib/portfolio/lots/` — новый модуль
- Class `LotTracker` с методами `acquire()`, `consume()`, `wacAt()`,
  `currentWac()`, `getLots()`, `currentAmount()`
- Поддержка методик WAC (default), FIFO, LIFO
- Per-wallet isolation: лоты разделены по `walletId`
- `buildLotTrackerFromOps()` — pure-функция для построения трекера
  из ops с handlers для каждого типа операции (swap, lp_add, lend_supply,
  borrow, repay, claim_rewards, transfer_in, transfer_out, bridge)
- Backward-compat wrapper `CostBasisTrackerCompat` — старый API
  поддерживается через адаптер

#### ✅ Фаза 4 (2026-05-09): PositionTracker с event log

- `apps/web/src/lib/portfolio/positions/` — новый модуль
- Class `PositionTracker` хранит Positions per `(walletId, protocolId, marketKey)`
- `PositionEvent` typed: deposit_collateral, withdraw_collateral,
  borrow, repay, claim_rewards, interest_accrual, liquidation,
  split, merge, open, close
- `inferMarketKey()` — синтетический ключ для receipt-less протоколов

#### ✅ Фаза 5 (2026-05-09): Cross-protocol lot transfer

- `buildLotsAndPositions()` — единственный chronological pass который
  заполняет ОБА трекера согласованно
- При `deposit_collateral` lot цены consume'ятся → cost basis "переезжает"
  в Position event как `attributedCost`
- При `withdraw_collateral` recovered cost из receipt-lot возвращается
  в lots underlying токенов (LP close attribution)
- Это решает GLV→Morpho cross-protocol: WAC GLV из GMX V2 правильно
  переезжает в Morpho-позицию

#### ✅ Фаза 6 (2026-05-09): Edge cases

- `lots/edge_cases.ts`:
  - `applyTokenMigration()` — для known migrations (LEND→AAVE и т.д.)
  - `applyRebaseYield()` — для stETH/wstETH/aTokens где balance растёт
    не через transfer а через index update
  - `REBASE_TOKENS` whitelist
- Snapshot-diff подход: вычисляем разницу между live amount и tracker
  amount → добавляем synthetic claim_rewards lot

#### ✅ Фаза 7 (2026-05-09): Self-check verification

- `lots/self_check.ts` — runtime test scenarios без тест-фреймворка
- 7 канонических сценариев проверены автоматически:
  - basic WAC (1 ETH @ $2000 + 2 ETH @ $3000 → $2666.67)
  - consume FIFO 1.5 ETH ($3500)
  - cross-protocol GLV (4 deposits → 1000 GLV → $1500 cost)
  - partial consume + add (WAC drift)
  - borrow zero cost
  - empty wallet insufficient
  - multi-wallet isolation
- Доступно через `window.capflowSelfCheck()` в browser console
- **Все 7/7 passed** — модули работают корректно

#### 🔜 Что осталось для **полной** интеграции

Текущее состояние: новые модули **построены и протестированы**, но
старый код (`open_positions.ts`, `cost_basis_tracker.ts`) ещё не
переписан на их использование. Это сделано намеренно для
non-breaking интеграции:

- **Шаг A** (lower priority): миграция `currentCostBasisForPosition`
  на использование `PositionTracker` напрямую вместо ad-hoc-логики
- **Шаг B**: миграция `cost_basis_tracker.ts` на `LotTracker` через
  compat-wrapper (или прямая замена)
- **Шаг C**: использование `Position.events` для UI timeline
  (вместо текущего `position_timeline.ts`)

Эти миграции могут идти инкрементально, не ломая существующее.
Каждая позиция или модуль может быть переключен независимо.

**Уровни:**
1. **Lot Tracker** — per-token-symbol, per-wallet, с методиками WAC/FIFO/LIFO
2. **Position Tracker** — event log на позицию, running WAC по receipt-токену
3. **Cross-protocol Token Trace** — `classifyTokenRole` контекстно (а не глобально),
   замена `isProtocolToken` whitelist'ом контрактов
4. **Atomic Multi-Tx Linking** — расширение текущего async-deposit linker
   на withdraw pairs / Morpho-bundler / Pendle splits / Euler zaps
5. **Receipt-less protocols** — Morpho Blue, Drift Spot, и т.д.

**Поэтапная реализация (7 фаз)**, ~3-4 недели плотной работы:

| Фаза | Что | Дни |
|---|---|---|
| 1 | Contextual `classifyTokenRole` + whitelist | 1 |
| 2 | `findFirstOpen` для receipt-less | 1-2 |
| 3 | Новый `LotTracker` модуль | 3-5 |
| 4 | `PositionTracker` с event log | 5-7 |
| 5 | Cross-protocol lot transfer | 5-7 |
| 6 | Edge cases (airdrops/rebases/migrations/depegs) | 3-5 |
| 7 | Тесты + полевая отладка | 5-7 |

**Решает накопившиеся баги**:
- POS-006 Morpho теряет дату 22.11.2025 (collateral GLV не trace'ится)
- GMX V2 sub-positions путаются между маркетами при partial withdraw
- `isProtocolToken` глобальный → ломает Morpho classify
- Multi-deposit/partial-withdraw циклы дают неверный startUsd

См. [decisions/cost-basis-architecture](decisions/cost-basis-architecture.md).

### Этап 9 (фаза 2-4) — CoinStats wiring
- В форме «Добавить кошелёк» chain selector с группами
  (EVM via DeBank / Solana / **CoinStats chains**)
- При выборе CoinStats-сети в `SavedWallet` хранится `connectionId`
- В `LoadedWalletsProvider` маршрут на CoinStats для не-DeBank/не-Helius сетей
- Адаптер CoinStats response → `LiveSnapshot` (для UI унификации)
- CoinStats как fallback для EVM при недоступности DeBank


### Liquidation price для lending-позиций
- Aave V3: `Pool.getUserAccountData()` → агрегированный HF + LT
- Fluid: VaultResolver через RPC, получить `liq_factor` и oracle price
- Morpho Blue: `Position` + `MarketParams` per market
- Kamino (Solana): отдельный стек

См. [[protocols/aave]], [[protocols/fluid]], [[protocols/morpho]].

### Поддержка других V3-style
- Algebra-based (QuickSwap V3, Camelot V3, Thena Fusion) — близкий ABI, но `slot0 → globalState`
- Maverick / Trader Joe LB — другая модель (bins вместо ticks)
- Solana CLMM (Orca Whirlpools, Raydium CLMM) — отдельный модуль через Helius

### Аналитика по closed позициям
- Лента закрытых позиций с realized PnL
- Аггрегация: общий ROI, win rate, средний срок удержания
- Таймлайн событий по позиции (open → claims → close)

### Этап 11 — Ручная разметка ops + Стартовый капитал + Bridge detection
- [decisions/bridge-detection](decisions/bridge-detection.md) — авто-классификация
  межкошельковых переводов как `bridge_out`/`bridge_in` по условиям пары
- `manual_annotations.ts` — единое хранилище ручной разметки (FiatPurchase + Credit),
  миграция со старого `fiat_purchases.ts`
- `ManualAnnotationCell` в реестре операций — выбор типа разметки через popup
- Поддержка произвольного фиата («другой фиат» — TRY/VND/BYN/любой ISO)
- `BulkFiatMarker` — multi-select токенов + общая сумма + фильтры (стейблы/извне/спам)
- `tokenFamily()` нормализация — USDT ↔ USD₮0, ETH ↔ WETH в поиске и pair-detection
- `StartCapitalCard` на дашборде — суммы по фиат-валютам + средневзвешенный курс
- Auto-refresh кошельков раз в час

### Вспомогательное
- Liq price tooltip в строке lending-позиции
- Per-asset LTV/LT в попапе HF
- Money-trace alternative — посмотреть в будущем при появлении больших объёмов swap-цепочек
