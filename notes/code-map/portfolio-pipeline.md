# Portfolio Pipeline

Как сырые on-chain данные становятся `OpenPosition[]` для таблицы.

## Поток данных

```
DeBank /history          ──┐
DeBank /protocols        ──┤
Helius /transactions     ──┤
Helius /balances         ──┤
Jupiter /price           ──┼─► LoadedWalletsProvider.load()
Vybe /defi-positions     ──┤            │
Sonar /portfolio         ──┘            │
                                        ▼
                          ┌─────────────┴───────────────┐
                          │ classifyHistory (classifier) │
                          │ raw DeBank ops → ClassifiedOp│
                          └─────────────┬───────────────┘
                                        │
                                        ▼
                          ┌─────────────┴───────────────┐
                          │ adapt*Live → LiveSnapshot   │
                          │ (live_adapters.ts)          │
                          └─────────────┬───────────────┘
                                        │
              loaded = { ops, live } per-wallet
                                        │
                                        ▼
                          ┌─────────────┴───────────────┐
                          │ buildOpenPositions          │
                          │ (open_positions.ts)         │
                          └─────────────┬───────────────┘
                                        │
                                        ▼
                                OpenPosition[]
                              for OpenPositionsPage
```

## Этап 1 — Classification

`apps/web/src/lib/portfolio/classifier.ts` (EVM) и `solana_classifier.ts`
(Solana).

Берёт DeBank `DeBankHistoryItem` или Helius `HeliusTransaction` и выдаёт
`ClassifiedOp`:

```ts
ClassifiedOp {
  hash, chain, time, status,
  type: "deposit_fiat" | "swap" | "lp_add" | "lp_remove"
      | "lend_supply" | "lend_withdraw" | "borrow" | "repay"
      | "stake" | "claim_rewards" | "transfer_in" | "transfer_out"
      | "approve" | "bridge_in" | "bridge_out" | "perp_open" | ...,
  protocol: { id, name, category } | null,
  movement: TokenMovement[],   // in/out per token
  netUsd, gasUsd, counterparty, fnName, ...
}
```

Эвристика типа: смотрит на `cate_id`, `name`, `project.name`, наличие
`token_approve` и состав `sends`/`receives`. См. функцию `classifyHistory`.

## Этап 2 — Live state adaptation

`live_adapters.ts` приводит ответы DeBank/Helius/Vybe/Sonar к
универсальному `LiveSnapshot`:

```ts
LiveSnapshot {
  totalUsd
  tokens: LiveTokenBalance[]    // спот-балансы
  positions: LiveProtocolPosition[]  // активные DeFi-позиции
}

LiveProtocolPosition {
  protocolId, protocolName, chain, walletId,
  category: "lending" | "lp" | "staking" | "vault" | ...,
  itemName: "Liquidity Pool" / "Lending" / ...,
  netUsd, assetUsd, debtUsd,
  healthRate?,
  supply: LivePositionTokenLine[],   // что в залоге / в LP
  borrow: LivePositionTokenLine[],   // что в долгу
  rewards: LivePositionTokenLine[],  // pending fees
}
```

## Этап 3 — Build open positions

`apps/web/src/lib/portfolio/open_positions.ts` собирает финальную модель
`OpenPosition` для UI.

Для каждой `LiveProtocolPosition`:

1. **Найти первый open-event** в ops (`findFirstOpen`) для определения
   `openedAt` и `ageDays`.

2. **Build supply tokens** через [[cost-basis-pipeline|cost basis tracker]]:
   `startUsd = amount × avgBuyPrice` (средневзвешенная цена покупки).

3. **V3-detection** через `isV3LpProtocol(protocolName)`. Если да —
   вызывается `buildV3Details` (DefiLlama hist цены для депозита, текущие
   цены для HODL value, расчёт IL).

4. **Fees**:
   - `feesUsd` (pending) = `lp.rewards` для V3 / `current_supply − Σ deposited` для lending
   - `feesClaimedUsd` = Σ `claim_rewards` ops (USD по hist-ценам)
   - `feesLifetimeUsd = pending + claimed`

5. **creditFundedUsd** = 0 по дефолту, выставляется через [[../decisions/credit-attribution|ручную метку]] в UI.

## Финальный тип

```ts
OpenPosition {
  id: "POS-NNN",
  walletId, walletName, walletChain, chain,
  protocol: { id, name, category },
  kind: "lending" | "lp" | "staking" | "perp" | "other",
  itemName,
  openedAt, openHash, ageDays,

  supplyTokens: OpenPositionToken[],
  debtTokens, startUsd, currentUsd, currentDebtUsd,
  healthRate?,

  v3?: V3Details,    // только для V3 LP

  feesUsd, feesSource, feeApr,
  feesClaimedUsd, feesLifetimeUsd, feeAprLifetime,
  feesByToken,
  creditFundedUsd,
}
```

## Ключевые файлы

- `apps/web/src/lib/portfolio/types.ts` — все типы
- `apps/web/src/lib/portfolio/classifier.ts` — EVM classify
- `apps/web/src/lib/portfolio/solana_classifier.ts` — Solana classify
- `apps/web/src/lib/portfolio/live_adapters.ts` — adapter'ы
- `apps/web/src/lib/portfolio/open_positions.ts` — `buildOpenPositions`
- `apps/web/src/lib/portfolio/protocols.ts` — `isStableSymbol`, `isStableMint`
