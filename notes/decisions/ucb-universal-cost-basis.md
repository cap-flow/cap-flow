---
date: 2026-05-15
updated: 2026-05-15
stage: core-methodology
status: locked
---

# UCB — Universal Cost Basis (ядро методологии Capflow)

> **Locked decision.** Это архитектурный примитив всего сервиса, не
> отдельная фича. Все будущие модули (PnL, доходность, налоговая
> отчётность, ребалансировка, рекомендации) должны опираться на
> результат UCB-пайплайна, а не строить cost basis параллельно.

## Контекст

Пользователь подключает к Capflow:
- N on-chain кошельков (обычно 2–5) на разных сетях (EVM + Solana)
- M CEX-аккаунтов (Bybit / Bitget / BingX / OKX / MEXC, опционально P2P)

В любой момент времени видны его текущие активы:
- Балансы кошельков (свободные токены)
- DeFi-позиции (lending / LP / staking / vaults — частично у DeBank,
  частично у нас своя реконструкция)
- CEX-балансы

Для каждого юнита каждого актива требуется ответить на вопрос:
**«за сколько $ я его получил?»** Только тогда возможны корректные:

- PnL ($ и %)
- доходность APR/APY с учётом cost basis (а не tvl)
- impermanent loss vs HODL
- налоговая отчётность (FIFO/LIFO/WAC)
- credit/funded vs own-capital split

Сейчас каждый источник считает cost basis **в изоляции**, и cost basis
не пересекает границы источников. Это ломает 80%+ позиций уже на
типичном пользователе (см. ниже Bob).

## Решение: UCB

**Cost basis есть инвариант, который течёт по графу всех движений
пользователя** — независимо от того где они произошли (on-chain swap,
cross-wallet transfer, CEX deposit, CEX trade, CEX withdrawal, P2P,
manual annotation).

### Граф событий

- **Node** = пара `(account, asset)` где account ∈ {on-chain wallet,
  CEX-account}, asset ∈ {ETH, WBTC, USDT, …}.
- **Edge** = transfer-event между нодами с положительным amount.
- **Source-edge** = генерирует cost basis (P2P fiat → crypto, swap из
  стейбла, manual annotation «куплено за $X», fiat deposit).
- **Sink-edge** = реализует cost basis (sell-to-stable, fiat-payout,
  manual annotation «продано за $Y»).
- **Pass-through edge** = переносит cost basis вдоль, не создавая и не
  реализуя его (cross-wallet transfer, CEX deposit/withdrawal с
  matched tx-hash, swap_from_token, lp_add/remove).

### Пропагация

WAC-пул на каждом ноде. При edge:

- Source → `pool.add(amount, costUsd, hasFiat=true)`
- Sink → `pool.remove(amount)` (cost basis exits)
- Pass-through → пропорциональная часть cost basis движется в target pool

### Текущий актив → cost basis

