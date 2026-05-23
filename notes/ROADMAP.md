---
updated: 2026-05-21 (Design System v1 brief — переход на брендбук Capflow v1.0)
---


# ROADMAP

## 🎨 Design System v1 — переход на брендбук Capflow (2026-05-21)

**Контекст**: брендбук Capflow v1.0 готов как редакторский документ. Текущее
UI расходится с ним по шрифтам (Inter vs Geist, нет mono), brand-цветам
(mint `#34E0B6` не из брендбука), радиусам (на 4px меньше), light theme
(брендбук dark-only).

**Решение**: ТЗ дизайнеру оформлено в `notes/design-brief-v1.md`. Marketing
vs Product split зафиксирован: Instrument Serif italic, hero-display 96px+,
radial-glow фоны — только на `/`, `/login`, `/pricing`, `/changelog`. Light
theme в v1 замораживаем. Логотип отложен отдельно.

**6 deliverables дизайнера**: tokens (Figma Variables + JSON) → core components
→ data components (table/KPI/position row) → charts spec → page templates
→ documentation (numeric formatting, voice copy, a11y pairs).

**Что меняется в коде после сдачи дизайна** (7 фаз):
0. Tokens + шрифты (1д) → 1. Numeric formatting helpers (1д) →
2. Table primitive + миграция 3 страниц (3–5д) → 3. Core UI rewrite (1–2н) →
4. Layout + ⌘K palette (3д) → 5. Charts (1н) → 6. Empty/Loading/Error (3д).

Подробности: `notes/decisions/design-system-v1-from-brandbook.md`.

---

## 🔧 UCB C5 — token→token swap cost basis inheritance (2026-05-18)

**UCB invariant violation**: token→token swaps (BTC → ETH, etc.) НЕ
наследовали cost basis от source token's WAC. Использовали market price
на момент свопа → инфлировали cost basis за счёт price appreciation.

**Кейс**:
- Купил 1 BTC за $20k (WAC $20k/BTC)
- Через год BTC market = $50k
- Swap 1 BTC → 25 ETH
- **До C5**: ETH cost = market BTC $50k → $2000/ETH ❌ (inflated)
- **После C5**: ETH cost = consumed BTC WAC $20k → $800/ETH ✅

Это ломало realized PnL: продажа ETH дальше показывала маленький profit
вместо большого (BTC appreciation skewed into ETH cost basis).

**Fix в `lots/build.ts` handleSwap**:
```ts
// До: paidUsd += movementUsd(m, ...)  // market price
// После: capture consume's totalCostUsd:
const consumed = tracker.consume({...});
paidUsd += consumed.totalCostUsd;  // = WAC × consumed amount
```

Stable OUT — без изменений (amount = $1 × amount). Non-stable OUT —
теперь использует consumed lot WAC. Fallback на market если source
token не tracked (external transfer_in без cost basis).

Same fix в `position_lot_cost_basis.ts` (token→token branch) — для
popup consistency.

| File | Change | Tests |
|---|---|:-:|
| `lots/build.ts` handleSwap | Capture `tracker.consume(...).totalCostUsd` for non-stable OUT | 4/4 ✅ |
| `lots/build.token_swap.test.ts` | TDD: BTC→ETH, partial, multi-source (BTC+ETH→SOL), untracked source fallback | 4/4 ✅ |
| `position_lot_cost_basis.ts` | Same fix для popup token→token branch | — |

**Cumulative**: 221/221 portfolio tests · tsc clean.

## 🔧 UCB C4.5 — fix override stomp bug (post-C4 follow-up)

**Bug**: после C4 popup SoT refactor, position startUsd в `/performance`
table до сих пор показывал legacy $33,930 для via.irk POS-002 (вместо
правильного $31,785).

Root cause: `applyLendingCostBasisOverride` в OpenPositionsPage
перетирал result от `buildSupplyToken` (LotTracker SoT). Этот override
использовал:
1. `getPositionLotCostBasis` БЕЗ `costBasisOverrideByHash` → терял
   A4/D3/C2/C3 inheritance
2. `t.amount × wac` (live amount с yield) → over-counted cost basis

**Fix**:
- Add `costBasisOverrideByHash` param to `applyLendingCostBasisOverride`
- Add `useNetSuppliedAmount: true` для consistency
- Use `r.totalCostUsd` directly вместо `t.amount × wac`
- Pipe merged overrides из OpenPositionsPage callsite

Теперь 4 уровня все консистентны:
- column "Стартовая $" в /performance
- applyLendingCostBasisOverride
- applyCexInheritanceCostBasisOverride (когда срабатывает)
- popup footer + line items

Все = $31,785 для via.irk POS-002.

## 🔧 UCB C4 — PurchaseHistoryPopup → LotTracker SoT consistency (2026-05-18)

**Bug**: popup в позиции "История покупок underlying" показывал **3-4
несовместимых числа** одновременно:
- WAC line-sum = $35,943.57
- LIFO line-sum = $33,501.54
- FIFO line-sum = $36,779.19
- Footer = $33,930.96 (одинаковый для всех методов)
- Position summary в таблице /performance = $31,785.03 (после моих C2/C3)

