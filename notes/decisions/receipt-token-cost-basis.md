---
date: 2026-05-09
stage: 13
---

# Receipt-token cost basis: DeBank `m.usd` НЕ исторический

## Контекст (рекуррентный баг)

Этот баг **уже корректировался** ранее (миграция на DefiLlama hist
prices 2026-05-08), но **рецидивировал** при переподключении кошелька
2026-05-09 — потому что фикс закрыл только OUT-side, а IN-side
`m.usd` для receipt-токенов остался искажённым. Документ нужен
чтобы **больше не вернуться** к этому.

## Симптом

Пользователь внёс **5,000 USDC** в GMX V2 (POS-002 WBTC+USDC) — в UI
показано `startUsd = $5,366`. Раньше (до 2026-05-09 утра) показывало
$4,528 для POS-001 при депозите $9,000 USDC.

## Причина

DeBank API возвращает `movement.usd = current_price × amount`, **где
`current_price` это spot-цена на момент API call**, не цена в момент
on-chain транзакции. Для большинства токенов это лечится через
DefiLlama historical prices (есть пер-час bucket), но для
**protocol receipt-токенов** (GM, GLV, GLP, fVLT, Balancer BPT,
Pendle PT/YT) у DefiLlama цены **отсутствуют** — это derivative
tokens без oracle.

Поэтому когда мы считаем cost basis:

| Источник | Что выдаёт | Корректно? |
|---|---|---|
| OUT-side (USDC, ETH) | `m.usd` ≈ amount × stable | ✓ |
| IN-side **обычный** токен (WETH, ARB) | DefiLlama hist price | ✓ |
| IN-side **receipt** токен (GM, GLV) | DeBank current spot | ✗ (искажён) |

**Правильный cost basis для позиции = ровно out-side USD на момент
депозита** (что пользователь физически потратил из своего кошелька).
IN-side receipt USD использовать **никогда нельзя**.

## Второй уровень бага: per-asset decomposition

`supplyTokens` для GMX V2 GM-токена приходит от DeBank уже в виде
"underlying composition": `[WBTC: 0.034, USDC: 2616]`. Это
**redemption ratio** receipt'а сейчас, не отдельные депозиты.

`currentCycleDepositForSymbol('WBTC')` корректно вернёт 0 (WBTC не
вносился), но fallback `avgAtOpen × s.amount` даст ~$2,716 (current
WBTC valuation × scaled amount). Аналогично USDC scaled до $2,616.

Σ = $5,332 ≈ live netUsd $5,366. Это **value сейчас**, а не
**cost при открытии**.

## Решение: distinct-receipts heuristic

Различаем 2 типа multi-asset позиций по **количеству distinct
receipt-tokenIds** в lp_add ops с момента открытия:

### (A) Single-aggregated-receipt: `distinctReceipts.size === 1`

Один receipt-токен на все supply-активы. Примеры:
- **GMX V2 GM** — пользователь вносит USDC, получает GM который
  редимится в WBTC+USDC по live-ratio
- **GMX V2 GLV** — vault token, holds basket of GM markets
- **Fluid Vault fVLT** — combined supply+borrow в одной NFT
- **Balancer BPT** — BPT-токен, redeems в pool composition
- **Pendle SY/PT/YT** — wrapped underlying в derivative форме

Cost basis для (A) = `currentCostBasisForPosition(filterLpTokenId).costUsd`
(use ТОЛЬКО out-side USD из `cost_basis_tracker.depositUsdFromOp`).
**НЕ** использовать `supplySumStartUsd` — он искажён synthetic
per-asset valuation.

### (B) Independent multi-collateral: `distinctReceipts.size >= 2`

Каждый supply-актив имеет свой receipt. Примеры:
- **Aave V3** — aWETH, aUSDC, aWBTC отдельные ERC20
- **Compound v3** — cTokens по каждому активу
- **Morpho Markets** — supply receipts по каждому маркету

Cost basis для (B) = `Σ supplyToken.startUsd` (через
per-symbol `currentCycleDepositForSymbol` → out-side USD каждого
asset суммируется правильно).

### Реализация

`apps/web/src/lib/portfolio/open_positions.ts:1497-1517`:

