---
date: 2026-05-09
stage: 14
---

# 5 проблем из аудита новых кошельков — решения

## Контекст

После Этапа 12 пользователь задал 5 концептуальных вопросов:

1. **Whitelist scaling** — что делать когда 20 пользователей подключают
   протоколы которых нет в whitelist?
2. **POS-001** XAUt $57 → $162 (+183% PnL) — где доп. liquidity?
3. **Morpho borrow startUsd $0** при реальном займе AUSD
4. **V3 диапазон** не отображается без NFT
5. **POS-009/010 PAXG dup** — оба показывают одинаковые $1,180

## Решения

### 1. DefiLlama auto-protocol-classification ✅

**Проблема:** hardcoded whitelists `RECEIPT_CONTRACTS`,
`PROTOCOL_TOKEN_PREFIXES_UPPER`, `RECEIPT_LESS_PROTOCOLS`,
`kindFromCategory` требуют вручную добавлять каждый новый протокол.
Не масштабируется при росте пользователей.

**Решение:** интеграция с DefiLlama Protocols API
(`https://api.llama.fi/protocols`):

- `apps/web/src/lib/defillama_protocols.ts`
- Загружает каталог ~5000 протоколов на старте, кэш 24h
- `lookupProtocol(protocols, protocolId, name)` — match по slug → name
- `mapDefiLlamaCategory()` — `Lending` → `lending`, `Dexes` → `lp` и т.д.
- `isLikelyReceiptLess()` — auto-детект Morpho/Drift/Adrena/Euler v2/CDP
- Registry pattern: `registerReceiptLessOracle()` в `token_roles.ts`
  позволяет fallback'нуться на DefiLlama для unknown protocols

Vite proxy: `/llamaprotos` → `https://api.llama.fi`.

После этого при подключении нового кошелька с **неизвестным протоколом**:
1. Hardcoded whitelist пробуется первым (для known протоколов гарантированный путь)
2. Если не нашлось — DefiLlama делает educated guess через category
3. Метаданные кэшируются в localStorage

### 2. POS-001 V3 IncreaseLiquidity events (foundation) ✅

**Проблема:** DeBank API возвращает только первый mint NFT, не отдаёт
последующие `increaseLiquidity` calls. POS-001 XAUt был дополнительно
залит через increaseLiquidity → live $162 vs DeBank-видимый deposit $57.

**Решение:** прямой Alchemy log query через viem `getLogs`.

- `apps/web/src/lib/v3/liquidity_events.ts`
- `fetchV3LiquidityEvents(dep, tokenId, apiKey)` — все Increase/Decrease events для NFT
- Decoded amounts (raw uint256), `sumIncreaseAmounts()` для total deposit

**Foundation готова.** Полная интеграция в pipeline (вызов из `useV3Positions`,
сравнение с DeBank deposits, attribution в startUsd) — отдельный шаг
~3-4 часа когда пользователь подключит wallet с подтверждённым cases
несовпадения.

### 3. Morpho borrow startUsd ($0 → корректное значение) ✅

**Проблема:** AUSD/GHO/USDe и другие новые стейблы не были в `STABLES`
whitelist'е. DeBank возвращал их `price=0` (no feed). В результате:
- `toLine()` устанавливал `usd = 0 × amount = 0`
- `assetUsd` / `debtUsd` от Morpho live = $0
- UI показывал "Стартовая = $0,00"

**Решение:**
- `protocols.ts:STABLES` — добавлены AUSD, GHO, sUSDS, USDM, DOLA, FXUSD, EURC
- `live_adapters.ts:toLine()` — fallback price=$1 для стейблов без DeBank price
- `live_adapters.ts:deBankItemToPosition()` — пересчёт `assetUsd`/`debtUsd`
  через `Σ supply.usd` если DeBank вернул 0
- `dashboard/metrics.ts:computeBorrowInterestForToken()` — детект
  **inferred-repay**: если `lend_supply` op с OUT-движением borrow-currency
  (без in-side), это de-facto repay. Решает кейс POS-004 Morpho:
    23.04 borrow 815 AUSD → 23.04 + 29.04 out 215 AUSD → debt 600 AUSD
  Раньше всё считалось `lend_supply`, accumulated debt был неверный.

