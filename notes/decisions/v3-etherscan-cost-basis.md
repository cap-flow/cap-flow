---
date: 2026-05-10
stage: 12
---

# V3 LP cost basis через Etherscan v2 unified API

## Контекст

DeBank `/history_list` для V3 LP NFT часто возвращает только первый
mint event и пропускает дополнительные `IncreaseLiquidity` calls. Это
систематически занижает `startUsd`:

- **POS-001 (Alexander 1, Uniswap V3 XAUt/USDT, NFT #1159369)**:
  DeBank вернул 1 mint $56.30, на цепочке 3 IncreaseLiquidity events
  totaling $159.01 (3× больше).
- **POS-009/POS-010 (Alexander 1, Uniswap V3 PAXG/USDC, 2 NFT в одном пуле)**:
  DeBank вернул один и тот же mint hash для обеих позиций, теряя
  per-NFT precision полностью.

Альтернативы для on-chain log queries:
1. **Alchemy `eth_getLogs`** — free tier ограничен 10-block range
   на запрос, что делает full-history queries нереалистичными
   (V3 NPM = 3+ years of blocks).
2. **Etherscan v2 unified API** — multi-chain (chainId param), free
   tier 5 req/sec, **НЕТ block-range limit** (1000 results per call).
3. **Subgraph (TheGraph)** — нужен Studio key, ratelimit, не все
   forks покрыты.

## Решение

Используем **Etherscan v2 unified API** как primary source для V3
NFT `IncreaseLiquidity`/`DecreaseLiquidity` events. Alchemy остаётся
fallback (если у пользователя нет Etherscan key).

### Архитектура

```
useV3LiquidityEvents (React hook)
  ├─ moduleCache: Map<chain|tokenId, V3CostBasisResult>  ← persisted to localStorage
  ├─ inFlight: Map<cacheKey, Promise>                     ← StrictMode guard
  └─ для каждого V3Position (live NFT):
      ├─ если useEtherscan: fetchEtherscanLogs(chain, npm, INCREASE_LIQ_TOPIC, tokenIdTopic, key)
      │                     await sleep(250)  ← 4 req/sec ≤ 5 limit
      │                     fetchEtherscanLogs(chain, npm, DECREASE_LIQ_TOPIC, ...)
      │                     await sleep(250)
      └─ иначе fetchV3LiquidityEvents (Alchemy chunked) — fallback

→ для каждого event'а: amount0 × hist_price0(blockTime) + amount1 × hist_price1
→ V3CostBasisResult { netCostBasisUsd, mintTxHash (= earliest event), ... }
```

### Override стратегия (3 фазы)

`applyV3CostBasisOverride(positions, v3PositionMap, v3CostBasis)`:

**Phase 1 — exact hash match**: для каждой OpenPosition сравниваем
`openHash` с `mintTxHash` каждого V3CostBasisResult. Если совпадает →
authoritative `netCostBasisUsd` идёт в `startUsd`. **Skip фазу для
OpenPositions с дублирующимся `openHash` в группе** (DeBank quirk:
multicall в одной транзакции возвращает один hash для нескольких
NFT mints).

**Phase 1.5 — amount-proximity match**: greedy assignment по
distance = `Σ |OpenPosition.supplyTokens.amount - V3Position.amountNCurrent|`
(relative L1, нормализовано на max). Threshold dist ≤ 1.0 (50% relative
diff per token). Это основной механизм когда Phase 1 не даёт уникальный
match.

**Phase 2 — pro-rata fallback**: оставшиеся unmatched позиции получают
cost basis распределённый pro-rata по `currentUsd`. Используется только
для NFT'ов, не привязанных в Phase 1/1.5.

### Per-NFT UI rendering

`OpenPosition.matchedV3TokenId` (новое optional поле) — конкретный
NFT id, к которому привязана позиция. UI в `OpenPositionsPage.tokenId`
column показывает `#{matchedV3TokenId}` если задан, иначе fallback на
"N NFTs" (group display).

### Цены при расчёте cost basis — pool slot0 (PRIMARY)

`useV3LiquidityEvents` для каждого IncreaseLiquidity/DecreaseLiquidity
event читает `pool.slot0()` через Alchemy archive на `(blockNumber - 1)`:

```
sqrtPriceX96 → price1Per0 = (sqrtP / 2^96)^2 × 10^(dec0 - dec1)
```

Конвертация slot0 ratio → (USD price0, USD price1) через:

1. **stable side detection** (USDC/USDT/DAI/...): прямая привязка $1
   - `token1=stable` → price0 = price1Per0, price1 = $1
   - `token0=stable` → price0 = $1, price1 = 1/price1Per0
2. **volatile/volatile**: используем USD-anchor pool на той же сети и
   том же блоке (`USD_ANCHOR_POOLS` в `historical_pool_price.ts`):
   WETH/USDC pool slot0 даёт точную WETH-USD цену → derive token0/1.

**Почему slot0, а не DefiLlama**: pool slot0 даёт ИМЕННО ту цену что
контракт использовал для расчёта `amount0/amount1` из `liquidity` +
range. DefiLlama hourly buckets дают drift ~0.1-0.5% (агрегат через
многие DEX/CEX). Для $1k+ позиций это $5-15 ошибка.

EUR-stables (EURC/EURE/EURS) автоматически работают через slot0
(EURC/USDC ratio в пуле = EUR/USD rate). Special-case в `STABLES`
не нужен.

DefiLlama сохранён в коде как fallback если на chain'е нет анкор-пула
И обе стороны volatile.

## Защита от rate limit

Etherscan free tier = 5 req/sec. React 18 StrictMode + re-renders могут
запустить effect 2-3× → без guard'а 8+ запросов в секунду:

1. **Sequential pipeline**: `await sleep(250)` между fetch'ами в одном
   effect run → ≤ 4 req/sec.
2. **Module-level cache**: `moduleCache: Map<cacheKey, V3CostBasisResult>` —
   первый run заполняет, последующие читают.
3. **localStorage persist**: `capflow.cache.v3liq.v1` — events исторические,
   кэшируем навсегда. Restore с stringify bigint at load.
4. **In-flight Promise dedup**: `inFlight: Map<cacheKey, Promise>` — если
   другой instance hook'а уже фетчит этот tokenId, awaitим его promise
   вместо дублирования запроса.

## Etherscan v2 quirks (важные)

`fetchEtherscanLogs` в `apps/web/src/lib/etherscan_logs.ts`:

1. **Strict param order**: `chainid → module → action → address →
   topic0 → topic0_1_opr → topic1 → fromBlock → toBlock → apikey`.
   Иначе API игнорирует topic1 фильтр и возвращает либо все события
   контракта, либо пустой результат.

2. **Empty result имеет 2 формы** (обе должны return `[]`, не throw):
   - `{ status:"0", message:"No records found", result: "No records found" }`
   - `{ status:"0", message:"No records found", result: [] }`
   Раньше второй вариант кидал ложную ошибку → hook ловил её как fail
   → не кешировал → повторные запросы → rate limit → каскад "No records
   found" по всем NFT.

3. **Rate limit error message**: `{ status:"0", message:"NOTOK",
   result: "Max rate limit reached, please use API Key for higher
   rate limit" }` — отличается от "No records found", корректно
   throws.

## Связанные файлы

- `apps/web/src/lib/etherscan_logs.ts` — Etherscan v2 client
- `apps/web/src/lib/v3/use_liquidity_events.ts` — React hook + cache
- `apps/web/src/lib/v3/liquidity_events.ts` — Alchemy fallback
- `apps/web/src/lib/portfolio/v3_cost_basis_override.ts` — 3-фазный
  matching algorithm
- `apps/web/src/pages/OpenPositionsPage.tsx` — UI rendering с
  `matchedV3TokenId` per-NFT
- `apps/web/src/lib/portfolio/protocols.ts` — STABLES set (без
  EUR-stables)
- `apps/web/.env.local` — `VITE_ETHERSCAN_API_KEY`

## Проверка работоспособности

1. **Должно работать**: 4 V3 NFT (POS-001, POS-007, POS-009, POS-010)
   показывают индивидуальный `#{tokenId}` в столбце TokenId, startUsd
   совпадает с Etherscan netCostBasisUsd ± 0.5% spread.
2. **Console expectations**: `[V3 override per-NFT amount-match]` или
   `[V3 override per-NFT]` warnings для каждой переопределённой позиции.
3. **localStorage**: `capflow.cache.v3liq.v1` содержит entries для
   всех V3 NFT с `mintTxHash` и `netCostBasisUsd`.