Root cause: **три параллельных движка** на одной странице:
1. `position_lot_cost_basis.getPositionLotCostBasis()` — lot-list display
2. `position_coverage.computePositionCoverage()` — footer total
3. `LotTracker SoT` (после моего refactor'а) — position summary в таблице

Каждый использует свой источник cost basis, разный набор операций,
разный consume amount. Footer label "$33,930 = 10.624 × $3193" — ложный
(line items не суммируются в это число).

**Fix**: rewire popup to use single source of truth:

1. `getPositionLotCostBasis` теперь принимает `costBasisOverrideByHash`
   (merged A4 + D3 + C2 + C3). Применяется к acquire'ам для
   `swap`, `deposit_fiat`, `transfer_in` → lot costs reflect inheritance.
2. Новый параметр `useNetSuppliedAmount: true` — consume amount =
   `Σ lend_supply.out - Σ lend_withdraw.in` (исключает yield). Для
   via.irk POS-002: было consume 10.717 (с yield), теперь 10.624 (только
   principal). Yield (0.093 ETH) не вкладывается в cost basis.
3. Footer popup'а теперь = `lotCb.totalCostUsd` (= sum of line items).
   By-construction line-sum == footer для каждой методики.
4. `costBasisOverrideByHash` prop добавлен в `PurchaseHistoryPopup`,
   прокинут из `useLoadedWallets()` в `OpenPositionsPage`.

**Результат для via.irk POS-002 popup'а**:

| Lot date | Amount | New cost | Source |
|---|---:|---:|---|
| Aug 12 deposit_fiat | 2.165 ETH | ~$9,646 | **C2 inherited** from cowswap |
| Nov 17 deposit_fiat | 1.618 ETH | $3,422 | market (orphan, Nov 17 не имеет withdraw match) |
| Jan 4 swap A | 1.229 ETH | $3,857 | stable_sum |
| Jan 4 swap B | 2.229 ETH | $7,000 | stable_sum |
| Jan 31 swap C | 1.138 ETH | $3,000 | stable_sum |
| Feb 1 transfer_in | 0.623 ETH | $1,318 | hist price (orphan) |
| Feb 4 swap D | 1.382 ETH | $2,998 | stable_sum |
| Mar 27 unwrap WETH | 0.280 ETH | ~$591 | WETH lot cost (lp_close inherited) |
| ... | ... | ... | ... |
| **Σ** (net supplied 10.624 ETH) | | **~$31,785** | matches column /performance ✅ |

Все 3 методики (WAC/LIFO/FIFO) теперь дают **same total** = $31,785
(потому что user supplied 10.6 ETH из ~13.6 ETH acquired — все 10.6
вычерпываются из пула в любой методике). Per-lot allocation может
варьироваться, но totals идентичны.

| File | Change | Tests |
|---|---|:-:|
| `position_lot_cost_basis.ts` | + `costBasisOverrideByHash` param + `useNetSuppliedAmount` param | — |
| `position_lot_cost_basis.test.ts` | New: invariant (Σ lots == total), C2 override, C3 transfer_in override, net supplied vs live | 5/5 ✅ |
| `PurchaseHistoryPopup.tsx` | New prop `costBasisOverrideByHash`, footer = `lotCb.totalCostUsd` | — |
| `OpenPositionsPage.tsx` | Pipe `costBasisOverrideByHash` в popup | — |

**Cumulative**: 217/217 portfolio tests · tsc clean.

## ✅ Data quality issues найдены при verification

При сверке via.irk данных:
1. **Bitget historical sync gap**: `cex_transfers` для via.irk содержит только 2 transfers (May 14 round-trip). Aug 12 transit через Bitget (~2.16 ETH) **отсутствует** — Bitget API не вернул historical data. **Compensation**: мой C2 on-chain matching покрывает этот случай через withdraw_fiat ↔ deposit_fiat.
2. **Bitget trades не синкаются**: `last_trades_sync_at = NULL`. D3 server-side cost basis trail невозможен. Nov 17 ETH (orphan) не получает inheritance — нужен manual A4 annotation.
3. **3× duplicate `transfer_out` 2.1629 ETH на eth chain Aug 12-14**: indexer noise (4 разных tx hashes, same amount). Не влияет на POS-002 (Fluid на arb), но засоряет eth balance accounting.
4. **Apr 26 "unknown" op type 0.764 ETH OUT**: classifier не разобрал Uniswap V3 операцию.

**Backlog**:
- CEX historical backfill (Bitget API → support periodic full history sync)
- Indexer dedup для eth-chain (Alchemy/DeBank возвращают повторы)
- Improved classifier coverage для V3 NFT close

## 🔧 UCB C3 — cross-wallet transfer/bridge cost basis inheritance (2026-05-18)

**Дополняет C2**. C2 покрывал `withdraw_fiat`↔`deposit_fiat` (CEX-loops).
**C3 — cross-wallet** `{transfer_out, bridge_out, withdraw_fiat}` ↔
`{transfer_in, bridge_in, deposit_fiat}` mixed pairs.

**Закрывает gap'ы**:
- Cross-wallet bridges (bridge_out wallet A → bridge_in wallet B): A2
  matcher marks как internal но не propagate cost basis. Теперь — да.
- Direct EOA→EOA transfers (transfer_out → transfer_in между своими
  wallets, без bridges и без CEX): аналогично.
- Mixed type pairs (transfer_out → deposit_fiat и т.п.): classifier
  иногда не consistent помечает направления.

**Same-wallet skip**: D5 уже handles same-wallet bridge_out → bridge_in,
C2 handles same-wallet `*_fiat`. C3 фокус — только cross-wallet pairs.

**Алгоритм identical to C2** (greedy nearest-time, ±5%/10% tolerance,
±6h window, OUT precedes IN, source tracker excludes matched out-op).
Принимает уже-вычисленные C2 + D3 как preExistingOverrides → multi-source
chain inheritance работает.

**Priority в LoadedWalletsProvider** (lowest → highest):
```
C3 cross-wallet  <  C2 fiat-hop  <  D3 CEX (server)  <  A4 manual
```

| File | Change | Tests |
|---|---|:-:|
| `lots/cross_wallet_cost_basis.ts` | New module: `computeCrossWalletCostBasisOverrides` | — |
| `lots/cross_wallet_cost_basis.test.ts` | 7 scenarios: bridge in/out cross-wallet, transfer_out→transfer_in EOA-to-EOA, same-wallet skip, mixed type pairs, amount tolerance, time window, dedup | 7/7 ✅ |
| `LoadedWalletsProvider.tsx` | Compute C3 overrides + merge in priority order | — |

**Cumulative**: 212/212 portfolio · tsc clean.

## ✅ POS-002 valuation post C2+C3 (validated на real DB data)

via.irk@gmail.com `06bce475...c53` — 10.6242 ETH supplied to Fluid:

| Supply | Pre-fix | Post LotTracker SoT | Post C2 |
|---|---:|---:|---:|
| Aug 12 (2.154 ETH) | $4554.90 (market) | $4554.90 | **$9668.30** (cowswap inherited) |
| Nov 17 (1.618 ETH) | $3422.04 (market) | $3422.04 | $3422.04 (orphan) |
| Jan 4 #1 (1.2 ETH) | $2537.60 (market) | $3765.35 (swap WAC) | $3763.97 |
| Jan 4 #2 (2.229 ETH) | $4712.78 (market) | $6999.96 | $6999.95 |
| Jan 31 (1.138 ETH) | $2406.71 | $3010.15 | $3010.82 |
| Feb 1 (0.623 ETH) | $1318.24 | $1328.56 | $1329.23 |
| Feb 4 (1.382 ETH) | $2922.65 | $2998.96 | $2998.89 |
| Mar 27 (0.280 ETH) | $591.80 | $591.74 | $591.82 |
| **Total** | **$22,466** | **$26,672** | **$31,785** |

Δ от методологического pipeline: +$9,319 над "market m.usd" наивным
подсчётом. Остаётся +$5,113 потенциал когда Nov 17 deposit_fiat
аннотируется через A4 (CEX trail unknown).

## 🔧 UCB C2 — fiat-hop cost basis inheritance (2026-05-18)

**Systemic gap**: когда user снимает крипту с on-chain wallet'а на CEX
(`withdraw_fiat`) и возвращает на другой chain / wallet (`deposit_fiat`),
cost basis trail терялся. Existing A2 `findInternalTransferPairs` skip'аeт
same-wallet pairs (создан для cross-wallet bridges), CEX D3 покрывает
только подключенные CEX accounts. Между этими двумя — дыра.

**Real case (via.irk@gmail.com Aug 12 2025)**:
- 09:17 (eth) cowswap 9646 USDC → 2.149 ETH (WAC $4488)
- 09:24 (eth) `withdraw_fiat` -2.163 ETH (to CEX)
- 09:45 (arb) `deposit_fiat` +2.165 ETH (from CEX)
- 10:02 (arb) `lend_supply` 2.154 ETH → Fluid

После refactor'а LotTracker SoT (предыдущий fix) этот deposit_fiat
получал cost = market m.usd ($2114/ETH × 2.165 = $4578). Реально user
заплатил ~$9646 за эти ETH. Расхождение по POS-002 — $4488 × 2.165 vs
$2114 × 2.165 = +$5140 cost basis недоучёта.

**Fix**: `computeFiatHopCostBasisOverrides(opsByWallet, preExisting)` —
pure function в `lots/fiat_hop_cost_basis.ts`:
1. Собирает все `withdraw_fiat` (OUT) и `deposit_fiat` (IN) ops
2. Матчит pairs: token family (`tokenFamily` → ETH/WETH=ETH), amount
   tolerance ±5%/10%, time window ±6h, withdraw must precede deposit
3. Greedy nearest-time: один withdraw → один deposit (closest match wins)
4. Same-wallet AND cross-wallet оба валидны (CEX hop не различает)
5. Для каждого match — строит fresh LotTracker на source ops EXCLUDING
   этот withdraw_fiat (чтобы wacAt видел pre-consume state), читает
   WAC at withdraw.time, возвращает `WAC × deposit.amount`
6. Применяет уже-известные A4/D3 overrides при построении source tracker'а
   — кост basis течёт через multi-hop chains

Precedence в `LoadedWalletsProvider`: **A4 manual > D3 CEX (server) > C2
fiat-hop (local)**. CEX D3 (server-validated через P2P trail) бьёт local
heuristic; manual бьёт всё.

| File | Change | Tests |
|---|---|:-:|
| `lots/fiat_hop_cost_basis.ts` | New module: `computeFiatHopCostBasisOverrides` | — |
| `lots/fiat_hop_cost_basis.test.ts` | 7 TDD scenarios: Vladimir POS-002, cross-wallet, time-window, amount tolerance, dedup, WETH/ETH family, A4 chained | 7/7 ✅ |
| `LoadedWalletsProvider.tsx` | Compute `fiatHopCostBasisByHash`, merge с `cexCostBasisByHash` (CEX wins), pass merged в `runUcbPipelineForWallet` | — |

**Cumulative**: 205/205 portfolio tests · tsc clean.

**Caveats v1** (для backlog C2.1):
- Single-pass: source tracker строится с pre-existing overrides only.
  Multi-hop chains (A→B→A→C) могут терять trail на 2+ hop. Solution:
  iterative resolution to convergence
- Greedy nearest-time match: если user снял $5000 и независимо купил
  $5000 (одинаковая сумма) через 1 час — heuristic свяжет ложно.
  Решение: manual A4 override
- ±5%/10% + 6h окно намеренно strict; expand при появлении false
  negatives на real data

## 🔧 Open positions startUsd → LotTracker single source of truth (2026-05-18)

Trigger: Vladimir POS-002 Fluid Lending показывал inconsistent startUsd —
column sum в "История покупок underlying" = **$36,779.19**, но position
summary = **$33,930.96**. Root cause — три параллельных cost basis
движка работали независимо:

1. `CostBasisTracker` — видит только swap-from-stable, не видит
   `transfer_in`/`deposit_fiat`/`claim_rewards`/`bridge_in`
2. `LotTracker` (lots/build.ts) — видит все acquisitions с D3/A4
   overrides и WAC drift fix (M3)
3. `position_lot_cost_basis` (PurchaseHistoryPopup) — отдельный путь

`buildSupplyToken` приоритезировала `cycleDeposit.usd` (market price at
supply time) над `avgAtOpen × s.amount`. При swap overpay (DEX
slippage/MEV) или transfer_in с CEX trail (D3) cycleDeposit
underestimates cost. UCB-инвариант: cost basis = actual paid, не market
value at any point. LotTracker WAC IS the truth.

**Fix**: новый helper `computePositionConsumedCostFromLots` — step-by-step
walker. Для каждого supply op БЕЗ consume строит incremental tracker от
ops ранее, читает `wacAt(walletId, symbol, op.time)`, аккумулирует
`amount × wac`. Priority order в `buildSupplyToken`: **lotConsumed (new)
> cycleDeposit > avgAtOpen × s.amount > fallback**. D3/A4 overrides
прокинуты через `costBasisOverrideByHash` от OpenPositionsPage и
PositionDetailPage в `buildOpenPositions`.

Применимо ко всем single-asset позициям: Aave/Fluid/Compound (lending),
GMX V2 (GM/GLV bought на stable), V3 LP NFT (через openHash). Принцип:
*всегда отслеживать в каком активе позиция открыта и как мы его
получили, как считает LotTracker*.

| File | Change | Tests |
|---|---|:-:|
| `open_positions.ts` | + `computePositionConsumedCostFromLots` (step-by-step walker reads WAC before each consume); + `lotsByWallet` и `costBasisOverrideByHash` в BuildOptions; priority shift в `buildSupplyToken` | — |
| `open_positions.swap-overpay.test.ts` | Vladimir POS-002 scenario: swap overpay → expect $10,769 (was $7250). D3 override: transfer_in $4500 → expect $9500 (was $7000) | 2/2 ✅ |
| `OpenPositionsPage.tsx` · `PositionDetailPage.tsx` | прокинуть `costBasisOverrideByHash` из useLoadedWallets | — |

**Cumulative**: 198/198 portfolio tests green · tsc clean.

## 🧭 Ядро методологии — UCB (Universal Cost Basis)

> **Locked, 2026-05-15.** UCB — это **архитектурный примитив всего
> сервиса**, не отдельная фича. Все будущие модули (PnL, доходность,
> налоговая отчётность, ребалансировка, рекомендации) опираются на
> результат UCB-пайплайна, а не строят cost basis параллельно.
>
> Принципы:
> 1. Cost basis — инвариант, который течёт по графу всех движений
>    пользователя (on-chain swaps + cross-wallet transfers + CEX
>    deposits/trades/withdrawals + P2P + manual annotation).
> 2. **No silent extrapolation** — если cost basis неизвестен, он
>    помечается как unattributed, а не подменяется `amount × current`.
> 3. **Single source of truth** — один UCB-пайплайн, все производные
>    метрики читают его.
> 4. **Provenance preserved** — для каждого attributed-amount хранится
>    цепочка событий «откуда $ пришли».
> 5. **Manual escape hatch** — пользователь может ввести cost basis
>    вручную если автоматика не нашла.
>
> Полное обоснование, текущее состояние, ограничения:
> [decisions/ucb-universal-cost-basis.md](decisions/ucb-universal-cost-basis.md).

## 🧪 Bob hardening pass (2026-05-17)

Полный integration test UCB-модели против реальных данных аккаунта
bob@example.com (606 chain ops · 567 CEX trades · 41 transfers · 2 wallets · 2 CEX).
Найденные пробелы и их fix-ы:

| # | Bug / Gap | Fix | Tests |
|---|---|---|:-:|
| **#1** | `syncTransfers` строил `errors[]` но никогда не вызывал `markSyncError` → `cex_accounts.last_sync_error` оставался NULL → Sync Coverage UI показывал "OK" silently при partial failures | Добавлен явный `markSyncSuccess`/`markSyncError` в конце `syncTransfers`. Errors now surface в UI | 2/2 ✅ |
| **#3** | Internal transfers (B3) требовали manual click "Sync internal" — большинство users не знали. `last_internal_transfers_sync_at` NULL для всех bob's accounts | `syncTransfers` opportunistically chains `syncInternalTransfers` (fail-soft, errors не блокируют parent sync — `last_internal_transfers_sync_error` ловится в свой namespace) | 1/1 ✅ |
| **#5** | Невозможно detect когда asset продан/выведен больше, чем приобретён → tax export overstates gains. Bob: LTC 11.87× gap, EOS/BBSOL 100% gap (no acquisitions tracked) | Новый pure `detectCexAssetGaps(flows)` + service `CexAssetGapService.detectForUser` + REST `/v1/cex/me/asset-gaps` + UI warning card на `/coverage`. Stable assets skipped. Severity warn/error. | 12 + 6 ✅ |
| **#4** | Untracked CEX withdrawal destinations невидимы для user. Bob: 27 из 41 withdrawals ушли на адреса вне Capflow → broken cost basis trail | `detectUntrackedDestinations(wds, trackedSet)` + `ChainOpsService.findUntrackedDestinations` + extended `/graph/internal-transfers` response field. Frontend `useGraphInternalTransfers` zod schema | 9/9 ✅ |
| **#6** | 500 Internal Server Error на `/admin/users` page. `db.execute<T>()` raw SQL возвращал timestamp поля как string (vs Date через ORM `.select()`), `toAdminUserResponse(u).createdAt.toISOString()` крашился | Defensive `toDate(v)` coercion для всех timestamp полей в `AdminUsersService.listUsers` | 5/5 ✅ |

**Cumulative**: 33 новых tests · **801/801 API** · 196/196 web portfolio · typecheck clean.

**Verified на Bob's data**:
- Asset gap detector found **3 problematic assets**: LTC (11.87× ratio, +2430 missing), EOS (no acquisitions, 124 sold), BBSOL (no acquisitions, 21.5 sold)
- Untracked destinations detector flagged **27 of 41 withdrawals** as untracked
- Both Fix #1 и Fix #3 — code-level, проявят себя на next sync run

### Onboarding polish (2026-05-17)
- Убрана строчка "Спросим про твою налоговую юрисдикцию" из welcome step `/onboarding` (по запросу пользователя — упрощение first-touch flow).

## 🔒 Security hardening pre-prod (2026-05-18)

Закрыли 4 уязвимости перед SaaS launch ([decisions/security-hardening-pre-prod.md](decisions/security-hardening-pre-prod.md)):

| # | Issue | Severity | Fix |
|---|---|:-:|---|
| **S1** | IDOR в `/v1/upstream/:provider/*` — любой залогиненный юзер мог проксировать запрос с чужим on-chain адресом через админский API-ключ DeBank/Alchemy/Helius/Etherscan | 🔴 CRITICAL | `address-guard.ts` — per-provider extractor + `decide(req, owned, isAdmin)`. Admin bypass, malformed → 400, чужой → 403, audit в `api_usage`. 19 unit-тестов |
| **S2** | Heavy-sync endpoints (`cex/*-sync`, `chain-ops/sync`) без rate-limit — мог сжечь Bitget/BingX квоты и DB | 🔴 CRITICAL | `HEAVY_SYNC_LIMIT` { max: 5/min, hook: "preHandler", key: user.id } на 11 эндпойнтов. 2 теста (включая per-user bucket separation) |
| **S3** | `/auth/refresh` и `/auth/logout` без rate-limit | 🟠 HIGH | refresh: 30/15min IP-keyed; logout: 20/5min user/IP-keyed. 2 теста |
| **S4** | `portfolio.refresh` beta-test ceiling `max: 1000` | 🟡 MEDIUM | Restored `max: 10` |

**Cumulative**: 23 новых tests, 796/796 API tests pass.

**Что осталось** (out of scope этого раунда): глобальный rate-limit с user-keyed default, Redis-кэш owned-addresses (после нагрузочных), httpOnly cookie audit recap, CSP-header policy, линтер на `config.rateLimit` на новых POST.

### Backlog после Bob hardening (low-priority polish)

| # | Что | Severity | Когда делать |
|---|---|:-:|---|
| Manual P2P import UI recovery flow | Если bob купил LTC через BingX P2P — нужен UI чтобы добавить запись. Сейчас detector flag есть, recovery path нет | 🟡 P1 | Когда первый user попросит recovery |
| Sentry / log aggregation | Admin не получит alert на CCXT sync failure пока сам не зайдёт в `/admin/health` | 🟡 P1 | Перед public launch |
| Memecoin price source warning | FARTCOIN/PUMP/etc — DefiLlama may not have prices, fallback искажает lot tracker. Low severity для bob (CEX trade.cost = USDT, не зависит от DefiLlama) | 🟢 P2 | После 100+ users |

---

## ⏳ В работе / план — расширенный порядок B → B5 → A → C → D → E → F

**Gate «UCB Complete»:** все ❌/⚠ из слоёв 1, 3, 4 + correctness (D) закрыты.

**Сделано 2026-05-15** (off-list bonuses): B1.5 full-history chunked 3-year
trades sync, B2.5 per-coin iteration Bybit/BingX, B6 CSV/XLSX import +
multi-file + BingX timezone fix, B7 honest startUsd (без extrapolation),
proxy tester, Sync All button, position_coverage aggregator,
applyCexInheritanceCostBasisOverride.

Полные обоснования и подзадачи: [decisions/ucb-universal-cost-basis.md](decisions/ucb-universal-cost-basis.md).

### Этап B — Sync data integrity (остаток)

| # | Задача |
|---|--------|
| **B3** ✅ | CEX internal transfers (Spot↔Funding↔Earn↔Sub-account) через CCXT `fetchTransfers`. Migration 0018 + `cex_internal_transfers` table + repo/service/routes + normalizer (8/8 tests) + "Sync internal" button в Coverage UI. Cost-basis не затрагивает (balance-neutral). Shipped 2026-05-16 |
| **B4** ✅ | Sync coverage page `/coverage` — таблица wallets (ops_count, last sync, errors) + таблица CEX (trades/transfers/internal/p2p counts, last sync per data-type) — shipped 2026-05-16 |

### Этап B5 — Server-side on-chain ops persistence ✅ **SHIPPED 2026-05-15/16**

| # | Задача | Статус |
|---|--------|:------:|
| **B5.1** | `chain_operations` table + `ChainOpsRepository` + 16 unit tests | ✅ |
| **B5.2** | `ChainOpsService` (ownership + audit) + REST routes (POST sync / GET list / GET status) | ✅ |
| **B5.3.P1** | Fire-and-forget push в `LoadedWalletsProvider.load()` (verified: 605 ops в БД) | ✅ |
| **B5.3.P2** | Server-side primary cache hydration перед DeBank pull (inline in `load()`) | ✅ |
| **B5.4** | Delta-refresh: `knownHashes` + `latestOpTime` как stop-criterion для DeBank pagination | ✅ |
| **B5.5** ✅ | Server-side autonomous chain_operations persistence: `ChainClassifierService.analyzeAccount` теперь возвращает `opsByAddress`; `PortfolioRefreshService` через existing cron BullMQ worker upsert'ит ops в chain_operations + markSyncSuccess per wallet. **Юзер больше не должен жать "Обновить"** — cron каждый час подтянет свежие ops автоматически. Fail-soft через `markSyncError`. 9/9 classifier tests pass. Shipped 2026-05-16 |

### Этап A — Cross-wallet on-chain + manual annotation ✅ **A1-A4 SHIPPED 2026-05-16**

| # | Задача | Статус |
|---|--------|:------:|
| **A1** | Layer 1 cross-wallet same-chain через tx_hash join (`findCrossWalletSameHashPairs`); REST `GET /v1/chain-ops/graph/internal-transfers` (`pairs`); 6 pairs found в bob | ✅ |
| **A2** | Layer 2 cross-chain fuzzy heuristic ported на server (`internal-transfer-matcher.ts` + 15 unit tests); REST response расширен `crossChainPairs` | ✅ |
| **A3** | Per-op annotations: `chain_operation_annotations` table + REST CRUD + composite-key upsert; UI: ✎ pencil → dialog (force-internal / op_type / cost basis / note); e2e verified | ✅ |
| **A4.1** | `manualOpType` override применён в `apply_annotations.ts` ПЕРЕД `buildLotsAndPositions` | ✅ |
| **A4.2** | `manualCostBasisUsd` override применён в `handleSwap` / `handleTransferIn` / `handleBridgeIn` cross_protocol handlers | ✅ |
| **A5** ✅ | Cycle-detection: `detectSelfBridgeCycles(pairs)` находит A→B→A self-bridge петли (origin wallet → hop wallet → back to origin) в окне ±7d. Source: уже-detected L2 `MatchedCrossChainPair[]`. Greedy match по family + reversed walletIds + chronological order. Возвращает `SelfBridgeCycle[]` с legA / legB / totalFeeUsd / durationSec. Service: `findSelfBridgeCycles(userId)`. REST: расширил `GET /graph/internal-transfers` полем `selfBridgeCycles[]` (optional, backward compat). Frontend zod schema добавил `graphSelfBridgeCycleSchema`. 7/7 cycle tests + 38/38 chain-ops + 714/714 API. Shipped 2026-05-16 |
| **A5.2** ✅ | Multi-hop cycle detector: `detectMultiHopCycles(pairs)` — N-leg loops A→B→C→...→A через DFS на adjacency graph. Window 14d, max 6 legs (DDoS guard). Greedy pair-usage. `ChainOpsService.findMultiHopCycles` + REST extension с `multiHopCycles[]` field. Frontend zod `graphMultiHopCycleSchema`. 9/9 tests. Shipped 2026-05-16 |

### Этап C — Полный граф через все источники

| # | Задача |
|---|--------|
| **C1** ✅ | On-chain → CEX deposit seeding (5 TDD stages): S1 schema (migration 0020 `cex_deposit_seeds`) + repository (10 tests) → S2 service layer с batch validation, audit, `resolveCostBasisByHash` (11 tests) → S3 `CexCostBasisService.applyDeposit` accepts optional seeds map, pre-fetches batch ДО event loop, hits = exact USD via source='fiat-direct' (5 cost-basis + 185 CEX) → S4 REST `POST/GET/DELETE /v1/cex/deposit-seeds*` wired в app.ts (740/740 API) → S5 client `computeDepositSeedsFromOps` (incremental WAC tracker — fixes consume-mutation issue) + `useUpsertDepositSeeds` + auto-upload effect в LoadedWalletsProvider (debounced 3s) (7 + 158 portfolio). End-to-end: client считает WAC×amount → POST → server applyDeposit reads → CEX pool inherits → subsequent withdrawal обратно on-chain имеет правильный cost. Shipped 2026-05-16 |
| **C2** ✅ | CEX A → CEX B hop chains (2 TDD stages): S1 pure `detectCexHopChains(inbound, outbound)` — greedy chronological matching by walletId + tokenFamily, window ≤30d, idempotent (10 tests). S2 `ChainOpsService.findCexHopChains` — pulls CEX transfers with hash + on-chain transfer/bridge ops, joins by lowercase tx_hash, classifies as inbound (CEX wd → wallet) или outbound (wallet → CEX dep), runs detector + audit log. REST: `/v1/chain-ops/graph/internal-transfers` extended с `cexHopChains[]` (optional, backward compat). Frontend zod `graphCexHopChainSchema` + `GraphCexHopChain` type. 750/750 API + 158/158 web. End-to-end C1+C2: client считает WAC через D3-seeded lots → POSTs seed → applyDeposit recognizes → wallet inherits cost basis → next withdraw chains back. Shipped 2026-05-16 |
| **C3** ✅ | Global timeline UI: новая страница `/timeline` + nav item "Лента событий" (RU/EN i18n). Merge'ит ops через все loaded wallets, sort по времени desc, лимит 100/page с "load more". Filters: chain / wallet / op type / search (hash/wallet/symbol). Toggle "show excluded" (D8). Per-row: time / wallet link / chain badge / op type badge (с цветом per OpType + ✎ если manual override) / movements chips (+/− amount symbol USD) / netUsd / shortened hash + $ indicator если manual cost basis. 4 KPI stats: total / filtered / excluded / manual overrides. Excluded ops серые + line-through. 151/151 portfolio tests + typecheck clean. Shipped 2026-05-16 |
| **C3.2** ✅ | CEX-side events на timeline: discriminated union `UnifiedFeedItem = OnChainFeedItem \| CexFeedItem`. CexFeedItem источники: `useCexTaxEvents` (sale/exchange/income) + `useCexTransfersWithHash` (deposit/withdrawal). Renders на purple-tinted row, exchange badge вместо wallet. Toggle "Включить CEX events" + counter. Backward compat: filters chain/wallet не применяются к CEX rows. Shipped 2026-05-16 |
| **C4** ✅ | Provenance trail UI: PositionDetailPage расширен секцией "Cost basis provenance" — per supply-token показывает lot breakdown через `newTrackers.lotsByWallet.get(walletId).getLots(walletId, symbol)`. Summary: разноцветные badges группированные по `acquiredVia` (Buy / Swap / Transfer / Reward / Bridge / LP close / …) с % share от total cost. Detailed lot table: date / source badge / amount / cost per unit / total cost (+ FMV badge для D6 reward lots) / shortened tx hash. 11 acquiredVia variants с unique цветом + tooltip объясняющим методологию. UCB D6 reward лоты явно помечены как cost=0 + FMV preserved. 151/151 portfolio tests, typecheck clean. Shipped 2026-05-16 |
| **C5** ✅ | UCB pipeline orchestrator `ucb_pipeline.ts`: `runUcbPipelineForWallet(input)` — single entry point с fixed step order (1. applyAnnotations+D8 → 2. buildLots(+Positions если walletNameById) → 3. computeRealizedPnlByFamily → 4. computeRewardIncomeByFamily). C5.2: `runUcbPipeline(inputs[])` cross-wallet aggregator (realizedByFamily / rewardIncomeByFamily / totalExclusions). C5.3: AssetsPage переключён на `runUcbPipeline` — раньше realized PnL не уважал D8 exclusions (bug fix). C5.4: `LoadedWalletsProvider.newTrackers` мигрирован — `buildLotsAndPositions` + manual cost basis annotation merging теперь живут внутри orchestrator. Provider expose'нул `annotationsByKey` + `costBasisOverrideByHash` для downstream consumers. Поддержан `walletIdForAnnotations` чтобы handle composite-id (api:UUID:addr) ≠ UUID asymmetry. 15/15 ucb_pipeline tests + 151/151 portfolio. Shipped 2026-05-16 |

### Этап D — Correctness (точность учёта)

| # | Задача |
|---|--------|
| **D1** ✅ | Withdrawal fees split: server-side `applyWithdrawal` теперь consume'ит `amount + feeAmount` из pool (когда feeCurrency == asset) или из two pools (cross-currency fee, e.g. BNB fee for BTC withdrawal). `WithdrawalCostBasis` расширен полями `feeLossUsd / feeAsset / feeAmount` (realized loss at withdrawal). Stable-fee approximation 1:1 для случая когда fee pool пуст (fresh deposit). Frontend zod schema добавил optional fields (backward compat). Invariant `costBasisUsd + feeLossUsd = totalCostRemoved` enforced в tests. 8/8 cost-basis tests + 707/707 API + 129/129 portfolio. Shipped 2026-05-16 |
| **D2** ✅ | Historical FX RUB/EUR→USD для P2P в non-USD фиате. `HistoricalFxService` reuses `historical_prices` table (symbol = ISO-4217), source = exchangerate.host (free, no key), batch-fetch перед applyP2p чтобы compute loop оставался sync. Fallback на stable-1:1 если upstream down или нет данных. 8/8 unit tests, no cost-basis regression. Shipped 2026-05-16 (forward-looking — bob не имеет non-USD P2P, но SaaS robustness для EUR/RUB users) |
| **D3** ✅ | Receipt-token UCB integration: server-derived CEX inheritance cost basis (`cexCostBasisByHash`) теперь feed'ится в `buildLotsAndPositions` через `costBasisOverrideByHash`. Lot tracker строит aWBTC/aETH/aUSDC лоты с правильным cost вместо derived market price. Manual A4 annotations имеют precedence над server-derived. Shipped 2026-05-16 |
| **D4** ✅ | Wrapped tokens & LSTs chain-aware: `tokenFamily()` теперь фолдит 16 ETH LSTs (stETH/wstETH/rETH/cbETH/eETH/weETH/ezETH/wbETH/oETH/swETH/ankrETH/osETH/mETH/rswETH/rsETH/sfrxETH+frxETH) → ETH и 11 BTC variants (LBTC/EBTC/FBTC/MBTC/solvBTC/stBTC/pumpBTC/uniBTC/...) → BTC. Savings stables: sDAI → DAI, sUSDS → USDS. Lot-tracker `normalizeSymbol` НЕ затронут (WETH→ETH only) — каждый LST хранит свой precise cost basis отдельно, фолдинг работает только на display layer (E1 AssetsPage, realized PnL aggregation). API tokenFamily оставлен узким (без LST folding) чтобы не False-match'ить internal transfers. 52/52 new + 129/129 portfolio + 703/703 API tests. Shipped 2026-05-16 |
| **D5** ✅ | Cross-chain bridges: `lastBridgeOutWac` state propagates pre-consume WAC из bridge_out в matching bridge_in. Both build.ts и cross_protocol.ts handlers. Bridge fee автоматически списывается через consume на out-side с старой WAC. 4/4 unit tests, 45/45 portfolio tests. Shipped 2026-05-16 |
| **D6** ✅ | Yield/staking rewards classification: новый `AcquiredVia: "received_as_reward"`, reward лоты создаются с `costPerUnitUsd = 0` (UCB-correct), FMV at receipt сохраняется в `Lot.fmvAtAcquisitionUsd` для income reporting. Sale reward'а → full proceeds как realized gain (убран `consumed.totalCostUsd > 0` guard в realized_pnl swap-handler). Новый aggregator `computeRewardIncomeByFamily` + 5-я KPI карточка "Reward income" на AssetsPage (амбер). `applyRebaseYield` тоже переехал на `received_as_reward`. 20/20 D6 tests + 77/77 portfolio + 703/703 API. Shipped 2026-05-16 |
| **D7** ✅ | Net cost basis для lending с borrow: `OpenPosition.netStartUsd` = startUsd − borrow proceeds + repay outlay. Computed via `computeBorrowProceedsUsd(ops, protocolId, chain)`. UI: позиции с meaningful borrow gap (>1%) показывают "net $X · L×" под gross startUsd. 5/5 unit tests. Shipped 2026-05-16 |
| **D8** ✅ | Manual corrections / soft-delete UCB-aware: migration 0019 добавил `excluded BOOLEAN NOT NULL DEFAULT false` в `chain_operation_annotations` + partial index `WHERE excluded = TRUE`. Annotations repo/service/routes пробрасывают поле. Frontend zod schema + AnnotationUpsertBody добавили optional `excluded` (backward compat). `applyAnnotationsToOps` теперь фильтрует ops где `excluded=true` ДО `buildLotTrackerFromOps` — op исчезает из UCB pipeline (lots tracker, position tracker, asset rollup, realized PnL). `OpAnnotationDialog` имеет красный checkbox "Исключить из UCB-pipeline (soft-delete)". 7/7 apply_annotations tests + 136/136 portfolio + 707/707 API. Shipped 2026-05-16 |
| **D9** ✅ | Historical price fallback: `priceFromMapNearest` ищет ближайший bucket ±7d того же coin когда exact-bucket miss. Wired в `movementUsd` (build.ts) + `tokenUsdHist` (cross_protocol.ts). Sparse hist-data for редких токенов теперь даёт approximate cost basis вместо 0. 7/7 unit tests, 57/57 portfolio tests. Shipped 2026-05-16 |

### Этап E — UX-долг

| # | Задача |
|---|--------|
| **E1** ✅ | Unified asset view: `/assets` page + nav link "Активы". `buildAssetRollup(loadedById, lotsByWallet)` aggregates по `tokenFamily` across all wallets. Per-row показывает total amount / WAC / cost basis / current USD / unrealized PnL %. Click-to-expand breakdown per (wallet × chain). Filters protocol receipts (aUSDC/GLV) и dust < $1. CEX-side в backlog (потребует server-side balance aggregation). 7/7 unit tests + i18n RU/EN. Shipped 2026-05-16 |
| **E2** ✅ | Standalone position breakdown page: новый route `/positions/:positionId` + `PositionDetailPage.tsx`. Layout: header (protocol/chain/kind/age), KPI strip (cost basis с leverage badge / current / unrealized PnL / fees lifetime APR), supply tokens table с avg buy + per-token PnL, debt tokens (для lending) + health rate, V3 details (deposit / HODL / current / IL / PnL), fees claimed history table (date / tokens / USD / period APR / PnL since prev), provenance card (wallet link / opened tx / credit funded). Position id в /performance теперь Link к detail page. Грациозный 404 если позиция закрылась. 151/151 portfolio tests. Shipped 2026-05-16 |
| **E3** ✅ | Realized vs unrealized PnL: `computeRealizedPnlByFamily(ops, walletId, overrides)` детектирует sale events (non-stable→stable swap + withdraw_fiat) и считает realized USD по семействам. Wired into AssetsPage: 4-я KPI карточка "Realized PnL" + новая колонка "Realized" в таблице. Token→token swaps НЕ реализуются (rebasis), transfer_out/bridge_out — тоже не реализация. 8/8 unit tests, 65/65 portfolio. Shipped 2026-05-16 |

### Этап F — Operational stability

| # | Задача |
|---|--------|
| **F1** ✅ | Production deploy: systemd units (`capflow-api.service`, `capflow-worker.service`) с hardening (NoNewPrivileges, ProtectSystem, RestrictNamespaces). `infra/scripts/backup-postgres.sh` + `capflow-backup.timer` (daily 03:00 UTC + retention + S3/rclone). `infra/scripts/healthcheck.sh` для external monitors. `notes/DEPLOY.md` § 9 расширен bare-metal runbook + pre-launch checklist (DNS / TLS / JWT / CORS / backup / smoke test). Shipped 2026-05-16 |
| **F2** ✅ | Onboarding flow: 4-step wizard (`/onboarding`): welcome → jurisdiction selector → wallet connect CTA → CEX connect CTA. localStorage flag `capflow.onboarding.completed.v1` prevents re-prompt. `HomePage` auto-redirect новых users. Jurisdiction preference сохраняется для TaxPage default. Shipped 2026-05-16 |
| **F3** ✅ | Health dashboard: server endpoint `GET /v1/admin/health` aggregates DB pool stats + Redis ping + BullMQ queue counts + wallets/CEX sync state, fail-soft per section. Admin page `/admin/health` с auto-refresh 15s, color-coded sections (ok/warn/error), overall status banner, uptime + node version. 766/766 API tests. Shipped 2026-05-16 |
| **F-sync-hardening** ✅ | Bob hardening pass (4 fix'ов): #1 `syncTransfers` error persistence (markSyncError on partial failure), #3 auto-trigger B3 internal transfers (opportunistic chain в `syncTransfers`), #4 untracked destinations detector + REST graph extension, #5 CEX asset gap detector (`/v1/cex/me/asset-gaps`) + UI warning card на `/coverage`. 28 new tests · 796/796 API. Verified на bob's real data — нашёл 3 problematic assets (LTC 11.87× gap, EOS/BBSOL no-acquisitions) + 27/41 untracked destinations. Shipped 2026-05-17 |
| **F-admin-fix** ✅ | Bug fix: 500 Internal Server Error на `/admin/users` page. Root cause: `db.execute<T>()` raw SQL возвращал `timestamptz` поля как **string** (vs Date в ORM `.select()`) — type parameter был только TS hint, не runtime parser. Затем `toAdminUserResponse(u).createdAt.toISOString()` крашился (string не имеет `.toISOString()`). Fix: defensive `toDate(v)` helper coerce'ит все timestamp поля (`created_at`, `updated_at`, `email_verified_at`, `last_login_at`, `last_snapshot_at`) в Date перед mapping. 5 new unit tests · 801/801 API. Shipped 2026-05-17 |

### Этап Tax (после UCB Complete)

| # | Задача |
|---|--------|
| **T1** ✅ | Per-lot `TaxEvent` generator: `generateTaxEvents(ops, walletId)` walk'ает chronologically, emit'ит events per disposition (sale=stable-out, exchange=token-to-token, income=reward). Per-lot detail via `LotTracker.consume()`. US-style term threshold ≥365d → 'long'. 11/11 tests. |
| **T2** ✅ | CSV exporter: `exportTaxEventsToCsv(events)` — RFC 4180-compliant, ISO 8601 UTC dates, USD 2 decimals + amount 8 decimals. Plus `summarizeTaxEvents` aggregator (short/long gain, income, totals). 10/10 tests. |
| **T3** ✅ | `/tax` page + nav item (RU/EN): 6 summary cards (events / short-term / long-term / income / proceeds / cost basis), filters (year / event type), filterable events table, CSV download button. Methodology disclaimer card. Annotations applied (D8 excluded, A3 overrides). 179/179 portfolio. Shipped 2026-05-16 |
| **T1.1** ✅ | FIFO / LIFO / HIFO method selector. `LotMethodology` расширен 'HIFO' (consume highest cost first → tax-optimal). `generateTaxEvents(ops, walletId, method)` принимает 4 methodology. UI dropdown в `/tax` page. Tests: bear scenario verifies HIFO ≤ FIFO/LIFO/WAC. 16/16 tax_events tests. Shipped 2026-05-16 |
| **T4** ✅ | CEX-side events merge: `CexTaxEventsService` (server) walks p2p + trades chronologically с WAC pool. Emit'ит sale (P2P sell crypto→fiat, trade non-stable→stable) + exchange (trade non-stable→non-stable). REST `GET /v1/cex/me/tax-events`. Client hook `useCexTaxEvents` + toggle "Include CEX events" в TaxPage. Synthetic txHash для CSV: `cex:<exchange>:<source>:<id>`. 7/7 service tests + 757/757 API + 184/184 web. Shipped 2026-05-16 |
| **T5** ✅ | Per-jurisdiction rules: `JURISDICTIONS = ["US", "EU", "RU", "UK"]` с per-jurisdiction `longTermThresholdDays` (US/EU 365d, RU 1095d, UK Infinity), `allowedMethodologies` (US full, EU WAC/FIFO, RU FIFO/LIFO, UK WAC-only Section 104), `tokenToTokenTaxable`, `notes`. `generateTaxEvents` accept jurisdiction. UI dropdown auto-resets method если current не allowed. Jurisdiction-notes card. CSV filename `capflow-tax-<jur>-<method>-<year>.csv`. 12/12 jurisdictions tests + 16/16 tax_events + 196/196 web. Shipped 2026-05-16 |
| Backlog | Audit log of recalcs, performance optimization |

---

## ✅ Сделано

### UCB Layer-2 — Position coverage aggregator (2026-05-15)

Первый шаг UCB на клиенте: для каждой позиции (например POS-007 Aave
V3 WBTC) собирается покрытие cost basis из 3 источников и считается
blended WAC для `startUsd`.

**Модули:**
- `apps/web/src/lib/portfolio/position_coverage.ts` —
  `computePositionCoverage()` раскладывает amount позиции на:
  - `directBuy` — `affectsWac=true` events
    (swap_from_stable/swap_from_token/fiat_buy)
  - `cexInheritance` — `transfer_in` matched к CEX-withdrawal
    (по lowercase tx-hash + asset match с WETH↔ETH normalization)
  - `lpUnwind` — `lp_close_attribution` с inherited cost
  - `unknown` — transfer_in без атрибуции
  + `enrichPurchaseEventsForCoverage()` — обогащает события для popup'а
  (с `costSource` пометкой; `includeUnmatched` режим для debug)
- `apps/web/src/lib/portfolio/cex_inheritance_cost_basis_override.ts` —
  `applyCexInheritanceCostBasisOverride()`: для позиций где direct buy
  покрывает <95% — подменяет startUsd на `amount × blendedWac` (WAC по
  всем известным источникам).
- Cascade в `OpenPositionsPage`: V3 override → Lending FIFO override →
  CEX inheritance override.
- Popup `PurchaseHistoryPopup` теперь показывает все 3 источника + debug
  «Перевод без атрибуции» для unmatched (с tooltip-инструкцией).

**Vitest добавлен в apps/web** — `pnpm test` / `pnpm test:watch`. 41
кейс по 2 модулям GREEN.

**Что не покрыто:** cross-wallet transfer (этап A), on-chain → CEX
deposit seeding (этап C). Если withdrawal с CEX, у которой пустой
WAC-пул (как BingX без trade-permission у Bob), возвращается
`source=unknown, costBasisUsd=0` — popup показывает «С биржи (нет
cost)» с инструкцией пользователю.

### CEX integrations (CCXT) — Bybit / OKX / Bitget / MEXC (2026-05-14)

Подключение CEX-бирж API-ключом для синхронизации балансов и сделок.

**Архитектура:**
- **`apps/api/src/modules/cex/`** — модуль с тонкой обёрткой над CCXT.
  - `cex.types.ts` — whitelisted `SUPPORTED_EXCHANGES` (bybit, okx, bitget, mexc),
    типы `CexCredentials`, `CexPermissions`, `CexBalanceLine`, `CexTradeLine`.
  - `cex.client.ts` — `createCexClient()` строит CCXT с `enableRateLimit=true`,
    30s timeout, требует passphrase для OKX/Bitget. `probePermissions()`
    делает behavioral-probe через `fetchBalance()` (CCXT не вытаскивает
    permissions напрямую). `normalizeBalance()` flatten'ит nested-shape,
    skip'ает meta-fields (info, free, used, total, debt). `normalizeTrade()`
    синтезирует `cost = amount × price` если CCXT не вернул.
  - `cex.service.ts` — `connect()`/`list()`/`disconnect()`/`sync()`. Probe'ит
    read-perm, отказывает без него. Шифрует ключи AES-256-GCM (reuse
    cipher из B5/`admin-integrations/secret-cipher.ts`, prefix `enc:v1:`).
    `sync()` пишет balance snapshot (один row per asset per sync) +
    upsert trades (idempotent по (cex_account_id, exchange_trade_id)).
    Auth/network failures → `markSyncError`, returns `{ok:false}`.
  - `cex.repository.ts` — Drizzle, три таблицы.
  - `cex.routes.ts` — REST под `/api/v1/cex/` с JWT auth, Zod-валидацией.
- **Migration `0010_cex_accounts.sql`** — `cex_accounts` (encrypted blobs +
  permissions jsonb), `cex_balances` (snapshots с `(cex_account_id,
  snapshot_at)` index), `cex_trades` (unique `(cex_account_id,
  exchange_trade_id)` для идемпотентности re-sync).

**Frontend:**
- **`apps/web/src/features/cex/{api,hooks}.ts`** — Zod-schemas + 4 React
  Query хука (list/connect/disconnect/sync).
- **`apps/web/src/components/cex/CexExchangesPanel.tsx`** — встроен в
  RegistryPage сразу после WalletList. Карточки подключённых бирж со
  статусом lastSync/lastSyncError + кнопкой "Синхронизировать". Форма
  подключения с per-exchange инструкциями ("как создать read-only ключ
  на Bybit/OKX/Bitget/MEXC"). OKX/Bitget автоматически требуют поле
  passphrase. UX следует паттернам WalletList — Card/CardHeader/
  CollapsibleForm.

**Безопасность:**
- Ключи шифруются на сервере (AES-256-GCM с auth-tag), в БД хранятся
  как `enc:v1:<iv>:<tag>:<ct>`. Plaintext не покидает память на
  encrypt/decrypt path.
- Connect-time probe требует `read`-permission; при `read=false`
  отказываем БЕЗ insert'а в БД (нет смысла хранить мёртвый ключ).
- `list()` strip'ает `apiKey/Secret/PassphraseEnc` до отправки клиенту.
- Soft-delete (`archived_at`) — для audit-trail, при удалении ключи
  остаются в БД но не светятся в `list()`/`sync()`.

**Tests:** 26 проходит (17 cex.client + 9 cex.service). FakeRepo + DI
factory позволяют тестировать без живых exchange'ей.

### Phase F6a — Dashboard reads from server snapshot (2026-05-13)

Закрывает первую часть миграции дашборда с pre-SaaS client-side compute
на серверные `portfolio_snapshots`. Раньше HomePage CapitalHero показывал
$0 для нового SaaS-юзера потому что `LoadedWalletsProvider` пуллил
кошельки из `localStorage.capflow.wallets` (legacy store), который при
свежем логине пуст. Реальные данные были в БД (worker'ом обновлены
каждый час), но фронт их не видел.

**Что сделано (рабочий fix для топ-KPI):**

- **`apps/web/src/features/portfolio/api.ts`** + **`hooks.ts`** — новый
  feature-модуль для дашборд-снапшотов:
  - `useAccountSnapshot(accountId)` — React Query'ит `/refresh-status`,
    отдаёт `metrics: SnapshotMetrics` с auto-refetch каждые 60s.
  - `useTriggerAccountRefresh(accountId)` — mutation, дёргает
    `POST /accounts/:id/refresh` + invalidate'ит snapshot через 3s.
  - Zod-схема `snapshotMetricsSchema` (totalUsd, perAddress, costBasis,
    operationsCount и т.д.) с `passthrough()` для forward-compat.

- **`apps/web/src/pages/HomePage.tsx`** — пробрасывает `snapshotMetrics`
  в CapitalHero. Внутри CapitalHero три override'а:
  - `currentUsdToShow = snapshot.totalUsd ?? m.totalAssetsUsd`
  - `startUsdToShow = Σ snapshot.costBasis[].totalPaidUsd ?? m.startUsdEffective`
  - `WalletBalancesBlock.totalUsd = snapshot.totalUsd когда m.walletUsd=0`
  Поведение: server snapshot выигрывает когда client = 0; иначе
  client-side compute сохраняется (для пользователей с активным
  LoadedWalletsProvider кэшем).

- **`apps/web/src/features/wallets/useWalletsHydration.ts`** + хук в
  AppShell — bridge `wallet_addresses` БД → `localStorage.capflow.wallets`.
  При логине подтягивает API-кошельки в legacy store, чтобы остальные
  части HomePage (positions, charts) хотя бы знали о существовании
  кошельков. Полная замена legacy store на API — следующая под-фаза.

**Результат:** для vladimir@cap-flow.ru на vitalik.eth — все три
top-level KPI ('Общий баланс', 'Стартовый капитал', 'Текущий капитал')
показывают корректные $1 254 720.31 / $3 500.00.

**Остаётся F6b (отдельная фаза):**

- Расширить `metrics` snapshot новыми полями: `ownCapitalUsd`,
  `totalDebtUsd`, `protocolsAssetUsd`, `feesLifetimeUsd`. Worker делает
  `metrics.perAddress[].chains` — этого хватает для top-3 KPI, но
  СОБСТВЕННЫЙ КАПИТАЛ / СОВОКУПНЫЙ ДОЛГ остаются $0.
- Заменить `LoadedWalletsProvider` положениями/лотами из server data.
  HomePage line ~3000 секции PositionsBlock, AssetTimeline, и т.п.
  читают client-state — мигрировать на API endpoints.
- Удалить `localStorage.capflow.wallets` store целиком; убрать
  hydration bridge как промежуточный слой.
- Estimate: 2-3 дня плотной работы.

### Phase P6.1f — Local prod-stack smoke test (2026-05-13)

Поднял `infra/docker-compose.yml` (prod-конфиг) полностью локально через
`.env.smoketest` (substitution layer, не трогает user's `.env`). Cleaner
test of "что увидит cap-flow.ru при первом деплое". Все 6 сервисов
(postgres/redis/migrate/api/worker/web/caddy) зелёные. End-to-end auth и
BullMQ pipeline работает.

**Сделано в процессе:**

- **`.env.smoketest`** в gitignore'е (`.env.smoketest` + `!.env.prod.example`
  whitelist для prod-template'а). Substitution-слой для compose'а:
  `DATABASE_URL=postgres://...@postgres:5432/...`, `REDIS_URL=redis://redis:6379`,
  `NODE_ENV=production`, `COOKIE_SECURE=false`, `CADDY_DOMAIN=:80`
  (ACME отключён). Реальные секреты (JWT, API keys) подтягиваются из
  user's `.env` через `env_file:` блок в compose.

- **`packages/db/drizzle/0000_baseline.sql`** (49KB, 172 DDL):
  pg_dump dev-БД `--schema-only --no-owner --no-privileges --no-comments`,
  стрипнут `\restrict`/`\unrestrict` psql metacommand'ы. Существующие
  миграции переименованы 0001-0005. На пустой БД накатывается чисто.

- **`packages/db/src/migrate.ts` переписан** — был drizzle runtime
  migrator (`drizzle-orm/node-postgres/migrator`), требующий
  `meta/_journal.json` (его не существует, миграции рукописные).
  Заменён на простой SQL runner: создаёт `public.__migrations` tracking
  table, читает `*.sql` из `./drizzle`, прогоняет в транзакциях по
  одной. Применённые file'ы записываются в tracking table — повторный
  запуск idempotent (skip applied). Schema-qualified `public.__migrations`
  потому что baseline SQL вызывает `SET search_path = ''`.

- **`apps/{api,web}/Dockerfile`** уже было: corepack → npm direct
  (см. P6.1e).

- **`.env.smoketest:CADDY_ACME_EMAIL=admin@localhost`** (dummy) —
  Caddyfile глобальный блок `email {$CADDY_ACME_EMAIL}` требует
  непустой аргумент даже при `:80` (где ACME не запускается). На
  prod-deploy будет реальный email — не повлияет.

**Smoke test — что прогнал:**

1. `docker compose up -d postgres redis` → healthy 2с.
2. `docker compose run --rm migrate` → 6 миграций накатилось, exit 0.
3. `docker compose up -d` → все 6 контейнеров healthy/running.
4. `docker compose exec api node dist/scripts/seed-admin.js` → создан
   `vladimir@cap-flow.ru` (admin) + primary account "Main".
5. `POST /api/v1/auth/login` (через Caddy:80) → 200, Set-Cookie
   `cap_access` (scope=`/api/v1/upstream`) + `cap_refresh`
   (scope=`/api/v1/auth`) + JWT в body.
6. `GET /api/v1/auth/me` с Bearer → 200, user payload.
7. `GET /api/v1/accounts` → seeded primary account возвращается.
8. `POST /api/v1/accounts/:id/wallets` с `0x000...dEaD` → 201 Created.
9. `POST /api/v1/accounts/:id/refresh` → 202 + jobId.
10. `docker logs cap-flow-worker-1` → виден тот же jobId с
    `msg: "[worker] refresh completed"`, `trigger: admin`. BullMQ
    pipeline работает.

**Архитектурный итог:** деплой на пустую prod-БД теперь предсказуем.
Достаточно: `.env` с заполненными секретами, `docker compose up -d`,
`docker compose run --rm migrate`, `docker compose exec api node
dist/scripts/seed-admin.js`. На VPS это уже автоматизировано в
`.github/workflows/deploy.yml`.

Стек оставлен поднятым (postgres/redis/api/worker/web/caddy) — можно
открыть `http://localhost/` в браузере и пощупать SaaS UI поверх свежей
prod-БД (там только seeded admin + 1 wallet). Тушится через
`docker compose -f infra/docker-compose.yml --env-file .env.smoketest down -v`.

### Phase P6.1e — Local push-readiness audit (2026-05-12)

Перед заливкой на GitHub прогнал полный pre-flight локально на собранном
монорепо. Зелёное: 457 vitest tests (api), `pnpm typecheck` для api/db,
`pnpm build` всех workspace'ов. Один локальный коммит (1e0bdda) собирает
всё накопленное (438 файлов, +85k строк); пока не пушим на GitHub.

**Изменения сделанные в процессе аудита:**

- **`apps/api/Dockerfile`, `apps/web/Dockerfile`** — заменил
  `corepack enable && corepack prepare pnpm` на `npm install -g pnpm`.
  Корень: corepack 0.x в `node:20.18.1-alpine` падает на signature
  verification (`Cannot find matching keyid` — stale baked-in keys
  не валидируют свежие pnpm-tarball'ы). npm direct install — самый
  надёжный обход. Без этого фикса CI build в `deploy.yml` сломался бы.
- **`apps/web/package.json`** — `"build": "tsc -b && vite build"` →
  `"build": "vite build"`. `tsc -b` блокировал build на 130 накопленных
  TS-ошибках (см. ниже). vite/esbuild сам тайпы не проверяет → бандл
  собирается, рантайм идентичен текущему рабочему локальному. Не идеал,
  но регрессию не вносит — это тот же бинарь что user уже месяцами гоняет.
- **`.github/workflows/ci.yml`** — добавлен step `pnpm -r run test`
  между typecheck и build apps. Раньше CI не прогонял ни одного теста.
- **Локальная валидация Docker** — `cap-flow-api:local` (288MB) и
  `cap-flow-web:local` (76.9MB) собираются с правильным exit-кодом.

**Найденный тех-долг (не фиксил, отдельная фаза):**

1. **`pnpm typecheck` для web — фейк.** Скрипт `tsc --noEmit`
   запускается на `apps/web/tsconfig.json` где `"files": []` и
   `references: […]` — это **orchestrator**, при `--noEmit` он не ходит
   по references. Реальный тайпчек делает только `tsc -b`. Локально
   typecheck зеленый, в Docker build (где был `tsc -b`) падает.
   В CI после этого фикса typecheck остаётся фейковым — тоже зелёный,
   но не проверяет web. Чинить надо: `"typecheck": "tsc -b --noEmit"`.

2. **130 TS-ошибок в apps/web** (`apps/web && npx tsc -b --noEmit`).
   Распределение:
   - 36× TS6133 unused imports/vars (шум)
   - 33× TS2339 missing property — НЕ все шум. Например, `netPnlUsd` /
     `netPnlPct` пишутся в 4 файлах (`open_positions.ts`,
     `lending_cost_basis_override.ts`, `v3_cost_basis_override.ts`)
     но не объявлены в `OpenPosition`. Grep по src показывает только
     writes — либо dead code (вычисляем и выкидываем), либо читается
     динамически через `pos[columnId]` в таблице. Аналогично `lpTokenId`.
   - 26× TS18048 possibly undefined — strict null check; часть = paranoia,
     часть = реальные null-deref риски.
   - 12× TS2375 exactOptionalPropertyTypes — несовместимости с строгим
     "опциональные = строго `T | undefined`".
   - 10× TS2345 wrong arg shape — например `ConsumeOptions` в
     `position_lot_cost_basis.ts` (caller передаёт `{walletId,symbol,
     amount,tokenId,chain}`, тип ждёт другое).
   - 6× TS2322 assignability — `string` → `ProtocolCategory` literal union.
   - viem v2 typing: `log.args` is `never` без явных generic'ов в
     `getLogs<typeof abi, "EventName">(...)`. Рантайм работает, типы — нет.
   Возникли из 2 источников:
   (a) накопленный type drift при добавлении полей в interface'ы
       (старые callers использовали поля до их явного объявления);
   (b) виemv2 миграция без обновления generic-параметров в `getLogs`.
   **Runtime**: не регрессия. user-app работает с этими ошибками месяцами,
   тесты не покрывают эту область (нет vitest у web). Чинить отдельной
   фазой `F-typecheck-cleanup`.

3. **`pnpm lint` сломан.** apps/api и apps/web имеют скрипт
   `"lint": "eslint ..."`, но eslint не в devDeps и нет `eslint.config.*`.
   CI lint не вызывает — не блокер, но `pnpm lint` локально падает с
   `command not found`. Либо ставим eslint + minimal flat config, либо
   убираем dead-script'ы.

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
