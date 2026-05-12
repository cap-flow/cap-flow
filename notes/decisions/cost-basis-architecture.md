---
date: 2026-05-07
stage: 12
---

# Cost basis architecture: lots → positions → cross-protocol trace

## Контекст

Capflow задумывался как инструмент учёта DeFi-капитала, но текущая
архитектура учёта **изолирует каждую позицию** и не отслеживает
cost basis токена через цепочку «купил → положил → довложил → частично
снял → продал → купил снова». В результате на реальных кошельках
(пример: Rabby `0x3df3ce…af6a38`):

- POS-006 (Morpho Blue) теряет дату открытия 22.11.2025, потому что
  collateral GLV уехал из GMX-trace, а Morpho Blue без receipt-токена
  в кошельке не дал anchor.
- GMX V2 sub-positions путаются между собой, пока линкер не сошьёт
  Tx A с Tx B; partial withdraws дают неверный startUsd.
- `isProtocolToken` глобальный — GLV считается «protocol-token» в
  любом контексте, ломая `classifyLending` для Morpho.

Точечные правки решают конкретные кейсы, но **не масштабируются**.
Каждый новый протокол = новая дыра.

Нужен **архитектурный фреймворк cost-basis tracking** в 5 уровнях.

## Решение

Канонический фреймворк построен в 5 уровней; реализация — поэтапная
(7 фаз), каждая фаза автономна и оставляет систему в рабочем
состоянии.

### Уровень 1 — Lot Tracker (per token symbol per wallet)

```ts
interface Lot {
  walletId: string;
  tokenId: string;        // mint / contract address
  symbol: string;
  amount: number;
  costPerUnitUsd: number;
  acquiredAt: number;     // unix sec
  acquiredVia: "buy" | "swap" | "transfer_in" | "claim" | "airdrop" | "lp_close" | …;
  sourceHash: string;     // tx hash, который этот lot создал
}
```

Источники приобретения:
- **Buy за стейбл/фиат** → `cost = paid_USD / amount`
- **Swap** → `cost = USD-эквивалент проданного на момент сделки` (от исторического оракула)
- **Airdrop / claim_rewards** → `cost = market price at receipt` (опция: «считать как 0»)
- **Transfer_in (не internal)** → требует ручной разметки (зарплата / подарок / external)
- **LP close** → `cost = attributedCostUsd` от группы lp_add (уже реализовано в [decisions/lp-cost-basis](lp-cost-basis.md))

При **расходовании**: lot consumption по выбранной методике (WAC / FIFO / LIFO).
Default — WAC.

### Уровень 2 — Position Tracker

```ts
interface Position {
  protocolId: string;
  chain: string;
  marketKey: string;     // mint LP-receipt или synthetic ID для receipt-less
  walletId: string;
  openedAt: number;
  events: PositionEvent[];   // полный лог открытий / докладов / частичных выходов
  receiptAmount: number;     // 0 если receipt-less протокол
  currentCostBasisUsd: number; // running WAC от deposit/withdraw events
  status: "open" | "closed";
}

interface PositionEvent {
  time: number;
  type: "deposit" | "withdraw" | "borrow" | "repay" | "claim" | "interest_accrual";
  hash: string;
  movedTokens: { symbol: string; amount: number; costFromLots: number; }[];
  receiptDelta: number;      // GM/GLV/aToken in/out
}
```

При **deposit**: token consumed from wallet lots → `position.currentCostBasis += consumed.cost`.
При **partial withdraw**: `cost_returned = receiptOut × (currentCostBasis / receiptAmount)` →
возвращается в wallet как новый lot с этой stoimostью; `position.currentCostBasis -= cost_returned`.
При **full close**: position.status = "closed"; финальный realized PnL = sum_received_value − initial_cost.

### Уровень 3 — Cross-protocol Token Trace

Один и тот же токен через многоступенчатую цепочку. Пример:

```
1. GMX:    USDC −5000 → GLV +2740        (1 GLV = $1.825)
2. GMX:    GLV −1000 → USDC +1850        (partial close — realized $25, GLV WAC unchanged)
3. Morpho: GLV −1740 (collateral)        (cost basis $1.825 переезжает в Morpho-позицию)
4. Morpho: USDC +6100 (borrow)           (долг, не приобретение)
5. Morpho: GLV +1740 (close)             (cost basis возвращается на wallet)
6. GMX:    GLV −1740 → WETH+USDC         (продажа GLV — realized PnL по 1.825)
```

Ключевой принцип: **`isProtocolToken` — это контекстная роль, не глобальный флаг**.
Один и тот же GLV:
- В GMX-контексте — receipt-токен GMX (не должен попадать в `lp.deposited` GMX позиции)
- В Morpho-контексте — обычный collateral asset (нормальный учёт через lots)
- В Compound-контексте — обычный токен

Замена: функция `classifyTokenRole(tokenId, protocolId)`:
```ts
type TokenRole = "underlying" | "lending_receipt" | "lp_receipt" | "vault_receipt";
```

База знаний (whitelist contract addresses per protocol):
- Aave aTokens (per chain) — известные адреса
- Compound cTokens — известные адреса
- GMX V2 GM/GLV markets — детектятся через linkedLpTokenId или movement
- Morpho Blue — нет receipt'а (returns false для всех)

Без contract-address базы: fallback на symbol-pattern из текущего `PROTOCOL_TOKEN_PREFIXES`,
но **только для контекста этого протокола**.

### Уровень 4 — Atomic Multi-Tx Linking (расширение)

Текущий [`async_deposit_linker.ts`](../../apps/web/src/lib/portfolio/async_deposit_linker.ts)
обрабатывает GMX V2 / GMSOL deposit-pairs. Расширяем:

- **Withdraw pairs** для GMX V2 / GMSOL (Tx A: GM out → Tx B: USDC+WETH in)
- **Morpho-bundler multicalls**: одна tx содержит supply collateral + borrow атомарно.
  Разбивать на 2 логических события для accounting.
- **Pendle YT/PT splits**: deposit underlying → mint PT + YT в одной tx
- **EulerEarn vault zaps**: zap-in routers с промежуточными swap'ами

Каждый паттерн = отдельный `linker plugin` со своей heuristic'ой. Список плагинов
расширяемый.

### Уровень 5 — Receipt-less Protocols

Morpho Blue, Drift Spot, некоторые Pendle markets, Adrena PnL pools и т.д.
Протоколы НЕ выдают receipt-токен в кошелёк, position state живёт **только** в
протоколе и видно через live API.

Учёт:
- Открытие позиции = первый non-trivial out-движение к этому protocolId+chain+marketKey
- Partial / full close — снова через ops + live diff
- WAC отслеживаем по deposit/withdraw events, **без** receipt-anchor'а
- `marketKey` синтетический: `${protocolId}@${chain}@${first_collateral_symbol}` или
  иной стабильный идентификатор от live API

## Поэтапная реализация

Каждая фаза автономна, оставляет систему в рабочем состоянии. Идём строго в порядке —
зависимости накапливаются.

### Фаза 1: contextual `classifyTokenRole` — 1 день

- Заменить глобальный `isProtocolToken` на `classifyTokenRole(tokenId, protocolId)`
- Whitelist contract addresses для известных protocol-receipts (Aave, Compound, GMX, …)
- В `classifier.ts → classifyLending`: использовать новую функцию вместо `m.isProtocolToken`
- Backward-compat: `m.isProtocolToken` продолжает существовать как «общий receipt-флаг» для UI,
  но classifier использует contextual.
- **Результат**: Morpho 22.11 классифицируется правильно (lend_supply + борровая часть),
  POS-006 получает корректный `lp_add` тип.

### Фаза 2: `findFirstOpen` для receipt-less протоколов — 1-2 дня

- Расширить `findFirstOpen`: если protocol = receipt-less (Morpho Blue, Drift, …),
  не ограничивать `targetSyms` от live state, а смотреть на любые out-движения к этому
  protocol+chain+marketKey