```ts
const distinctReceipts = new Set<string>();
for (const op of ops) {
  if (op.protocol?.id !== lp.protocolId || op.chain !== lp.chain) continue;
  if (op.time < cycleStart) continue;
  if (op.type !== "lp_add" && op.type !== "lend_supply") continue;
  for (const m of op.movement) {
    if (m.direction === "in" && m.isProtocolToken && m.amount > 0)
      distinctReceipts.add(stripChainPrefix(m.tokenId).toLowerCase());
  }
}
const isSingleAggregated =
  distinctReceipts.size === 1 && positionLevelDeposit > 0;
const startUsd = v3
  ? v3.depositUsd
  : isSingleAggregated
    ? positionLevelDeposit                              // (A)
    : Math.max(positionLevelDeposit, supplySumStartUsd); // (B)
```

## Иерархия источников USD для cost basis (canonical)

При расчёте "сколько $ пользователь потратил при заходе в позицию"
**всегда** идти по приоритету:

1. **LotTracker WAC at op.time × out-amount** — наиболее точный,
   учитывает всю цепочку приобретения base asset'а
2. **DefiLlama historical price × out-amount** — для swap-style
   ops без полного lot history
3. **stable check** — для USDC/USDT/DAI/etc. → $1
4. **DeBank `m.usd` для NON-protocol token** — fallback (current spot,
   но допустим если op свежий)
5. **DeBank `m.usd` для PROTOCOL token (GM/GLV/aToken)** — **НИКОГДА
   НЕ ИСПОЛЬЗОВАТЬ** для cost basis. Это current redemption value,
   не historical purchase cost.

## Чек-лист для будущих фиксов

Перед тем как считать `startUsd` или любую cost basis метрику:

- [ ] Источник — out-side movement (что ушло **из** кошелька)
- [ ] Receipt-токены (`isProtocolToken=true`) **исключены** из суммы
- [ ] Gas micro-amounts ETH (< 0.01 ETH, < $100) **исключены**
- [ ] Цена — historical (LotTracker WAC → DefiLlama hist → stable check)
- [ ] **НЕТ** fallback'а на DeBank `m.usd` для in-side receipt'ов
- [ ] При multi-asset проверить `distinctReceipts.size`:
  - 1 → use positionLevelDeposit only
  - ≥2 → MAX(positionLevelDeposit, supplySumStartUsd)

## Тестовые сценарии для регрессий

Минимальный набор edge cases для unit-тестов (Фаза 7 архитектурного
плана):

1. **GMX V2 single deposit**: out 5000 USDC + 0.0001 ETH gas, in
   2225 GM @ DeBank spot $5367. Expected startUsd = **$5,000**.

2. **GMX V2 multi-deposit + partial remove**: 3 lp_add ($5000 + $1200
   + $922) + 1 lp_remove ($1931 USD value). Expected startUsd =
   **WAC remaining cost** ≈ $5,263, **не** Σ in-side USD ($7,418),
   **не** live netUsd ($5,486).

3. **Aave V3 multi-collateral**: deposit 5000 USDC + deposit 1 WETH
   ($3000) → 2 distinct aTokens. Expected startUsd = **$8,000**
   (full sum), используется (B) path.

4. **Fluid Vault combined**: 1 tx supply 1 ETH + borrow 1500 USDC →
   1 fVLT NFT. Expected startUsd = **$3,000** (out ETH @ hist
   price), debt $1500. Single receipt → (A) path.

5. **Balancer BPT**: deposit USDC + WETH в weighted pool, get 1 BPT.
   Expected startUsd = **Σ out-USD** через positionLevelDeposit.

## Связанные документы

- [decisions/cost-basis-architecture](cost-basis-architecture.md) —
  Фаза 1 (`classifyTokenRole`) и Фаза 4 (PositionTracker) полностью
  снимут эту проблему через explicit modeling. До тех пор —
  distinct-receipts heuristic.
- [decisions/lp-cost-basis](lp-cost-basis.md) — out-side cost basis
  для close attribution (тот же принцип).

## История инцидентов

- **2026-05-08**: первый инцидент — startUsd через DeBank current
  spot искажал старые позиции (ETH @ 6 мес назад при $1500
  показывался при $4000). Фикс: histPrices через DefiLlama для
  out-side USDC/ETH/WBTC.
- **2026-05-09 утро**: рецидив v2 — POS-001 GMX V2 показывал $4,528
  при депозите $9,000. Фикс: `MAX(positionLevelDeposit,
  supplySumStartUsd)`. **Этот фикс был неполным** — см. v3.