Для каждого amount в текущем portfolio (free balance + DeFi position
underlying) ищется в WAC-пуле соответствующего ноды. Если pool пустой
для нужного amount → unattributed (помечается, не extrapolate'ится).

### Методики выбора lot'ов

В пределах WAC pool — методика FIFO / LIFO / WAC (toggle глобальный
на uri, persist в localStorage). Для tax-grade отчётов нужен Specific
Identification — out of scope этой итерации.

## Принципы (locked)

1. **No silent extrapolation.** Если cost basis неизвестен — он
   неизвестен. UI показывает coverage% и unattributed-bucket, а не
   подменяет fake-цифрой `amount × current_price`.
2. **Single source of truth.** Один пайплайн UCB строит результат, и
   все производные метрики (PnL, доходность, IL, экспорт) читают его.
   Никаких параллельных «костыльных» расчётов.
3. **Provenance preserved.** Для каждого attributed-amount хранится
   цепочка событий «откуда $ пришли» — `[{source: P2P, exchange:
   bitget, time: …, fiatAmount: …}, {trade: USDT→BTC, time: …},
   {withdrawal: BingX→0x158b…, time: …}]`. Это базис для UI provenance
   trail и налогового аудита.
4. **Manual escape hatch.** Когда автоматика не нашла источник —
   пользователь может вручную задать cost basis: «эти 5 BTC куплены
   2024-01-15 за $30k» (как импорт CSV, или per-event annotation в
   Registry). Manual-annotation = source-edge с пометкой `source:
   manual`.
5. **Idempotent re-runs.** UCB-пересчёт по тем же данным даёт тот же
   результат. Никаких state-leak'ов между запусками.
6. **Source-tag привязан к точности.** Каждый cost basis помечается
   точностью: `fiat-direct` (был фиатный leg) > `fiat-stable`
   (приближение через стейбл) > `inherited` (пропагация через chain) >
   `unknown` (нет данных). UI цветами + tooltip даёт юзеру понять
   степень достоверности.

## Текущее состояние (на 2026-05-15, end of day)

Колонка «Фаза» показывает где запланировано закрытие пробела. ✅ — готово.

### Слой 1 — Сбор данных

| Источник | Покрытие | Фаза |
|----------|----------|------|
| On-chain EVM ops (DeBank) | ⚠ только в browser cache, теряется при reload | **B5** |
| On-chain Solana (Helius/Vybe) | ⚠ то же — browser cache | **B5** |
| CEX spot trades — API sync | ✅ chunked, 3-year lookback (B1.5, 2026-05-15) | — |
| CEX spot trades — CSV/XLSX import | ✅ Bybit + BingX parsers (B6, 2026-05-15) | — |
| CEX P2P | ✅ Bitget tax endpoint + manual / CSV для прочих | — |
| CEX deposits | ✅ chunked + per-coin iteration (B2/B2.5, 2026-05-15) | — |
| CEX withdrawals | ✅ chunked + per-coin (B2/B2.5, 2026-05-15) | — |
| CEX internal transfers (sub-accounts, Earn, Funding) | ❌ | **B3** |
| Manual purchases / annotation | ❌ только P2P fiat-leg | **A4** |
| Real permission probe | ✅ (B1.1, 2026-05-15) | — |
| Withdrawal fees breakdown | ⚠ amount stored как post-fee | **D1** |
| Historical FX (RUB/EUR → USD per date) | ❌ только USD-leg в P2P учитывается | **D2** |

### Слой 2 — Cost basis в изоляции

| Что | Покрытие |
|-----|----------|
| WAC tracker per on-chain wallet (FIFO/LIFO/WAC) | ✅ `cost_basis_tracker.ts` |
| CEX pool per account (P2P→trade→withdrawal) | ✅ `CexCostBasisService` |
| Position-level coverage (direct + cex inheritance + lp unwind) | ✅ `position_coverage.ts` (2026-05-15) |
| **Honest startUsd** (sum of attributed cost, не extrapolation) | ✅ B7 (2026-05-15) |
| Receipt-token underlying (aWBTC/cToken/GLV) integration with UCB | ⚠ работает для Aave/Compound, не для всех | **D3** |

### Слой 3 — Пропагация через границы (главный пробел)

| Граница | Покрытие | Фаза |
|---------|----------|------|
| wallet A → wallet B (cross-wallet transfer) | ❌ | **A1, A2** |
| on-chain wallet → CEX deposit (seeding pool) | ❌ | **C1** |
| CEX withdrawal → on-chain wallet | ✅ (2026-05-15) | — |
| CEX A → CEX B (через on-chain hop) | ❌ | **C2** |
| Manual annotation для произвольного transfer_in | ⚠ только для P2P | **A4** |
| Cycle-detection в графе | ❌ | **A3** |
| Wrapped tokens (ETH↔WETH↔stETH↔rETH) | ⚠ только WETH↔ETH normalize | **D4** |
| Cross-chain bridges (asset bridges between chains) | ❌ | **D5** |
| Yield / staking rewards classification | ❌ | **D6** |
| Lending borrow → net cost basis | ⚠ FIFO override считает, но не везде | **D7** |

### Слой 4 — UI

| Что | Покрытие | Фаза |
|-----|----------|------|
| Открытые позиции с startUsd | ✅ | — |
| Popup истории покупок underlying (расширен на CEX/LP, 2026-05-15) | ✅ | — |
| Honest cost basis в popup'е (без vrane extrapolation) | ✅ B7 (2026-05-15) | — |
| Registry — лента ops (per-wallet) | ✅ | — |
| **Single «Sync All» button** на CEX-карточке | ✅ (2026-05-15) | — |
| **Permissions diagnostic card** + Re-probe button | ✅ B1.4 (2026-05-15) | — |
| **CSV/XLSX trades importer** в карточке биржи (multi-file) | ✅ B6 (2026-05-15) | — |
| **Proxy tester** в Интеграциях | ✅ (2026-05-15) | — |
| Sync coverage report (data-gap observability) | ❌ | **B4** |
| Глобальная timeline (все источники в одном виде) | ❌ | **C3** |
| Provenance trail (chain «откуда $») | ❌ | **C4** |
| UCB pipeline orchestrator (1 source of truth) | ❌ | **C5** |
| Unified asset view (sum across wallets+CEX per asset) | ❌ | **E1** |
| Position breakdown page (полная страница, не popup) | ❌ | **E2** |
| PnL realized vs unrealized split | ❌ | **E3** |

## Roadmap (locked порядок работ): B → B5 → A → C → D → E → F

Каждая фаза разбита на нумерованные подзадачи. **Все ❌/⚠ из инвентаря
выше распределены по фазам** — UCB Complete достигается когда все они
закрыты.

**Что сделано 2026-05-15:** B1 (полностью включая B1.5 full-history
chunked + 720d cap для Bybit), B2 (chunked transfers), B2.5
(per-coin iteration для Bybit/BingX), B6 (CSV/XLSX import + multi-file
+ BingX timezone fix), B7 (UCB-correct honest startUsd), proxy tester,
Sync All button, position_coverage aggregator, applyCexInheritanceCostBasisOverride.

**В работе:** B3 (internal transfers), B4 (sync coverage report UI),
**B5 (next: server-side on-chain ops persistence)**.

### Gate: «UCB Complete»

UCB считается полностью реализованным когда:
- Слой 1 (сбор данных): все источники ✅, нет ⚠/❌
- Слой 2 (cost basis в изоляции): покрыто (сделано 2026-05-15)
- Слой 3 (пропагация): все границы ✅
- Слой 4 (UI): глобальная timeline + provenance trail ✅
- Слой Correctness (D-group): fees / FX / wrapped / bridges правильно tracking
- Слой UX (E-group): unified asset view + position breakdown + realized/unrealized PnL

До этого момента методология **работает частично** — производные
метрики (PnL/доходность) точны только в пределах покрытых случаев.
Эта оговорка должна быть видна юзеру в UI (warnings, coverage %).

---

### Этап B — Sync data integrity (фундамент)

**Цель:** закрыть все ⚠/❌ слоя 1. Без полных данных любая методология
бесполезна. Тест-канарейка: bob@example.com (POS-007 WBTC).

| # | Задача | Закрывает |
|---|--------|-----------|
| **B1** | CEX trades sync — диагностика причин 0 trades. Permissions UX: проверка permission перед sync, чёткий error «нужно включить Read Spot Trade History на бирже» с инструкцией. Re-issue API key flow без потери истории. | Слой 1: CEX spot trades ⚠ |
| **B2** | CEX deposits sync fix — на Bob BingX 0 deposits при 40 withdrawals. Расследовать: permission `withdraw=false` блокирует ли deposit history endpoint? Это bug в нашем CCXT-вызове? Покрыть тестами. | Слой 1: CEX deposits ⚠ |
| **B3** | CEX internal transfers (sub-accounts, Earn, Funding) — поддержка CCXT `fetchLedger()` для бирж где есть. Внутренние переводы — НЕ источник cost basis (asset не покидает биржу), но **важны для accounting**: без них pool может уйти в минус (Spot→Earn→Spot цикл) или не учесть откуда вернулся актив. | Слой 1: CEX internal transfers ❌ |
| **B4** | Sync coverage report UI — на каждом CEX-аккаунте чек-лист: «Trades ✅ 145 / Deposits ⚠ 0 / Withdrawals ✅ 40 / P2P ✅ 7 / Internal ❌ unsupported by exchange». С контекстными подсказками («чтобы trades появились — включите Read Spot Trade History и нажмите Sync»). | Новый — observability data-gaps |

**Definition of done для B:** на bob@example.com все 5 столбцов
зелёные/осознанно-серые (если биржа не поддерживает фичу), POS-007 WBTC
получает реальный cost basis от 0.176 WBTC withdrawal'ов с BingX через
chain trades которые мы наконец синканули.

---

### Этап A — Cross-wallet on-chain + manual annotation

**Цель:** закрыть ❌ слоя 3 в части on-chain↔on-chain и слоя 1 в части
manual purchases. Серверная часть не трогается, всё на клиенте.

| # | Задача | Закрывает |
|---|--------|-----------|
| **A1** | `cross_wallet_cost_basis_tracker.ts` — единый WAC-пул через все on-chain кошельки пользователя. Edge между кошельками через tx_hash match (transfer_out из A == transfer_in в B). Tests-first (vitest, как position_coverage). | Слой 3: wallet A → wallet B ❌ |
| **A2** | Интеграция в `PurchaseHistoryPopup` и `applyCexInheritanceCostBasisOverride` — теперь они учитывают cross-wallet purchases (ETH куплен в `lex 1`, перенесён в `lex 2` — `lex 2` видит правильный cost). | Слой 3 production wire |
| **A3** | Cycle-detection в cross-wallet графе — защита от A→B→A loops. | Слой 3 robustness |
| **A4** | Manual annotation API в Registry — per-event «куплено за $X» / «продано за $Y» / «получено в подарок без cost» для произвольного transfer_in/out. Серверная schema: `imported_operations` или `position_meta` extension. UI: action на каждом transfer_in в Registry → форма с amount/fiatAmount/fiatCurrency/date. | Слой 1: Manual purchases ❌ + Слой 3: Manual annotation ⚠ |

**Definition of done для A:** Bob может пометить «лежит ETH на `lex 2`,
куплен 2024-08 на Binance (не подключена) за $2,200» — и эта аннотация
видна в WAC popup'е и в `startUsd` всех позиций где этот ETH задействован.

---

### Этап C — Полный граф событий через все источники

**Цель:** закрыть последние ❌ слоёв 3 и 4. UCB end-to-end.

| # | Задача | Закрывает |
|---|--------|-----------|
| **C1** | On-chain → CEX deposit seeding. Server-side: `CexCostBasisService.applyDeposit` принимает payload `depositSeeds: {txHash: {asset, costPerUnit, source}}` от клиента. Если match по txHash найден — pool seedит этот cost. Клиент собирает seeds из cross-wallet tracker (этап A). | Слой 3: on-chain → CEX deposit seeding ❌ |
| **C2** | CEX A → CEX B через on-chain hop. Когда withdraw'ил с биржи A и через несколько минут депозит на бирже B — наша система объединяет это в логический «transit». Cost basis с CEX A seedит deposit на CEX B напрямую (без приземления в on-chain wallet). | Слой 3: CEX A → CEX B ❌ |
| **C3** | Глобальная timeline UI — отдельная страница `/timeline` (или вкладка) показывающая все события пользователя в едином хронологическом виде: on-chain swaps + cross-wallet transfers + CEX trades/P2P/transfers, с фильтрами по asset/source/date. Это «лента жизни» актива. | Слой 4: глобальная timeline ❌ |
| **C4** | Provenance trail UI — в карточке актива и в popup'е истории показывать chain: «0.176 WBTC ← BingX withdraw 28.09.25 ← BingX trade USDT→WBTC 28.09.25 ← BingX deposit USDT 26.09.25 ← lex 1 transfer_out USDT ← lex 1 swap ETH→USDT 22.09.25 ← lex 1 received from Bitget withdraw ← Bitget P2P RUB→USDT (90000₽)». Каждый шаг clickable → детали. | Слой 4: provenance trail ❌ |
| **C5** | UCB pipeline orchestrator — централизованный модуль `ucb_pipeline.ts` который собирает все источники (on-chain ops × CEX events × manual annotations), строит unified event graph, прогоняет WAC pools, выдаёт единый результат `{ assetCostBasis, provenance, coverage }`. **Все производные метрики читают только его** — нет параллельных расчётов. | Принцип «Single source of truth» из locked-принципов |

**Definition of done для C:** для любого актива в портфеле user видит
provenance trail до фиатной точки опоры (или до явной отметки
«unattributed»). PnL/доходность в любом виджете построены поверх
одного UCB-пайплайна.

---

### Этап B5 — Server-side on-chain ops persistence (между B и A)

**Цель:** перенести on-chain ops Bob'ских кошельков в `operations`
table на сервере, чтобы они **переживали reload** + не требовали
$$ DeBank credits на каждый refresh.

| # | Задача |
|---|--------|
| **B5.1** | Server-side `operations` repository — store classified on-chain ops с idempotent upsert per (wallet_id, tx_hash, log_index) |
| **B5.2** | Background sync job (BullMQ worker) — periodic refresh DeBank/Helius для каждого подключённого кошелька с rate-limit'ом |
| **B5.3** | Client-side: lazy-load ops из БД при `LoadedWalletsProvider` init → instant cost basis recompute между сессиями |
| **B5.4** | Delta-refresh: при ручном refresh wallet'а тянуть только новые ops (since last sync), не full reload (~95% DeBank-cost saving) |

**DoD для B5:** Bob открывает Capflow → POS-007/POS-008 cost basis
**мгновенно** виден без DeBank-pull, fresh ops добавляются delta-syncом.

---

### Этап D — Correctness (точность учёта)

Не блокирует UCB Complete, но **значимо искажает** реальные числа.
Каждый item — bug-source для конкретных позиций.

| # | Задача | Impact |
|---|--------|--------|
| **D1** | Withdrawal fees split: amount = что списали с pool, recipient = `amount - fee`. Pool removes amount, fee tracked отдельно. | Cost basis для withdrawal'а сейчас slightly inflated; для tax — потери |
| **D2** | Historical FX `RUB/EUR → USD` per date — для P2P-сделок без USD-leg. DefiLlama FX API или CBR XML. | Любая P2P-сделка в RUB сейчас даёт cost basis = $0 → unattributed downstream |
| **D3** | Receipt-token UCB integration — aTokens / cTokens / GLV / fVLT properly carry underlying cost basis through `lend_supply` ops. | POS-007 показывает 3.2% direct потому что `lend_supply` consume'ит underlying, и aWBTC pool не linked |
| **D4** | Wrapped tokens chain-aware — ETH↔WETH wrap, BTC↔WBTC, ETH↔stETH↔rETH unwrap. Cost basis 1:1 при wrap. | Wrap/unwrap on-chain ломает chain в Слое 3 |
| **D5** | Cross-chain bridges — same asset on different chains должен сохранять cost basis. Match по tx-hash / bridge protocol events. | Любая позиция на BSC/Polygon/Arbitrum где asset был bridged — cost basis потерян |
| **D6** | Yield/staking rewards classification — `received_as_reward` flag вместо `received_as_purchase`. Cost basis = 0 (or market spot для tax), но classified отдельно. | Сейчас reward смешивается с purchases в pool |
| **D7** | Net cost basis для lending с borrow — supply_cost − borrow_received. Если user взял $5k под залог $10k WBTC, net = $10k − $5k. | Aave с долгом показывает inflated startUsd |
| **D8** | Manual corrections / soft-delete UCB-aware — user пометил «эта транзакция ошибка» → UCB recalc downstream. | Без этого нет способа исправить data quality |
| **D9** | Historical price fallback для unattributed — если cost basis невозможно установить (airdrop, gift), spot price на дату = best approximation, помечен `source: spot-fallback`. | Airdrop'ы сейчас сидят с cost 0 |

---

### Этап E — UX-долг (фундаментальные UI views)

| # | Задача |
|---|--------|
| **E1** | **Unified asset view** — для каждого asset agg sum across wallets+CEX. Не by-source как сейчас. «У вас 9.5 ETH: 0.21 BingX + 0.05 Bybit (spot) + 9.24 в Aave V3» с единым cost basis. |
| **E2** | **Position breakdown page** — full page (не popup) для деталей позиции с graph cost basis, history, scenarios |
| **E3** | **PnL realized vs unrealized разделение** — два числа явно: реализованная прибыль (sells) и нереализованная (mark-to-market). |

---

### Этап F — Operational stability

| # | Задача |
|---|--------|
| **F1** | API сервер production deploy — daemon под supervisord/pm2, не tsx-watch который умирает с сессией. Auto-restart, log rotation. |
| **F2** | Onboarding flow — wizard для нового user: подключить wallet → подключить CEX → permissions check → sync → первая позиция. |
| **F3** | «Health check» dashboard — для admin/себя: sync OK per user? data freshness? errors? coverage %. |

---

### Этап Tax (после UCB Complete + D-group)

Out of scope текущего roadmap, но зафиксировано:
- **T1** Экспорт ledger в форматах для tax-tools (Koinly / CoinTracker / Cointelli)
- **T2** Specific Identification UI (выбор конкретных lots при продаже)
- **T3** Per-jurisdiction правила (Россия 13% / EU MiCA / US 1099-B)
- **T4** Multi-currency reporting (RUB/EUR/USD switching, PnL в любой валюте)
- **T5** Audit log of cost basis recalcs (compliance)
- **T6** Performance optimization (1000+ trades user-case, server-side compute)

## Альтернативы

### Параллельные cost-basis-расчёты per-feature

**Отвергли**: каждый раз когда добавляется новая метрика (доходность,
IL, tax report), копировать cost-basis-логику. Приводит к
расхождениям между виджетами, дикому maintenance, багам.

### Snapshot-based вместо ledger-based

**Отвергли**: считать cost basis по периодическим снапшотам портфеля.
Не работает для DeFi — slippage, IL, fees внутри позиции теряются.
Ledger (event-stream) — единственный честный путь.

### Tax-grade Specific Identification сразу

**Отложили**: требует UI для ручного выбора lot'ов на каждый sell-event.
Сделаем после того как FIFO/LIFO/WAC + provenance закроют 95% кейсов.

## Реализация (текущая база)

- `apps/web/src/lib/portfolio/cost_basis_tracker.ts` — per-wallet WAC
- `apps/web/src/lib/portfolio/position_coverage.ts` — coverage aggregator
- `apps/web/src/lib/portfolio/cex_inheritance_cost_basis_override.ts` — startUsd override
- `apps/web/src/lib/portfolio/purchase_history.ts` — события на актив
- `apps/api/src/modules/cex/cex.cost-basis.service.ts` — CEX-pool
- `apps/web/src/components/PurchaseHistoryPopup.tsx` — UI

Тесты: `apps/web/src/lib/portfolio/*.test.ts` (vitest, 41+ кейсов).

## Ограничения

- FIFO/LIFO/WAC — не покрывает tax-grade Specific Identification
- Историческая FX (RUB/EUR → USD на дату) пока без feed — `fiat-direct`
  только для USD; для RUB-P2P без feed остаёмся в `inherited`
- Cycle-detection в графе ещё не реализован — циклические трансферы
  user-у могут давать счётчик-уход cost basis
- Manual annotation: scope only P2P сейчас; расширение на arbitrary
  transfer_in — этап A

## Связанные решения

- [cost-basis-architecture.md](cost-basis-architecture.md) — 5-уровневый
  фреймворк (lots/positions/protocols/wallet/global) — этот доку
  частично suspended в пользу UCB; lots-level сохраняем как leaf-storage
- [lp-cost-basis.md](lp-cost-basis.md) — частный случай для LP-unwind
- [receipt-token-cost-basis.md](receipt-token-cost-basis.md) — частный
  случай для GLV/aToken
- [v3-etherscan-cost-basis.md](v3-etherscan-cost-basis.md) — частный
  случай для Uni V3 NFT
- [cex-integration-ccxt.md](cex-integration-ccxt.md) — серверная база
  для CEX-источников

Все они должны вписываться в UCB как **частные случаи универсального
графа**, не дублировать общую логику.