- `marketKey` для receipt-less: derive из live's first non-stable supply token / borrow
  token + chain
- **Результат**: POS-006 получает дату открытия 22.11.2025

### Фаза 3: новый `LotTracker` модуль — 3-5 дней

- `apps/web/src/lib/portfolio/lots/` — отдельный модуль
- API: `LotTracker.acquire(symbol, amount, costPerUnit, source)`,
  `LotTracker.consume(symbol, amount): { consumedLots: [...], totalCostUsd }`
- Методики: WAC (default), FIFO (опциональная)
- Замена существующих `cost_basis_tracker.ts` и `cost_basis_avg.ts` на единый источник
- Обратная совместимость: старые API оставляем как deprecated wrappers
- **Результат**: единая модель cost basis, чище код для всего что выше

### Фаза 4: `PositionTracker` — 5-7 дней

- `apps/web/src/lib/portfolio/positions/` — отдельный модуль
- Каждая Position живёт через event log; cost basis вычисляется из events + LotTracker
- Снапшот текущего состояния позиции = sum(events) при run-time
- Replay-able: при добавлении новой ops пересчёт быстрый
- Удаление текущего разрозненного `findFirstOpen`/`currentCycleDepositForSymbol` → всё
  становится derived от Position.events
- **Результат**: правильный multi-deposit + partial-withdraw учёт по любой позиции

### Фаза 5: cross-protocol token trace — 5-7 дней

- Lots переезжают через protocol boundaries: deposit в Morpho → consume from wallet lot →
  attach to Position; withdraw → emit new lot
- Realized PnL фиксируется только при **окончательной продаже** (out → не self,
  swap в стейбл/другой токен на DEX, withdraw_fiat на CEX). Внутрипротокольные движения
  PnL не реализуют.
- В UI: timeline для конкретного токена — где сейчас находится, где был раньше,
  накопленный realized.
- **Результат**: пользователь видит полную трассу токена через все позиции и сделки

### Фаза 6: edge cases — 3-5 дней

- **Airdrops**: `claim_rewards` ops — настраиваемая политика (cost = 0 / FMV / manual)
- **Rebases** (AMPL, OHM): supply изменения без on-chain transfer — фиксация через
  периодический snapshot diff
- **Token migrations** (LEND → AAVE 1:100): таблица миграций, перепроверка cost basis
- **Stablecoin depegs**: realized loss/gain при swap'е по non-$1 цене
- **Gas attribution**: газ в отдельный bucket (уже есть) или включать в cost basis
  (опция в Settings)

### Фаза 7: тесты + полевая отладка — 5-7 дней

- Unit-тесты на канонические сценарии: «buy → deposit → partial withdraw → re-deposit →
  full close → sell»
- Полевые тесты на реальных кошельках пользователя
- Сверка с DeBank UI / Aave Dashboard / GMX UI на конкретных позициях
- Документация обновлена

## Итого

**~3-4 недели плотной работы** (~120-160 часов одного разработчика).

Точечные правки до этого можно НЕ делать — они частично пересекаются с этой
архитектурой и будут переписаны.

## Что НЕ входит в эту переработку (отдельные задачи)

- Realized vs Unrealized PnL split на уровне Dashboard — уже сделано (этап 11).
- LP impermanent loss модель — уже есть для V3 (этап 4-5), для других V3-style и V2 —
  отдельная задача.
- Solana support — стек на паузе, вернёмся отдельно.
- Lending interest accrual — отдельная задача (см. ROADMAP).

## Asset-centric data flow (главный методический принцип)

Каждая live-позиция от DeBank/Vybe — это **точка отсчёта**, от которой
надо построить ПОЛНУЮ цепочку владения базовым активом:

```
LIVE POSITION (от API)
   ↓
   "В этой позиции на 06.03.2026 лежит 4.902 ETH"
   ↓
ASSET-CENTRIC TRACE
   ↓
   1. Когда этот актив (ETH) ПОЯВИЛСЯ в кошельке?
      → Поиск всех IN-движений ETH/WETH в истории кошелька (не только в этом протоколе!)
   2. По какой цене он был куплен/получен в каждом случае?
      → Для swap'ов: USD-эквивалент из проданного актива (стейбл / другой токен по
        исторической цене)
      → Для transfer_in (CEX/external): из ручной разметки (manual_annotations.fiatPurchase)
      → Для airdrop / claim_rewards: market price at receipt
      → Для LP close: cost basis от исходного депозита через [cost-basis-tracker](lp-cost-basis.md)
      → Для transfer между своими кошельками: cost basis наследуется
   3. Сколько раз и в каких комбинациях покупался?
      → Каждый IN = новый Lot {amount, costPerUnit, time, sourceHash}
      → При расходовании (OUT) — consume from lots по WAC / FIFO / LIFO
   4. Куда уходил между владением и текущей позицией?
      → OUT-движения вне internal-transfers и без markings = РЕАЛИЗАЦИЯ
        (продажа, swap в другой токен) — фиксируется realized PnL
      → OUT в DeFi-протокол = ПЕРЕНОС cost basis в Position Tracker (этой позиции)
   5. Какая средневзвешенная стоимость на момент захода в позицию?
      → WAC всех ETH-lots на момент 06.03.2026
      → Этот WAC × deposit_amount = startUsd позиции
```

**Конкретный пример (POS-004 Fluid ETH/USDC, депозит 06.03.2026 = 4.902 ETH):**

История ETH в кошельке `0x3df3ce…`:

| Дата | Источник | USD paid | ETH in | Цена/ETH |
|---|---|---|---|---|
| 28.11.2025 | 1inch swap | 5000 USDT | 1.642 | $3045.06 |
| 06.12.2025 | 1inch swap | 5000 USDT | 1.644 | $3041.36 |
| 06.12.2025 | 1inch swap | 12200 USDC | 4.012 | $3041.13 |
| 31.01.2026 | Uniswap V3 close | LP-attribution | 4.982 | через cost-basis-tracker |

**WAC на 06.03.2026** = `Σ(usd_paid) / Σ(eth_received)` ≈ **$3041.95 / ETH** (для swap'ов).
**Cost basis депозита** = `4.902 × $3041.95 ≈ $14,909`.

**Это и есть "Стартовая $" для POS-004**, не текущая spot-стоимость и не proportional
decomposition по live supply. Та же логика для POS-005 (WBTC), POS-006 (GLV → Morpho),
любого нового деопозита в любой протокол.

**Алгоритмически:**

```
buildOpenPositions(ops, livePositions):
  // 1. Построить Lot Tracker per (wallet, symbol):
  //    walk all ops chronologically → emit Lot/Realize events.
  lotTracker = LotTracker.fromOps(ops)
  
  // 2. Для каждой live position:
  for lp in livePositions:
    // a. Найти первый op DEPOSIT в этот protocolId+marketKey
    openEvent = findFirstDepositToMarket(ops, lp.protocolId, lp.marketKey)
    
    // b. На время openEvent.time — взять WAC каждого внесённого asset
    for token in openEvent.depositedTokens:
      wacAtOpen = lotTracker.wacAt(token.symbol, openEvent.time)
      tokenCostBasis = token.amount * wacAtOpen
    
    // c. Применить partial withdraws (если были) к Position event log
    position = PositionTracker.fromOps(ops, lp.protocolId, lp.marketKey)
    
    // d. startUsd = position.currentCostBasisUsd (после всех add/remove events)
```

Этот flow **универсален** — работает для любой live позиции независимо от протокола,
типа receipt'а (token / NFT / receipt-less) и количества deposit/withdraw циклов.

## Эмпирические наблюдения (полевой анализ кошелька 2026-05-07)

Анализ Rabby `0x3df3ce…af6a38` с 6 открытыми позициями выявил
дополнительные архитектурные нюансы, которые усиливают необходимость
этой переработки.

### DeBank `pool.id` — НЕ универсальный per-position

Fluid lending: ОБЕ позиции (POS-004 ETH/USDC, POS-005 WBTC/GHO) имеют
один и тот же `pool.id = 0x324c5dc1fc42c7a4d43d92df1eba58a54d13bf2d`
(прокси-vault адрес, общий для всех позиций пользователя). Уникальный
per-position identifier — **fVLT NFT contract**:

- POS-004: fVLT `0xac63b519fefb…`
- POS-005: fVLT `0xf0ba982a3ac2…`

Эти fVLT NFT'ы видны **только в истории ops** (Tx `operate` с receive
`fVLT 1.000`), не в `complex_protocol_list` live state.

