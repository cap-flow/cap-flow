# V3 Pipeline

Путь от Alchemy RPC до V3 popup в [[frontend|OpenPositionsPage]].

## Поток

```
Settings → alchemyApiKey            ──┐
LoadedWalletsProvider.live           ──┤
  (LiveProtocolPosition[])             │
                                       ▼
                      ┌──────────────┴──────────────┐
                      │ useV3Positions hook          │
                      │ (lib/v3/hook.ts)             │
                      │ — фильтрует EVM позиции с    │
                      │   protocolMatch (Uni/Pancake │
                      │   /Sushi V3)                 │
                      │ — строит target list         │
                      └──────────────┬──────────────┘
                                     │
                  parallel per (wallet × deployment)
                                     │
                                     ▼
                      ┌──────────────┴──────────────┐
                      │ fetchV3PositionsForDeployment│
                      │ (lib/v3/positions.ts)        │
                      │                              │
                      │ viem multicall:              │
                      │  1. NPM.balanceOf            │
                      │  2. tokenOfOwnerByIndex × N  │
                      │  3. positions(tokenId) × N   │
                      │  4. Factory.getPool × N      │
                      │  5. pool.slot0() × pools     │
                      │  6. ERC20.symbol/decimals    │
                      └──────────────┬──────────────┘
                                     │
                                     ▼
                            V3Position[]
                                     │
                                     ▼
                      ┌──────────────┴──────────────┐
                      │ V3PositionMap                │
                      │ key = walletId|chain|        │
                      │       deploymentId|symbols   │
                      └──────────────┬──────────────┘
                                     │
                       passed to PositionRow
                                     │
                                     ▼
                      ┌──────────────┴──────────────┐
                      │ V3InfoButton + V3RangeBlock  │
                      │ (OpenPositionsPage.tsx)      │
                      │                              │
                      │ Pa, Pb, current, in-range,   │
                      │ exit-up/down, P_break, ...   │
                      └──────────────────────────────┘
```

## Файлы

| Файл | Назначение |
|---|---|
| `lib/v3/chains.ts` | `V3_DEPLOYMENTS[]` — конфиги per (protocol × chain) |
| `lib/v3/abis.ts` | Минимальные ABI: NPM, Factory, Pool, ERC20 |
| `lib/v3/positions.ts` | `fetchV3PositionsForDeployment()` через multicall |
| `lib/v3/math.ts` | tick→price, sqrtPriceX96→price, isInRange, v3RawAmountsAt |
| `lib/v3/hook.ts` | React-хук `useV3Positions` |

## Поддержка протоколов

Сейчас в `V3_DEPLOYMENTS`:
- **Uniswap V3**: ETH, Arb, Op, Polygon, Base, BNB
- **PancakeSwap V3**: ETH, Arb, Base, BNB
- **SushiSwap V3**: ETH, Arb, Op, Polygon, Base, BNB, Avalanche

Добавить новый V3-форк с тем же ABI: вписать запись в массив с
`protocolMatch` regex и адресами NPM/Factory.

## V3 математика (lib/v3/math.ts)

```ts
// tick → human price (token1/token0)
P_human = 1.0001^tick × 10^(decimals0 − decimals1)

// raw amounts при заданной sqrtP (whitepaper §6.2.9)
amount0 = L × (sqrtPb − sqrtP) / (sqrtP × sqrtPb)
amount1 = L × (sqrtP − sqrtPa)
```

При `sqrtP ≤ sqrtPa` → всё в token0 (выход вниз).
При `sqrtP ≥ sqrtPb` → всё в token1 (выход вверх).

## V3InfoButton popup

Внутренние блоки (см. `OpenPositionsPage.tsx`, секция `V3RangeBlock`):

1. **Header** — IL (LP value − HODL value)
2. **Сейчас в позиции** — текущая пропорция по символам
3. **Per-NFT block:**
   - Pa / Сейчас / Pb (USDC/WETH)
   - Статус «В диапазоне / Вне диапазона»
   - **Выход вверх (Pb)**: amount продажи, средняя цена продажи,
     PnL vs депозит, vs HODL
   - **Выход вниз (Pa)**: amount покупки, средняя цена покупки,
     PnL vs депозит, vs HODL, **Безубыток** (P_break)

P_break вычисляется только когда квота — стейбл (USDC/USDT/USDT0/DAI):
```
P_break = depositUsd / amount0AtPa
```

## Кэш и обновление

V3 данные **не кэшируются** (всегда свежие из RPC). При каждом изменении
loaded list или alchemyKey — перезапрос.

## Известные ограничения

- Ширина точности: `liquidity` (uint128) конвертируется в JS Number.
  Для очень больших позиций (> 2^53) теряется точность — для отображения
  достаточно, для критичных вычислений нужен BigInt.
- Algebra V3 (QuickSwap, Camelot, Thena Fusion) — другой ABI (`globalState`
  вместо `slot0`), сейчас не поддерживаются.