- **2026-05-09 день**: рецидив v3 — POS-002 GMX V2 показывал $5,366
  при депозите $5,000. Причина: `MAX()` выбирал synthetic
  decomposition вместо out-side для single-receipt позиций. Первая
  попытка фикса через `distinctReceipts.size === 1` оказалась
  **неверной**: у GMX V2 каждый POS имеет свой GM-контракт, поэтому
  через ВСЕ ops протокола `size > 1` всегда → фикс не активировался.
- **2026-05-09 вечер**: рецидив v4 — POS-001 показывал $10,768 при
  депозите $9,000. Причина: `lotTracker.avgAt('USDC')` возвращал
  ~$1.196 из-за inflated WAC от lp_remove attribution (closed LP
  returned USDC с inflated cost basis). Фиксы:
  - В `open_positions.ts:isSingleAggregated` — детект через
    `hasSyntheticSupply` (есть supply-токен без out-движения в этой
    позиции), а не distinct-receipts size.
  - В `depositUsdFromOp` — стейблы (USDC/USDT/DAI/...) → `$1`
    ВСЕГДА, обходя `lotTracker.avgAt`. lotTracker не должен влиять
    на стейблы.

После v4-фикса все 6 позиций кошелька `0x3df3ce…af6a38` показывают
**точный** startUsd:
| POS | Pair | Реальный депозит | startUsd UI |
|---|---|---|---|
| POS-001 | GMX V2 WETH+USDC | 9,000 USDC | $9,000.00 ✓ |
| POS-002 | GMX V2 WBTC+USDC | 5,000 USDC | $5,000.00 ✓ |
| POS-003 | GMX V2 WETH+USDC | 5000+1200-WAC remove+922 | $5,262.80 ✓ |
| POS-004 | Fluid ETH | 14.14 ETH @ WAC | $32,719 ✓ |
| POS-005 | Fluid WBTC | 0.368 WBTC @ WAC | $29,619 ✓ |
| POS-006 | Morpho WETH+USDC↔USDC | 3.8 WETH + 8813 USDC | $17,993 ✓ |

## Чек-лист 2: новые виды рецидивов

В дополнение к основному чек-листу — следить за этими паттернами:

- [ ] **`hasSyntheticSupply` детект**: фильтровать ops по
  `filterLpTokenId`, не по всему протоколу. Иначе для протоколов с
  множеством markets (GMX V2, Morpho) ВСЕ receipts смешиваются и
  детект не срабатывает.
- [ ] **Стейблы и lotTracker**: `lotTracker.avgAt('USDC')` НЕ
  доверять. Стейблы всегда $1 в cost basis math (если не делается
  явный depeg accounting). lp_remove attribution может занести
  inflated cost в стейблы → искажает все будущие cost basis расчёты.
- [ ] **Сравнение positionLevelDeposit с реальной суммой OUT**: при
  любом отклонении > 1% от ожидаемого выяснить источник. Чаще всего
  это inflated WAC или synthetic decomposition.
- [ ] **НЕ доверять `op.type` классификатору для cost basis math.**
  Классификатор может неправильно пометить ops (особенно для
  receipt-less протоколов: 06.12 GLV-supply в Morpho был помечен как
  `repay`, хотя репай GLV невозможен — Morpho-debt был USDC).
  Для receipt-less протоколов фильтровать out-movements по
  **collateral symbol** (= символ первого non-stable non-receipt
  non-gas out-движения), не по op.type. Подход устойчив к
  мис-классификации.

## v5 (2026-05-09): collateral-symbol filter для Morpho

Добавлен (Этап 12 / Фаза 2):

```ts
// В currentCostBasisForPosition, для receiptLessMode:
let collateralSymbol: string | null = null;
for (const op of sorted) {
  for (const m of op.movement) {
    if (m.direction === "out" && /*non-receipt, non-stable, non-gas*/) {
      collateralSymbol = normalizeSymbol(m.symbol);
      break;
    }
  }
  if (collateralSymbol) break;
}

// Затем суммируем ТОЛЬКО out-движения collateralSymbol через все ops
// (игнорируем op.type — это устраняет ошибочные exclusions).
```

Это исправило POS-006 Morpho: было $17,611 (только 22.11 supply, 06.12
терялся из-за `repay`-классификации), стало **$21,858** (оба supply
учтены, ≈ реальные $21,565 = всё что юзер потратил на GLV).