**Импликация для Фазы 4 (PositionTracker)**: маркет надо
идентифицировать **через receipt-token из истории**, не через
DeBank's `pool.id`. Алгоритм:

1. Для каждой `LiveProtocolPosition` ищем ops по протоколу+chain
2. В каждой op смотрим in-движения с `isProtocolToken=true`
3. Группируем ops по `tokenId` этого receipt'а
4. Каждая группа = уникальный маркет
5. Маппим LiveProtocolPosition → группу через supply symbols match
   (Fluid POS-004 supply ETH ↔ группа где первый out был ETH)

### GLV — кросс-протокольный receipt

`GLV [WETH-USDC]` это GMX receipt-token, но в POS-006 (Morpho Blue)
он использовался как **collateral**. Один токен — две роли:
- В GMX: protocol-receipt → должен быть скрыт из walletBalances,
  cost basis в GMX-позиции
- В Morpho: обычный collateral asset → нормальный учёт через wallet
  lots, cost basis edет в Morpho-позицию

Глобальный `isProtocolToken=true` ломает Morpho classifier:
`sends=[GLV]`, `receives=[USDC]` → `sentProto=true` → возвращает
`lend_withdraw` (вместо корректного `lend_supply` + `borrow`).

**Импликация для Фазы 1**: `classifyTokenRole(tokenId, protocolCtx)`
обязательна.

### Morpho Blue: receipt-less + atomic combined ops

POS-006 22.11.2025 деп: один tx с `sends: 11287 GLV` +
`receives: 6100 USDC` = **collateral deposit + borrow атомарно**.

Текущий classifier видит ОДНУ tx и пытается выбрать ОДИН тип
(lend_supply / withdraw / borrow / repay), что **в принципе не
покрывает** combined ops.

**Импликация для Фаз 4-5**: Position event log должен принимать
"compound events" — одна tx может породить несколько логических
событий (collateral_deposit + borrow в одно время с одним hash'ем).

### GLV cost basis выходит за пределы видимых GMX позиций

11287 GLV из 22.11.2025 в Morpho — значит ранее у пользователя был
GMX GLV-position (теперь закрытый или мигрированный), которой мы НЕ
видим в текущем live state. Cost basis GLV должен траситься через
**всю историю GLV-ops** в кошельке, не только через 3 текущие GMX
позиции.

**Импликация для Фазы 5**: cross-protocol token trace на уровне
**всех** ops (включая давно закрытые) — обязателен. Без этого
POS-006 cost basis всегда будет приближённый.

### GMX V2 GM tokens с одинаковым символом, разные mint'ы

POS-001/002/003 — все имеют символ "GM" но разные contract addresses
(0x70d955.., 0x47c031.., 0x77b2ec..). Любой matching по symbol — слом.

**Импликация для всех Фаз**: матчинг по `tokenId` (contract address),
никогда по `symbol`.

## Связанные документы

- [decisions/lp-cost-basis](lp-cost-basis.md) — текущий LP-attribution алгоритм (войдёт в Уровень 1)
- [decisions/receipt-token-cost-basis](receipt-token-cost-basis.md) —
  **критично** для всех будущих фиксов: DeBank `m.usd` для receipt-токенов
  это current spot, не historical. Distinct-receipts heuristic + чеклист
  для cost basis (single-aggregated vs independent multi-collateral).
- [decisions/bridge-detection](bridge-detection.md) — internal transfer detection (будет работать со
  всеми уровнями)
- [decisions/credit-attribution](credit-attribution.md) — credit/borrowed flow (войдёт в Уровень 2)
