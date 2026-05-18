---
date: 2026-05-18
stage: UCB C2
---

# UCB C2 — fiat-hop cost basis inheritance

## Контекст

Vladimir POS-002 Fluid Lending после refactor'а LotTracker SoT
(2026-05-18) показал startUsd = $26,671.65 для 10.6242 ETH. UCB-расчёт
корректный per single-wallet WAC, но **не учитывал реальный cost basis
ETH, прошедшего через CEX-loop**:

**Реальная история via.irk Aug 12 2025**:
1. 09:17 (eth) cowswap `9646 USDC → 2.149 ETH` (WAC = $4488/ETH)
2. 09:24 (eth) `withdraw_fiat -2.163 ETH` (to CEX)
3. 09:45 (arb) `deposit_fiat +2.165 ETH` (from CEX)
4. 10:02 (arb) `lend_supply 2.154 ETH → Fluid`

Шаг 3 терял cost basis trail. m.usd ETH = $2114 (market при deposit),
но user реально заплатил $4488/ETH. Без C2 fix'а:
- POS-002 supply #1: 2.1539515 × $2114 = **$4554.90**

С C2 fix'ом:
- POS-002 supply #1: 2.1539515 × $4488 ≈ **$9667** (real cost basis)

Δ = +$5,112 cost basis для одного supply'а.

## Почему existing инфраструктура не покрывала это

| Movement | Что покрывает | Что НЕ покрывает |
|---|---|---|
| A2 `findInternalTransferPairs` | cross-wallet `transfer_*` / `bridge_*` pairs (через bridge) | (a) skip'аeт same-wallet pairs, (b) marks как internal но не propagate cost basis |
| D3 CEX cost basis service | CEX P2P → trade → withdrawal trail когда CEX account connected | users БЕЗ подключенного CEX (большинство) |
| D5 bridge inheritance | `bridge_out` → `bridge_in` same wallet | `withdraw_fiat` → `deposit_fiat` (разные op types, отдельный classifier path) |
| A4 manual annotation | всё | требует ручной работы; обнаруживается только когда user заметил расхождение |

CEX-loops (on-chain → CEX → on-chain) — частый паттерн (P2P покупки,
chain-to-chain transfers через CEX вместо bridge). Не должны требовать
manual annotation для каждого случая.

## Решение

Pure function `computeFiatHopCostBasisOverrides(opsByWallet, preExisting)`
в `apps/web/src/lib/portfolio/lots/fiat_hop_cost_basis.ts`:

**Алгоритм**:
1. Собираем все `withdraw_fiat` (OUT direction) ops через ВСЕ wallets
   user'а в global slot list
2. Собираем все `deposit_fiat` (IN direction) ops аналогично
3. Greedy matching, deposit-first sort by time:
   - Token family match через `tokenFamily` (ETH/WETH=ETH, USDT/USD₮0=USDT)
   - Amount tolerance: ±5% volatile, ±10% stable (CEX fees + spread)
   - Time window: ±6 hours (CEX delays могут залипать, но не сутки)
   - Withdraw must precede deposit chronologically
   - Nearest-by-time wins, used pool used-once
4. Для каждого pair:
   - Build fresh LotTracker на `opsByWallet.get(withdraw.walletId)` с
     EXCLUDED этим withdraw_fiat (чтобы wacAt видел pre-consume amount)
   - Pass `preExisting` (A4 manual + D3 CEX) как `costBasisOverrideByHash`
   - Read `wacAt(walletId, withdraw.symbol, withdraw.time)`
   - Return `{ deposit.hash → wac × deposit.amount }` в output Map

**Output**: `Map<deposit_fiat_hash, costBasisUsd>` готовый для merge в
`costBasisOverrideByHash`.

## Wiring

`LoadedWalletsProvider.tsx`:
```ts
const fiatHopCostBasisByHash = useMemo(
  () => computeFiatHopCostBasisOverrides(opsByWallet, cexCostBasisByHash),
  [loadedById, cexCostBasisByHash],
);

const mergedCostBasisByHash = useMemo(() => {
  const m = new Map(fiatHopCostBasisByHash);
  for (const [k, v] of cexCostBasisByHash) m.set(k, v); // CEX wins
  return m;
}, [fiatHopCostBasisByHash, cexCostBasisByHash]);
```

Затем `mergedCostBasisByHash` идёт в `runUcbPipelineForWallet(...)` где
`runUcbPipelineForWallet` сам сверху накладывает A4 manual annotations.

**Precedence (final)**: A4 manual > D3 CEX (server) > C2 fiat-hop (local).

## Применимость

- **Все users** где деньги ходят on-chain → CEX → on-chain (даже без
  подключенного CEX account)
- **Все assets**: ETH/WETH, BTC/WBTC, SOL/WSOL, BNB/WBNB, stablecoins
  (через `tokenFamily`)
- **Не ломает**:
  - V3 LP / GMX V2 (уже работают через LotTracker)
  - Lending позиции (priority-кейс уже хедж в open_positions.ts)
  - Realized PnL (наследует через ucb_pipeline → buildLotTracker chain)

## Tests

`fiat_hop_cost_basis.test.ts` — 7 scenarios:
1. **Vladimir POS-002 base case**: swap → withdraw_fiat → deposit_fiat same wallet, expect inherited WAC ($4488 × 2.165 ≈ $9718)
2. **Cross-wallet case**: wallet A withdraw → wallet B deposit
3. **Time window enforcement**: pairs >6h apart не матчатся
4. **Amount tolerance**: 1.0 ETH out vs 1.5 ETH in (50% off) не матчатся
5. **Dedup**: одна withdraw → один deposit (closest match wins)
6. **WETH ↔ ETH family normalization**
7. **A4 manual annotation chain**: pre-existing override на source lot
   корректно propagates через CEX hop

Все 7/7 ✅ · 205/205 portfolio · tsc clean.

## Caveats v1 (backlog)

- **Single-pass**: source tracker строится с pre-existing overrides only.
  Multi-hop chains (A→B→A→C) могут потерять trail на 2+ hop. Solution
  (C2.1): iterative resolution to convergence (3-5 iterations max).
- **Greedy heuristic**: если user снял $5000 и независимо купил $5000
  (одинаковая сумма) через 1 час — heuristic свяжет ложно. Workaround:
  A4 manual annotation на ложный deposit_fiat (override = m.usd) явно
  отключает inheritance.
- **±5%/10% + 6h окно** намеренно strict. Если real-world data покажет
  значительные false negatives — расширить.
- **Не учитывает CEX-side fees**: deposit_fiat amount часто меньше
  withdraw_fiat amount (network + CEX fees). C2 использует deposit
  amount × source WAC, что недо-учитывает fees как loss. Долгосрочно:
  separate fee tracking через D3 service.

## Связанные документы

- [open-positions-lottracker-sot.md](open-positions-lottracker-sot.md) —
  предыдущий refactor, на котором C2 строится
- [cost-basis-architecture.md](cost-basis-architecture.md) — общий
  framework
- [ucb-universal-cost-basis.md](ucb-universal-cost-basis.md) — UCB
  методология (D, A серии invariants)