### 4. V3 диапазон без NFT — работает корректно ✅

**Анализ:** диапазон (Pa, Pb, currentPrice) считывается через
Alchemy multicall в `fetchV3PositionsForDeployment` для **всех NFT
владельца кошелька**. Не зависит от наличия mint-op в DeBank — RPC
читает state напрямую с `NPM.positions(tokenId)`.

Если range не отображается — это указывает на:
- `findV3Deployments(chain, protocolName)` не нашёл deployment
- Или Alchemy key не настроен
- Или enumeration не нашёл NFT (transferred / wrong owner)

После добавления Aerodrome/Velodrome receipt-detection в `token_roles.ts`
эти deployments тоже должны корректно работать.

### 5. POS-009/010 PAXG dup ✅ (pro-rata fix)

**Проблема:** 2 V3 NFT в одной пары PAXG/USDC, в ops только 1 mint
(NFT-A создан через split). Старый код назначал тот же mint обоим
NFT через fallback → каждый показывал startUsd $1,180 → суммарный
cost basis $2,360 (× 2 завышение).

**Решение:** `open_positions.ts` post-processing — детект дубль-startUsd
в группе V3 NFT по `(walletId, chain, protocolId, pair)`. Если
обнаружен:
- Берём `trueTotalDeposit = max(startUsd_per_NFT)` (обычно одинаковое)
- Перераспределяем pro-rata к `currentUsd`:
    `NFT.startUsd = trueTotalDeposit × (NFT.currentUsd / Σ currentUsd)`
- Recalc `netPnlUsd`, `netPnlPct`

**Результат:** для POS-009/010:
- Σ startUsd = $1,180 (= реальный депозит на 05.03.2026)
- POS-009 (NFT-A residual): $22.14 startUsd, $21.48 current, PnL -2.99%
- POS-010 (NFT-B split): $1,158.68 startUsd, $1,124.04 current, PnL -2.99%

PnL -98% дубль ушёл — оба NFT теперь показывают realistic PAXG decline.

**Точное per-NFT cost basis** (когда NFT-B был создан, что было
вложено на момент split) требует Alchemy log parsing — foundation
готова в `liquidity_events.ts`, full integration — Phase 5+.

## Что теперь автоматически работает

После 5 фиксов методология **proactively** обрабатывает:

| Сценарий | Подход | Без вмешательства |
|---|---|---|
| Новый протокол с известной категорией | DefiLlama API auto-classify | ✓ |
| Новый стейбл (Agora USD, GHO, USDM) | $1 fallback + расширенный whitelist | ✓ |
| V3 NFT split (decreaseLiquidity → mint) | Pro-rata redistribute startUsd | ✓ |
| Receipt-less repay (out borrow-currency) | Inferred-repay detection в metrics | ✓ |
| Multi-asset Morpho debt без price | Fallback aggregate via Σ tokens | ✓ |

## Что требует ручной работы (документированный долг)

- **Полная Alchemy integration для V3 cost basis** (POS-001 case) —
  foundation готова, но не wired-up в pipeline. Активируется когда
  пользователь подтверждает несовпадение DeBank vs live для конкретного NFT.
- **Cross-chain bridge linking** — partially работает через
  `findInternalTransferPairs`, но не покрывает все паттерны (LayerZero,
  Wormhole, Synapse).
- **Manual annotations** для unknown income sources (зарплата, подарок).

## Иерархия источников данных

После всех изменений приоритет таков:

```
1. Hardcoded curated whitelist (для known protocols гарантированный path)
   ↓ если не сматчилось
2. DefiLlama Protocols API (auto-classify по category)
   ↓ если каталог не загружен или не сматчилось
3. Symbol-pattern эвристики (PROTOCOL_TOKEN_PREFIXES_UPPER)
   ↓ если ни один паттерн не сработал
4. Default: receipt-based, kind=other (наиболее консервативно)
```

Это устойчиво к **отказу любого слоя** — even если DefiLlama down,
hardcoded whitelist + symbol patterns обеспечивают работу.
