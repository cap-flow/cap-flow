---
date: 2026-05-18
stage: post-UCB
---

# Open positions startUsd — LotTracker как single source of truth

## Контекст

Vladimir POS-002 Fluid Lending показывал inconsistent startUsd:
- column sum в "История покупок underlying" = **$36,779.19**
- position summary = **$33,930.96**

Оба числа — корректные **для своего движка**, но три параллельных
движка cost basis работали независимо:

| Движок | Файл | Что видит | Где используется |
|---|---|---|---|
| `CostBasisTracker` | `cost_basis_tracker.ts` | Только `swap-from-stable`. Не видит `transfer_in`, `deposit_fiat`, `claim_rewards`, `bridge_in` | Старая ветка `buildSupplyToken` (avgAtOpen × s.amount) |
| `LotTracker` | `lots/build.ts` | Все acquisitions + D3/A4 overrides + WAC drift fix (M3) | PurchaseHistoryPopup, lot-by-lot view |
| `position_lot_cost_basis` | `position_lot_cost_basis.ts` | Свой проход поверх operations + tracker events | "История покупок underlying" popup |

`buildSupplyToken` к моменту fix-а приоритезировала `cycleDeposit.usd`
(market price at supply time) над `avgAtOpen × s.amount`. Это hold
только когда swap price ≈ market. При:
- **swap overpay** (DEX slippage / MEV / DefiLlama price gap) —
  cycleDeposit underestimates
- **transfer_in с D3 (CEX inheritance trail)** — m.usd показывает market
  на момент transfer, но реальная стоимость = trail cost ($4500 vs $2000)

UCB-инвариант: **cost basis = actual amount user paid, не market value
at any point**. LotTracker WAC IS the truth.

## Решение

Новый helper `computePositionConsumedCostFromLots` в `open_positions.ts`
— **step-by-step walker**:

1. Сортирует все ops хронологически
2. Для каждого supply op к target позиции (matches `protocolId`,
   `chain`, `symbol`, `lpTokenId`) **БЕЗ consume**:
   - строит incremental `LotTracker` от ops до этого момента
   - читает `tracker.wacAt(walletId, symbol, op.time)`
   - аккумулирует `supply_amount × WAC_at_supply`
3. Затем пушит current op в `incrementalOps` для next iteration

**Почему step-by-step, не batch**: `LotTracker.consume()` удаляет лоты
с `amount ≤ 1e-9`. Если построить tracker один раз поверх всех ops
(включая consumes), все лоты могут быть удалены → empty array → 0
cost.

**Приоритет в `buildSupplyToken`** теперь:

```
lotConsumed (computePositionConsumedCostFromLots) → если >0
  fallback → cycleDeposit (sum m.usd at supply time)
    fallback → avgAtOpen × s.amount (CostBasisTracker)
      fallback → market × amount
```

D3/A4 overrides прокинуты как `costBasisOverrideByHash` через
`BuildOptions` от `OpenPositionsPage`/`PositionDetailPage` (берётся из
`useLoadedWallets`) в `buildOpenPositions`.

## Применимость

Применимо ко всем **single-asset позициям** (где позиция открывается в
одном underlying):

- **Lending** (Aave, Fluid, Compound, Morpho Blue без collateral GLV) —
  supplied ETH/WBTC/SOL
- **GMX V2** — GM/GLV куплены на stable (отслеживается через
  CostBasisTracker для GM/GLV токенов, расширение TODO)
- **V3 LP NFT** — через `openHash` exact match (см. v3-lp решение
  отдельно)

**Принцип**: всегда отслеживать в каком активе позиция открыта и как мы
его получили, как считает LotTracker. Один движок — один источник
правды.

## Тесты

`open_positions.swap-overpay.test.ts`:

1. **Swap overpay scenario** (Vladimir POS-002):
   - 2 swaps: $3858 USDC → 1.2286 ETH, $7000 USDT → 2.2286 ETH
   - m.usd ETH = market price ($2598, $4712), но WAC = $3141/ETH
   - 2 supplies в Fluid (1.2 + 2.2286 = 3.4286 ETH)
   - Expected startUsd: **$10,769** (= 3.4286 × 3141), NOT $7250 (market)

2. **D3 cost basis override**:
   - transfer_in 1.0 ETH (m.usd $2000, override $4500 via D3)
   - swap 1.0 ETH for $5000 USDC
   - lend_supply 2.0 ETH
   - Expected startUsd: **$9500** (= $4500 + $5000), NOT $7000

Both pass. Regression: 198/198 portfolio · tsc clean.

## Trade-offs

- **Performance**: step-by-step rebuild O(n²) для ops длиной n. Для
  Vladimir POS-002 (~600 ops on Arbitrum) — приемлемо. Если станет
  bottleneck — кэшировать tracker snapshot между supply events.
- **3 движка → 1 movement**: CostBasisTracker и
  `position_lot_cost_basis` остаются для других кейсов
  (gas attribution, popup display). Долгосрочно — consolidate to
  LotTracker only.

## Связанные документы

- [cost-basis-architecture.md](cost-basis-architecture.md) — общий
  framework
- [receipt-token-cost-basis.md](receipt-token-cost-basis.md) — receipt
  token market-price gotcha
- [ucb-universal-cost-basis.md](ucb-universal-cost-basis.md) — UCB
  методология
