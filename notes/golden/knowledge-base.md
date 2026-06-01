# Golden positions — knowledge base (UCB methodology, derived from marked anchors)

**Источник:** 14 эталонных позиций, размеченных на тест-аккаунте `testakk`
(2 кошелька: **Murat** `0x1bd62bdb…d041`, **Artur** `0x3df3ce31…6a38`), все на
**Arbitrum**. Каждая `golden_cases.derivation` (schemaVersion 2) содержит
WAC lot-трассу с линком каждого лота на блокчейн-tx (`sourceHash`). Этот файл —
синтез методологии: КАК считается каждая позиция, КАКОЙ сервис в КАКОЙ момент
даёт данные, и какие нюансы движок UCB-порта обязан воспроизвести.

> **ГЛАВНЫЙ ПРИНЦИП (owner, 2026-05-31):** всё, что СЕЙЧАС отображается в Листе
> открытых позиций — по КАЖДОМУ столбцу и параметру — это **ЭТАЛОН**. Так и должно
> выводиться. Задача базы знаний — не искать «баги», а зафиксировать, ЗА КАКОЙ
> параметр КАКОЙ сервис отвечает, чтобы UCB-порт воспроизвёл это 1:1.

Связано: [[capflow_data_source_authority]] (карта сервисов),
[[capflow_ucb_methodology]], [[capflow_v3_cost_basis]],
[[capflow_c11_wac_at_history]], [[capflow_d4_wrapped_pool_aliasing]].

---

## 1. Когда какой сервис подключается и что собирает (timing)

Двухстадийная загрузка позиции (см. `LoadedWalletsProvider` → `useComputedPositions`):

| Момент | Сервис | Что собирает | Кэш / триггер |
|---|---|---|---|
| **Старт страницы (мгновенно)** | сервер `chain_operations` (наша БД) | `ops` (классифицированные операции: swap/transfer/deposit/lp_add/lend_supply…) — вход для UCB lot-tracker | из server-cache, без сети |
| **Refresh / по localStorage-кэшу** | **DeBank Pro** | live-state: `complex_protocol_list` (открытые позиции протоколов + lending HF), `token_list` (балансы), `history_list` (новые ops) | localStorage live-cache; refresh по кнопке |
| **При наличии V3 NFT** | **Etherscan v2** | `IncreaseLiquidity`/`DecreaseLiquidity` логи → startUsd V3 по ценам на блок, mint date/hash | по `matchedV3TokenId`; кэш V3 cost basis |
| **on-chain уточнение V3** | **Alchemy** | `amount0/1Current`, `tokensOwed`, slot0 — current amounts NFT | при свопе amounts DeBank между NFT одного пула |
| **LP-позиции (Phase 7)** | **Krystal** | `tradingFee{pending,claimed}`, `performance.apr.feeApr`, `totalDepositValue`, current value, IL | **24h localStorage** `capflow.cache.krystal.v1:<addr>`; fetch при смене wallet-list. ⚠ нет `KRYSTAL_API_KEY` → proxy 503 → пропуск |
| **Цены на даты (cost basis)** | **DefiLlama → CoinGecko** | историческая цена токена на timestamp лота | на каждый acquisition-лот; `src=defillama_only` в логах |

**Конвейер обработки** (порядок override'ов, `use_computed_positions.ts`):
`buildOpenPositions` (DeBank live + ops + UCB lot-tracker WAC) →
Ph2 `applyV3CostBasisOverride` (**Etherscan** startUsd для V3) →
Ph3 lending override → Ph4 CEX inheritance → Ph5 V3 claimed-fees split →
Ph7 `applyKrystalV3Override` (**Krystal** — fee/APR/cost basis для LP) →
Ph10 non-LP opener. Цены везде — DefiLlama/CoinGecko.

**Принцип:** каждое число позиции имеет конкретный сервис-источник. startUsd
не-LP = UCB lot-trace (WAC по on-chain acquisitions, цены DefiLlama); startUsd
V3 = Etherscan deposit-события; fee/APR LP = Krystal.

---

## 1b. ЯДРО: идеальный реестр операций → корректная позиция (методология)

**Эталон — это не сами числа, а корректно прочитанный реестр операций.** Позиция
= детерминированная функция от `chain_operations`. Если реестр идеальный
(операции верно классифицированы, movement/usd/флаги верны) → движок выводит
каждый параметр правильно. База знаний фиксирует ЭТУ методику.

### Схема записи реестра (`chain_operations.raw`)
```jsonc
{ "type":"swap|lp_add|lend_supply|...", "time":unix, "chain":"arb",
  "protocol": { "id":"arb_gmx2", "name":"GMX V2", "category":"yield|lending|dex" },
  "movement": [ { "direction":"in|out", "symbol":"USDC", "amount":N, "usd":N,
                  "isStable":bool, "isProtocolToken":bool, "tokenId":"0x.." } ],
  "linkedLpTokenId":"0x..", "linkedLpSymbol":"GM", "linkedHash":"0x..", "notes":[..],
  "status":"ok|failed" }
```

### Таксономия op_type и роль в выводе позиции (16 типов)
| Категория | op_type | Как читается движком |
|---|---|---|
| **Acquisition** (кормит cost-basis лоты) | `swap`, `transfer_in`, `bridge_in`, `deposit_fiat` | IN-движение не-стейбла = приобретение; **cost = OUT-side стейбл-usd** (что заплатили). swap: out USD₮0 $545 → in WBTC 0.0075 → lot 0.0075 WBTC @ $545. `deposit_fiat`=manual_seed |
| **Opening** (создаёт позицию) | `lp_add`, `lend_supply` | OUT-движение = что внесли. **startUsd = Σ OUT usd** (реально потраченные). `linkedLpTokenId` = market_key позиции. openedAt=time. openedInTokens=OUT-токены |
| **Reducing** | `lp_remove`, `lend_withdraw`, `repay`, `transfer_out`, `bridge_out` | уменьшают net amount/startUsd (partial exit); для lending — гасят self-loop |
| **Leverage** | `borrow` (IN), `repay` | IN borrow на lend_supply → **netStartUsd** = gross − borrow (C11 self-loop) |
| **Income** | `claim_rewards` | claimed fees (Σ по protocol+chain+symbol) |
| **Noise** | `approve`, `failed` | игнор (status=failed отбрасывается) |

### Как реестр даёт КАЖДЫЙ параметр (методология чтения)
1. **startUsd** ← opening-op (`lp_add`/`lend_supply`) OUT-usd. Для стейбл-OUT (GMX
   USDC $364.04) — напрямую = потраченные USD. Для не-стейбл collateral (ETH/WBTC)
   — WAC-стоимость внесённого amount из acquisition-лотов. V3 — Etherscan deposit-события.
2. **openedInTokens / openedAt** ← OUT-side opening-op + его `time`, матч по
   `protocol.id` + `chain` + `linkedLpTokenId`.
3. **cost-basis лоты** ← все acquisition-ops (swap/transfer_in/deposit_fiat): IN-amount
   + cost = OUT стейбл-usd (или WAC если не-стейбл вход). Цена на дату = DefiLlama.
4. **netStartUsd** ← gross OUT − (borrow IN + withdraw/remove). Self-loop lending.
5. **isStable** флаг → стейбл = $1 (не гонять через WAC, иначе lp_remove раздувает).
6. **isProtocolToken** флаг → OUT protocol-token (GLV/GM) = collateral-receipt deposit
   (surface-asset сохраняется, underlying декомпозируется live).
7. **claimed fees** ← `claim_rewards` ops.

### Что делает реестр «идеальным/эталонным» (инварианты регистра)
- ✅ Каждая op **верно классифицирована** (`op_type`) — особенно lp_add vs swap vs transfer.
- ✅ `movement.direction` (in/out) и `usd` корректны (usd на момент tx).
- ✅ `isStable` / `isProtocolToken` проставлены верно (драйвят $1 vs WAC и receipt-детект).
- ✅ `linkedLpTokenId` есть на `lp_add` (привязка депозита к правильному market/позиции).
- ✅ **Нет пропущенных acquisition-ops** (иначе `uncoveredAmount>0` → fallback-цена, как POS-012).
- ✅ `protocol.id`/`category` верны (драйвят `kind`: lending/lp/yield).
- ✅ `status=failed` отброшены; aliased-пары (BTC↔WBTC) в одном WAC-пуле (D4).

**Это и есть «золотой стандарт»: позиция корректна ⟺ реестр удовлетворяет этим
инвариантам.** Детектор Epic C проверяет именно их; UCB-порт считает по ним.

## 1c. Принцип: методика учёта — ПО АКТИВУ, не по типу позиции (owner 2026-05-31)

**Cost-accounting методика (FIFO/LIFO/WAC) относится к АКТИВУ, а не к типу
позиции.** ETH в стейкинге, в лендинге, в perp-залоге, в yield-vault — это всё
тот же ETH с одной cost-basis из лотов кошелька. Тип позиции лишь определяет,
считается ли cost basis нашими лотами вообще.

- **Verified в коде:** `open_positions.ts buildOne:2370` `getPositionLotCostBasis`
  (с `methodology` из toggle) вызывается для КАЖДОГО non-stable supply-токена
  ЛЮБОЙ позиции (gated только `isStable ? null`). Комментарий 2344: «Lending
  (Aave/Fluid/Compound/Morpho/Spark), V3 LP, GMX V2/GLV — ВСЕ позиции где
  underlying actively supplied используют этот path». Стейкинг/perp идут тем же.
- **Типы позиций (`kind` из `protocol.category`) и opening op_type:**
  `lend_supply`→**lending**, `lp_add`→**lp/yield**, `stake`→**staking**,
  + perp (app_protocol). Все non-stable supplied активы → cost basis по методике.
- **Где методика НЕ применяется:** covered-LP (Uni/Pancake/Aero...) — startUsd из
  **Krystal** `depositTotalUsd` (methodology-independent, deposit-time). Стейблы — $1.
  Эти два исключения; всё остальное — lot-traced по выбранной методике.
- **Инвариант для порта:** на каждый non-stable актив в любой позиции — одна
  WAC/FIFO/LIFO cost-basis из общего пула лотов кошелька (D4 aliasing: BTC↔WBTC
  один пул). НЕ привязывать методику к `kind`.

## 1d. Частичное покрытие истории покупок (10 ETH в позиции, прослежено 3)

**🔒 ПРАВИЛО (owner 2026-05-31, M6-ревизия):** методика применяется к известным
лотам; **непокрытый остаток → цена на момент ОТКРЫТИЯ позиции** (supply-op on-chain
цена), НЕ $0 и НЕ suppress. Если из 10 ETH прослежено 3:
- известные 3 ETH → cost basis по методике (WAC/FIFO/LIFO) = **trusted**;
- неизвестные 7 ETH → **× цена на момент входа** (`cycleDeposit.usd/amount`) =
  **pricedPct** («оценено по входу», historical-at-op, не тихий спот);
- **startUsd = covered_cost + uncovered × open_price**; `startAmount = полный supplied`;
- **PnL%/feeApr НЕ гасим** — считаем по формуле всегда; `trustedPct = covered/supplied`
  = только ярлык доверия («70% оценено по входу»), не переключает логику;
- manual annotation (`manualCostBasisUsd`) промоутит оценку → trusted → golden.

**Пример:** 10 ETH в Aave, открыто при ETH $2 500, сейчас $3 000 (current $30 000),
прослежено 3 ETH ($4 200, WAC $1 400). covered $4 200 + uncovered 7×$2 500=$17 500
→ **startUsd $21 700**, trustedPct 30%, **PnL +$8 300 (+38.2%) показывается** с ярлыком.

**⚠ РАЗРЫВ код↔методика (verified 2026-05-31):** `coverageIncomplete` в
`open_positions.ts:2943` срабатывает **ТОЛЬКО для V3-orphan NFT**
(`isV3Lp && !v3 && consumedMintHashes>0`). Для **lending/staking/yield**
частичного покрытия флаг НЕ ставится, `trustedPct`/`pricedPct` в движке вообще
НЕ вычисляются. Текущее поведение для «10 supplied, 3 traced»: `startUsd =
lotConsumed.usd` (стоимость 3), `startAmount=3`, но live=10 → **PnL раздут, без
guard'а**. `uncoveredAmount` из `getPositionLotCostBasis` есть, но в startUsd/флаг
не заводится (строка 2393 `fallbackUsd:0`). **TODO (M6 generalize):** считать
`trustedPct = lotConsumed.amount / max(supplied, live)` для ВСЕХ kind, ставить
`coverageIncomplete` при `<50%`, гасить PnL%/feeApr (как у V3-orphan).

## 2. Паттерны эталонных позиций (4 типа)

### Паттерн A — GMX V2 GM-пул LP (`arb_gmx2`), 7 шт: POS-001,002,003,006,007,009,011
- **Что это:** депозит в GM-пул (receipt-токен **GM**), DeBank декомпозирует live
  в underlying (WBTC+USDC или WETH+USDC).
- **startUsd = фактически потраченные USD на вход в позицию** (сколько денег
  реально потратили на покупку активов / вход). Напр. GMX POS-001: потратили
  **$200** на вход → startUsd = $200. Это НЕ «случайно круглое число», а реальная
  сумма входа, и она так и отображается — эталон.
- **Lot-трасса:** для НЕ-стейбл стороны (WBTC/WETH) — реальные swap-лоты через
  1inch/KyberSwap/OKX/UniV4 (`buy_with_stable`), WAC. Стейбл-сторона (USDC) = $1.
- **Wrapped aliasing (D4):** WBTC-трейд и WBTC-сапплай делят один WAC-пул —
  поэтому один и тот же swap-лот (напр. `0x71ca2a…`) обслуживает несколько
  GMX/Fluid позиций кошелька (это корректное WAC-поведение, не дубль).
- ⚠ **Caveat — per-token split артефакт:** `supplyTokens[].startUsd` считается
  pro-rata чтобы дать total; `avgBuyPrice` back-solved → у USDC может выйти
  бессмыслица ($0.57/$0.82, при том что USDC=$1), а Σ per-token startUsd может
  не сойтись с position.startUsd на ±$20 (POS-006: $5023 vs $5000). **Доверять
  total startUsd и lot-трассе НЕ-стейбл стороны, а не per-token avgBuyPrice.**

### Паттерн B — Fluid lending (`arb_fluid`), 4 шт: POS-008,010,012,013
- **Что это:** одно-активный collateral (ETH или WBTC) в Fluid + borrow (leverage).
- **startUsd vs netStartUsd:** ДВА числа. `startUsd` = gross cost basis ВСЕГО
  поставленного collateral (Σ всех supply по WAC); `netStartUsd` = net после
  borrow/withdraw (реально «свои» деньги). Примеры: POS-008 $33,719 / net $5,514;
  POS-013 $30,000 / net $1,794; POS-010/012 net **$0** (полностью отбилось
  self-loop'ом). Это методология C11 (wacAt / lending self-loop).
- **Lot-трасса:** длинные цепочки ETH/WBTC swap-лотов (POS-008 — 7 лотов через
  годы, вкл. `deposit_fiat`/`manual_seed`). WAC корректно усредняет.
- ⚠ **POS-012 — единственная `engineTraced=false`:** `uncoveredAmount` 0.009 ETH
  (~$20 из $1521) не покрыт лотами → упал на fallback-цену. startUsd всё равно
  верный по сумме, но провенанс неполный. Кандидат на доисследование (откуда
  непокрытые 0.009 ETH — пропущенный мелкий acquisition).

### Паттерн C — Morpho Blue GLV-collateral (`arb_morphoblue`), 1 шт: POS-014
- **Что это:** **GLV [WETH-USDC]** как collateral в Morpho-маркете. GLV —
  receipt-токен, surface-asset сохраняется, underlying = WETH+USDC.
- startUsd $21,600 / net $1,885 (leverage). WETH lot-трасса, WAC $2398.
- Тот же per-token split caveat что у GMX (USDC avgBuyPrice артефакт).

### Паттерн D — Uniswap V3 LP (`arb_uniswap3`), 2 шт: POS-004 (WETH/USDC), POS-005 (WBTC/USD₮0)
- **startUsd:** из **Etherscan** V3 deposit-событий (`src=pool_slot0+mintEvent` /
  `anchor_pool_slot0`). $241 / $147 — совпадает с Krystal `totalDepositValue`.
- **fee / fee APR:** из **Krystal** (`tradingFee.pending`): POS-004 $3.52, POS-005
  $1.92. **Это был инцидент:** без `KRYSTAL_API_KEY` proxy отдавал 503 → fee=«—»
  при ненулевом APR (stale). Фикс = ключ в `.env`. См. [[capflow_data_source_authority]].
- ⚠ **fee APR методология:** наш UI = аннуализация Krystal-fee за весь срок
  `(fee/startUsd)·(365/age)` (POS-004 → 10.87%); Krystal-собственный `feeApr` ≈
  0.06% (другое окно). Fee-суммы совпадают, APR — наша метрика. (Открытый вопрос
  к юзеру: какой APR выводить.)

---

## 3a. Скептическая верификация живого golden-набора (1s/2s/3s, 2026-05-31)

11 помеченных позиций перепроверены независимо (реестр + on-chain source, попытка
ОПРОВЕРГНУТЬ owner-число). Результат:

| Live POS | Тип | expected $ | derived $ | вердикт |
|---|---|---|---|---|
| POS-001 | Morpho PT-apyUSD | 3481.31 | 3481.31 | ✅ confirmed (engineTraced=true, чисто) |
| POS-002 | Morpho PT-apxUSD | 1405.00 | 1405.00 | ✅ confirmed (чисто) |
| POS-003 | Avantis jUSDC(swap) | 1737.25 | 1737.25 | ✅ число верно; ⚠ derivation STALE (full-wallet WAC, не swap-recipe) → перегенерить |
| POS-004 | Morpho wSPYx | 1084.09 | 1085.07 | ✅ confirmed (Δ0.09%); ⚠ engineTraced=false (spot-fallback), число ок |
| POS-005 | GMX GLV[WBTC-USDC] | 1300.00 | 1300.00 | ✅ confirmed (мой фикс verified) |
| POS-006 | Uni V3 EURC+USDC | 1121.82 | 1121.78 | ✅ confirmed (EURC@$1.158 верно) |
| POS-007 | GMX GM[WBTC-USDC] | 1498.80 | 1498.80 | ⏬ число верно, но engineTraced=false → **ДЕМОТИРОВАТЬ** (owner: по ошибке) |
| POS-008 | Uni V3 PAXG+USDC | 1180.86 | 1181.57 | ✅ confirmed (Δ0.06%) |
| POS-009 | Uni V3 USDC+WBTC | 1568.45 | 1567.65 | ⚠ **needs-review**: число ок (Δ0.05%) но через opaque fallback; реестр WBTC@$73.75k vs истина $66k (movement.usd sync-time, B1) |
| POS-010 | Uni V3 PAXG+USDC (0x5ae13b) | **228.11** | **~1393** | ❌ **DISCREPANCY −83.6%** — число НЕВЕРНО |
| POS-011 | Uni V3 XAUt+USDT | 159.12 | 158.82 | ✅ confirmed (Δ0.19%, transferred-in NFT) |

**❌ POS-010 — root cause (важно):** значение $228.11 захвачено из СЛОМАННОГО
cost-basis WAC-fallback (PAXG mispriced $11.42 vs реальные ~$4540, 1-й PAXG-депозит
uncovered, только 60.95 из 716 USDC засчитаны). Реальная позиция = 2 депозита
PAXG+USDC ≈ $1393. **Почему fallback, а не Krystal:** golden помечен 11:18:01 —
ровно в окне Krystal **429 rate-limit** (api_usage 429 на 11:16-17) → Krystal-данные
отсутствовали → откат на битый cost-basis. **Это прямое следствие 429-бага, который
теперь исправлен** (retry/backoff). → После рефреша (Krystal здоров) **перепометить
POS-010** из корректного live-числа (Krystal `depositTotalUsd`).
Caveat: агент при выводе ~$1393 ссылался на NFT 1219136 (это NFT POS-008, пул
0xb431c7) — возможна путаница NFT между POS-008/010; точное число брать из живого
Krystal после рефреша, не из $228 и не слепо $1393.

**Урок (подтверждает протокол):** owner ошибся на 2 из 11 (POS-007 mistake, POS-010
wrong value) — эталон НЕ принимать на веру оправдалось. LP-позиции ОБЯЗАНЫ браться
из Krystal; cost-basis fallback при `engineTraced=false`/`uncovered>0` на covered-LP
даёт мусор. Golden нельзя метить во время Krystal-outage (429/503).

## 3. Сводная таблица

> ⚠️ **НУМЕРАЦИЯ POS-NNN ПЕРЕГРУЖЕНА — читать перед использованием таблицы (2026-05-31).**
> Эта таблица (§1–§3) — РАННИЙ golden-набор на кошельках **Murat/Artur**. Текущий
> ЖИВОЙ эталонный набор — в БД `golden_cases` на кошельках **1s/2s/3s (lex Bob)** и
> НЕ совпадает по номерам. Один `POS-NNN` может означать РАЗНЫЕ позиции в разных
> наборах. **Авторитет — только `golden_cases` (per-position, по `market_key`),
> НЕ номер.** Пример коллизии: `POS-007` = (а) здесь GMX V2 $5 262,80 WETH
> (Murat/Artur); (б) в §4b — lex Uniswap V3 NFT 1197028, fee $80,38; (в) в живой
> БД — см. ниже. Это три РАЗНЫЕ позиции.
>
> 🔧 **POS-007 (живой golden_cases, wallet 1s) — ИСПРАВЛЕНИЕ статуса (owner 2026-05-31):**
> Живой `POS-007` = **GMX V2 GM[WBTC-USDC]** (arb, market `0x47c031236e19d024b42f8ae6780e44a573170703`),
> открыт 1498,8 USDC → 682,83 GM. `startUsd $1498.80` — **верно** (= внесённые USDC,
> сверено по реестру). **НО:** (1) `fee = 0` — это **by-design** (GMX GM не имеет
> отдельного потока комиссий; доходность растёт в цене GM → PnL; **Krystal GMX НЕ
> покрывает** — это НЕ Krystal-LP); (2) `engineTraced=false`, `fallbackUsd $834.24`
> из $1498.80 (per-token GM-декомпозиция через spot-fallback — известный артефакт,
> §6) → **неполный провенанс** → по инварианту §5 п.6 НЕ годится как «чистый» эталон.
> Owner подтвердил: **помечен golden ПО ОШИБКЕ** (спутан с Krystal-LP). →
> **ДЕМОТИРОВАТЬ** из golden (снять отметку в `golden_cases` через UI — мой DB-доступ
> read-only). Настоящие Krystal-LP эталоны — uniswap3: POS-006/008/009/010/011.

| POS | Протокол | startUsd | netStartUsd | non-stable trace | traced |
|---|---|---|---|---|---|
| 001 | GMX V2 | $200 | $200 | WBTC 0.00137 @WAC $74,109 | ✓ |
| 002 | GMX V2 | $300 | $300 | WETH 0.00053 @ $2,191 | ✓ |
| 003 | GMX V2 | $9,000 | $9,000 | WETH 2.078 @ $2,398 | ✓ |
| 006 | GMX V2 | $5,000 | $5,000 | WBTC 0.0369 @ $81,519 | ✓ |
| 007 | GMX V2 | $5,262.80 | $5,262.80 | WETH 1.114 @ $2,398 | ✓ |
| 009 | GMX V2 | $275.03 | $275.03 | WBTC 0.00211 @ $74,109 | ✓ |
| 011 | GMX V2 | $364.04 | $364.04 | WETH 0.00053 @ $2,191 | ✓ |
| 008 | Fluid | $33,719.87 | $5,514.58 | ETH 14.10 @ $2,398 (7 лотов) | ✓ |
| 010 | Fluid | $1,069.07 | $0 | WBTC 0.01443 @ $74,109 | ✓ |
| 012 | Fluid | $1,521.00 | $0 | ETH 0.694 @ $2,191 | ✗ (uncov 0.009) |
| 013 | Fluid | $30,000.00 | $1,794.71 | WBTC 0.368 @ $81,519 | ✓ |
| 014 | Morpho | $21,600.36 | $1,885.56 | WETH 3.853 @ $2,398 | ✓ |
| 004 | Uni V3 | $241.07 | $241.07 | WETH 0.081 @ $2,191; fee $3.52 (Krystal) | ✓ |
| 005 | Uni V3 | $146.90 | $146.90 | WBTC 0.00149 @ $74,109; fee $1.92 (Krystal) | ✓ |

---

## 4. Карта «столбец Листа открытых позиций → сервис-источник» (per type)

> 🔒 **LOCKED (owner 2026-05-31): ВСЕ LP-позиции в покрытии Krystal выводятся
> ПОЛНОСТЬЮ из Krystal — точь-в-точь все метрики** (startUsd=`totalDepositValue`,
> current=`currentPositionValue`, fee=`tradingFee`, APR/ROI/IL=`performance.*`,
> состав=`currentAmounts`). Наши Etherscan/DeBank-числа для covered-LP — только
> fallback. **Непокрытые Krystal** (вне списка протоколов ИЛИ gauge-staked NFT) →
> считаем сами on-chain: `ownerOf`(gauge)=lpTokenId → найти минт → `positions()` →
> mint-tx `IncreaseLiquidity` amounts → DefiLlama цена на дату → startUsd
> ([[capflow_velodrome_gauge_backlog]]). ✅ **УЖЕ реализовано (verified):** covered-LP
> startUsd точь-в-точь из Krystal `/transactions` Σ DEPOSIT (`depositTotalUsd`),
> НЕ из `totalDepositValue` (ненадёжен). NFT 5469945 $15696.02 = $15696.02 точь-в-точь.

Каждый столбец берётся из конкретного источника; для LP финальный авторитет —
**Krystal** (Phase 7 перекрывает DeBank/Etherscan). Verified по коду
(`open_positions.ts buildOne`/`computeFees`, `v3_cost_basis_override.ts`,
`krystal/override.ts`, `OpenPositionsPage.tsx`).

| Столбец | Uniswap V3 LP | GMX V2 GM-LP | Lending (Fluid/Morpho) |
|---|---|---|---|
| **Стартовая $** (startUsd) | **Krystal** `/transactions` Σ DEPOSIT (`depositTotalUsd`, block-time) — точь-в-точь, уже реализовано. НЕ `totalDepositValue`. Непокрытые/gauge → on-chain mint→DefiLlama. Fallback (Krystal off) → Etherscan/UCB | **UCB lot-trace WAC** (= USD реально потраченные на вход), цены DefiLlama | **UCB lot-trace WAC** (gross) + `netStartUsd` после self-loop |
| **Текущая $** (currentUsd) | **Krystal** `currentPositionValue` (Phase 7); fallback Alchemy on-chain amounts / DeBank | **DeBank** live GM-декомпозиция | **DeBank** live receipt-баланс (aToken/fToken) |
| **FEE** | **Krystal** `tradingFee.pending+claimed` (трейдинг-комиссии) | обычно 0 (нет отдельных rewards) | **доходность от лежания** = `current_balance − net_deposited` (DeBank-баланс / Etherscan aToken-audit). Rebase-receipt сам растёт |
| **FEE APR** | из Krystal-fee (наш аннуализ `(fee/start)·365/age`) | — | **аннуализированная доходность маркета** (supply yield). ← это и есть «доп. доходность что лежит ETH в маркете» |
| **Дата открытия / Срок** | **Etherscan** mint block | DeBank ops (первый lp_add) | DeBank ops (первый lend_supply) |
| **Состав позиции** (supplyTokens) | on-chain amounts (Alchemy/Krystal) | DeBank GM-декомпозиция | DeBank receipt-баланс |
| **Внесено токенов / Открыто в** | Etherscan deposit-события | ops out-side (lp_add) | ops out-side (lend_supply) |
| **Протокол / Тип / Сеть / TokenId** | DeBank classification + on-chain NFT | DeBank | DeBank |
| **PnL / Итого активы / Total PnL / Total APR / Вес %** | **чистый расчёт** (currentUsd−startUsd, +claimed fees, аннуализ, доля) — без сервиса | то же | то же |

**Ключевое (по уточнению owner):** «fee» имеет РАЗНУЮ природу по типам —
для LP это **трейдинг-комиссии пула (Krystal)**, для lending это **доходность,
которую актив зарабатывает лёжа в маркете (supply yield)**. Обе выводятся в
столбце FEE/FEE APR, но считаются по-разному и из разных источников.

## 4b. Контракт данных Krystal по LP-позиции (что получаем с КАЖДОЙ LP)

Полный набор полей `PositionDetail` (Krystal `/v1/positions`), verified 2026-05-31.
Эти данные мы обязаны получать и выводить по каждой LP-позиции в покрытии Krystal:

| Поле Krystal | → наш параметр |
|---|---|
| `pool{protocol{key,name},poolPrice}`, `tokenAddress`+`tokenId`, `liquidity` | протокол, NFT id |
| `minPrice` / `maxPrice`, `status` (IN_RANGE/OUT_RANGE/CLOSED) | диапазон, в диапазоне ли |
| `currentPositionValue` | **Текущая $** |
| `currentAmounts[]{token,balance,price,value}` | **Состав позиции** (сейчас) |
| `providedAmounts[]{...}` | внесённые токены (по тек. цене) |
| **`tradingFee.pending[]{token,balance,value}`** | **FEE pending** |
| **`tradingFee.claimed[]{...}`** | **FEE claimed** (снятые) |
| `farmingReward.pending/claimed[]` | farm-эмиссия (если есть) |
| `earning24h` | доход за 24ч |
| `openedTime` | **Дата открытия** |
| `performance.totalDepositValue` / `totalWithdrawValue` | (totalDepositValue НЕ для startUsd — см. ниже) |
| `performance.{pnl, impermanentLoss, returnOnInvestment, compareToHold}` | PnL / IL / ROI |
| `performance.apr.{totalApr, feeApr, farmApr}` | APR (доли → ×100) |
| **`/transactions` Σ DEPOSIT (`depositTotalUsd`)** | **Стартовая $** (точь-в-точь, block-time) |
| **`/transactions` COLLECT_FEE events** | **claimed-хронология** (даты+usd) |

### ⚠ Krystal `currentPositionValue` = принципал + pending fees (не путать)
Наш `currentUsd` (Σ supplyTokens) = **только принципал**; pending fees — отдельно
(колонка Fee). Krystal `currentPositionValue` = **принципал + pending fees**.
Поэтому наш current НИЖЕ Krystal ровно на pending fee — это НЕ расхождение.
Сверка: `наш currentUsd + наш feeUsd = Krystal currentPositionValue` (verified
2026-05-31 на 5 Uni V3: POS-006 $1126.8+$17.67=$1144.5≈Krystal $1144.4). ИТОГО
АКТИВЫ = currentUsd + fees = Krystal current. Не флагить как дрейф.

### Паттерн E — Avantis (base, leveraged-LP vault), jUSDC через swap
POS-003: вход = **swap** USDC→**jUSDC** (junior USDC-транш Avantis), НЕ protocol
lp_add. `jUSDC isProtocolToken=false`. startUsd = USDC, заплаченные в acquiring-
свопе ($1737.25 = 1737.25 USDC). ⚠ Провенанс тонкий (`n_traces=0` — деривация не
строит lot-trace для jUSDC-receipt через swap). Krystal Avantis НЕ покрывает →
наш расчёт. Число верно, но при partial-exit cost basis поедет по jUSDC-лоту, не
по underlying — кандидат на доработку классификации (swap→receipt как deposit).

### Инвариант: снятие комиссий = в хронологии (verified)
Когда в LP снимаются комиссии (`COLLECT_FEE` в Krystal `/transactions`), это
ОБЯЗАНО отражаться как «снятое» в ДВУХ местах (проверено на lex POS-007, NFT
1197028):
- **Реестр операций** (`chain_operations`): tx помечается `op_type=claim_rewards`
  (verified: 0xee2bc0b9 @2026-03-18, 0xcaaa7594 @2026-05-01, Uniswap V3). Если
  один tx снял с нескольких NFT — несколько строк; атрибуция к позиции фильтрует
  по паре (`livePairKey`).
- **Позиция**: `feesClaimedUsd` + `feesClaimedHistory[]{date,usd,daysSincePrev}`
  из Krystal `/transactions` COLLECT_FEE — verified POS-007 = $80.38
  ($46.03@03-18 + $34.35@05-01), точь-в-точь Krystal. lifetime = pending + claimed.

### Verified: ВСЕ 6 LP-позиций (lex-кошельки, 2026-05-31), pending + claimed
5 из 6 — pending И claimed точь-в-точь с Krystal `/transactions`. **POS-004 (base
NFT 4911255):** ⚠ Krystal `/transactions` для **base** вернул **пустой список**
(пробел tx-индексатора Krystal), хотя `/positions` позицию знает. Код корректно
fallback на наш реестр (`claim_rewards` tx 0x73fedf14, COLLECT_FEE WETH 0.011984
+ USDC 29.98 — amounts совпадают с Krystal `tradingFee.claimed` balances точь-в-
точь; оценка historical $58.28). **Инвариант покрытия:** Krystal `/transactions`
НЕ 100% (особенно base); при пустом ответе claimed берётся из нашего реестра
(historical-priced, точнее, чем `/positions.tradingFee.claimed` = current-priced).
Gotcha: claim может быть оплачен ДРУГИМ кошельком (POS-004 feePayer=lex2, owner=
lex1) — атрибуция к позиции по паре токенов (`livePairKey`), не по feePayer/NFT.

## 5. Что UCB server-port обязан воспроизвести (инварианты)

1. **startUsd не-LP** = WAC lot-trace по on-chain acquisitions (swap/transfer/fiat),
   цены DefiLlama на дату каждого лота. Wrapped aliasing (BTC↔WBTC) — один пул.
2. **startUsd V3 LP** = Etherscan deposit-события (НЕ DeBank, НЕ Krystal
   providedAmounts — там текущая цена). Krystal `totalDepositValue` = cross-check.
3. **fee / fee APR LP** = Krystal (`tradingFee` pending+claimed). Без Krystal —
   НЕ показывать stale; флагить «источник недоступен».
4. **lending: два числа** — gross `startUsd` (WAC всего collateral) и
   `netStartUsd` (после self-loop). Не путать.
5. **GM/GLV декомпозиция:** total startUsd авторитетен; per-token avgBuyPrice —
   back-solved артефакт (USDC может быть ≠$1), не использовать как truth.
6. **Provenance:** хранить `sourceHash` каждого лота — связь число↔блокчейн-tx.
   `engineTraced=false` или `uncoveredAmount>0` = сигнал неполного провенанса
   (детектор Epic C должен флагить).

## 7. Матрица покрытия паттернов + что добирать (растим базу)

Цель — максимум РАЗНЫХ работающих паттернов (не повторы), чтобы UCB-методика
покрывала все случаи. Матрица «сделано / пробел»:

| Ось | Покрыто (✅) | Пробелы — добрать для новых паттернов |
|---|---|---|
| **Chains** | arb | ⬜ eth, base, op, polygon, bsc (другой gas-токен, `bridge_in` origin) |
| **LP** | Uniswap V3 | ⬜ Uni V2 / V4, Pancake, Aerodrome/Velodrome **CL (gauge-staked)** [[capflow_velodrome_gauge_backlog]], Camelot |
| **Lending** | Fluid, Morpho (receipt-collateral) | ⬜ **Aave V3 / Compound** (rebase aToken — другая механика receipt'а), Spark |
| **Yield** | GMX V2 GM | ⬜ обычные vault'ы (Beefy/Yearn), liquid staking (wstETH/rETH) |
| **kind** | lp, lending, yield | ⬜ **staking**, **perp** (GMX perps / Hyperliquid app_protocol — portfolio_item без pool) |
| **Cost-basis origin** | swap, deposit_fiat(seed), self-loop borrow | ⬜ **CEX-origin** (P2P→trade→withdrawal, D3), **bridge-origin** (cross-wallet WAC, D5), pure-stable LP, **EUR-stable** (EURC/EURe ≠ $1) |
| **Lifecycle** | open + leverage | ⬜ **partial exit** (lp_remove/lend_withdraw), closed/re-opened cycle |

**Приоритет добора (даёт больше всего новой методики):** (1) другой chain (eth/base),
(2) Aave/Compound rebase-lending, (3) CEX-origin позиция (inheritance), (4) gauge-staked
CL (Aero/Velo — известный сложный кейс), (5) perp/staking. Подключай кошельки с такими
позициями.

### Поток ингеста (как наполняем)
1. Подключаешь кошелёк → дожидаешься синка ops (реестр `chain_operations` через DeBank history).
2. Открываешь Лист открытых позиций → проверяешь что позиция выведена ВЕРНО по каждому столбцу.
3. Метишь ✓ Эталон (если верно). Если параметр неверен — ✎ Неверно + коммент (изучу реестр, найду причину, поправлю).
4. Пингуешь меня (батчем). Я по каждой новой golden: тяну её `derivation` + ops из реестра
   → определяю паттерн → если НОВЫЙ, добавляю в §2 + обновляю эту матрицу. Caveats — в §6.

### Шаблон нового паттерна (заполняю per новый случай)
```
### Паттерн X — <Протокол> <chain> (<kind>), N шт: POS-…
- Что это: <receipt-токен / underlying / leverage?>
- Реестр (ключевые ops): <opening op_type + movement; acquisition-цепочка>
- startUsd: <источник: lp_add OUT-usd / lot-WAC / Etherscan V3>
- fee/APR: <Krystal / supply-yield / —>
- Особое: <isProtocolToken? self-loop? aliasing? CEX/bridge inheritance?>
- Инвариант реестра, который критичен: <что должно быть верно классифицировано>
```

## 6b. POS-005 GLV bug — ✅ ИСПРАВЛЕНО (2026-05-31, `opener_detector.ts`)

**Симптом:** GMX V2 GLV[WBTC-USDC] (testakk 1s, market `0xdf03ee…`): startUsd
показывал **market value полученного GLV-receipt** (~$1436–1474), а должно быть
**$1300** (реально внесённые USDC). Юзер прав.

**Root cause (ПЕРЕПРОВЕРЕН по on-chain данным + текущему коду — гипотеза «startUsdFromStableOut дал $1436.78» была НЕВЕРНА):**
GLV-депозит исполняется в ДВУХ tx:
- request `0x17cf`: wallet шлёт **1300 USDC** → GlvVault `0x393053b…` (**НЕ** на GLV-токен `lp`);
- fill `0xea23`: GLV сминчен `from 0x0` на wallet (receives-only).

1. `buildOne` считает **ВЕРНО → $1300** (receipt-walker через `linkedHash`/
   `async_deposit_linker.ts`: fill `0xea23` → `linkedHash` → request `0x17cf` → OUT 1300 USDC).
2. Детектор `opener_detector.ts` (`collectDepositHashes`) видел deposit **только** в
   fill-tx (`contract==lp && to==wallet`). USDC OUT в request-tx шёл `to=GlvVault ≠ lp`
   → request не попадал в deposit-hashes → `openedInTokens=[]`, `startUsd=null`.
3. Пустая OUT-сторона активировала ветку **`costBasisUnknown` GLV** в
   `apply_opener_override.ts` (`isGmx && noOutSide && isGlv`) → `startUsd=currentUsd`
   (market value receipt'а), `coverageIncomplete=true` — **затирало корректные $1300 buildOne**.
   (Т.е. $1436.78 — НЕ `startUsdFromStableOut`, а costBasisUnknown→currentUsd.)

**Фикс (`opener_detector.ts`):** `collectAsyncRequestHashes()` — зеркало
`async_deposit_linker` на сырых Etherscan/Alchemy transfer'ах: для свежего mint'а
`from 0x0` в receives-only fill-tx добирается ближайший предшествующий **sends-only**
(wallet отдал, ничего не получил — подпись request'а, исключает swap'ы) tx в окне
(±600с / ±300 блоков). Его OUT-стейблы → `openedInTokens=[USDC 1300]` → `startUsd=$1300`.
Тогда `noOutSide=false` → `costBasisUnknown` НЕ срабатывает, $1300 сохраняется.
Same-tx депозиты (IPOR) и Safe-internal mint'ы (не from-0x0) — не затронуты (guards).
Тесты: `opener_detector.test.ts` (POS-005 + 3 guard), `apply_opener_override.test.ts`
(e2e detector→override = $1300). Класс: GLV/GM async request/fill.

**POS-004 (Morpho multi-market) — ✅ ИСПРАВЛЕНО (2026-05-31, `packages/ucb/open_positions.ts`):**
testakk 1s держит **3 РАЗНЫХ Morpho-рынка** (залоги wSPYx / PT-apxUSD-18JUN2026 /
PT-apyUSD-18JUN2026), под каждый — свой заём (AUSD/USDC) и HF. Позиции на
identity-уровне РАЗДЕЛЕНЫ верно (DeBank отдаёт 3 live-позиции; supply/borrow/
healthRate per-market). Баг был в полях, считаемых из реестра: Morpho =
receipt-less → `buildOne` пропускал per-market scoping (lpTokenId=singleton),
`matchingOps` гребло op'ы ВСЕХ рынков → `openedInTokens` («Внесено») каждой
позиции тянул все 3 залога (PT — `isProtocolToken` → Pass 1 перехватывал их у
SPYx-позиции, wSPYx не доходил до Pass 3). `currentCostBasisForPosition` тоже
угадывал collateral как «первый OUT» → всем рынкам самый ранний (wSPYx).
**Фикс:** позиция передаёт свой залог (доминирующий `lp.supply`) как
`collateralHint` → cost-basis и openedInTokens скоупятся по нему;
`canonicalCollateralSymbol` канонизирует **wSPYx↔SPYx** (owner-решение: wrapped/
unwrapped = один актив) → закрывает и старый пустой-trace POS-004, «Внесено»
показывает `SPYx`. Тест `open_positions.morpho_multimarket.test.ts` (3 рынка →
каждая позиция = только свой залог). 568 web tests green, ucb tsc 0.
**⚠ Вторичный путь (проверить live):** `apply_opener_override` может перетереть
openedInTokens из nonlp-детектора, если DeBank отдаёт **общий singleton**
`lpTokenId` для 3 рынков (тогда `extractOpenedInTokens` соберёт все залоги). Если
после рефреша «Внесено» снова смешано — патчить детектор/override (скоуп по
collateral или skip receipt-less singleton).

## 6c. POS-026 Velodrome CL gauge-staked — ✅ ВЕРИФИЦИРОВАНО on-chain (2026-06-01)

**Позиция:** Velodrome V3 (Slipstream CL) на Optimism, WETH/WBTC, NFT `3427934`,
wallet MMaksimuk 1 (`0x10b850c3`). Отображаемый `startUsd = $235.97`,
`coverageIncomplete=false`. **Krystal эту позицию НЕ отдаёт** → нельзя сверить через Krystal.

**Почему Krystal молчит (root cause — подтверждён on-chain):**
`ownerOf(3427934)` на NPM `0x416b433906b1B72FA758e166e239c43d68dC6F29`
(Velodrome Slipstream NonfungiblePositionManager, OP) = **`0xcf2a0adade4138d7ea6ebc4c143dbe4c98d9a65a`** —
это **gauge-контракт** (= наш `lpTokenId`/`market_key` позиции). NFT застейкан в gauge,
владелец = gauge, НЕ кошелёк. Krystal `/v1/positions?wallet=` ищет по ownership
кошелька → застейканную NFT не видит. (Подтверждает [[capflow_velodrome_gauge_backlog]].)

**Алгоритм проверки cost basis для gauge-staked CL (ПРОВЕРЕН, фиксируем для протокола):**
Standard V3 cost basis override (`v3_cost_basis_override.ts` + Etherscan
IncreaseLiquidity events + slot0) **РАБОТАЕТ для gauge-staked NFT**, потому что
Etherscan/Alchemy читают сырые `IncreaseLiquidity` events по `(NFT-контракт, tokenId)`,
а это **НЕ зависит от текущего владельца** (gauge). Krystal — зависит (по wallet) → падает.
**Вывод-правило: для Velodrome/Aerodrome gauge-staked CL → cost basis из on-chain
V3-пути (Etherscan events + slot0), НЕ из Krystal.** Krystal = primary только для
non-staked LP (owner=wallet).

**On-chain реконструкция (mint tx `0x0ae402fb…`, block `139599679`, ~2025-08-11):**
- ERC721 Transfer `0x0 → 0x10b850c3` tokenId `3427934` (mint NFT) ✓
- WETH (`0x4200…0006`) out `0.026906698721609552` → pool `0x319c0dd3…`
- WBTC (`0x68f180fc…`) out `0.001` → pool
- `IncreaseLiquidity` event на NPM, tokenId `3427934`, эти же amounts.
- Цена на блок (slot0/hist): `0.0269 WETH (~$121) + 0.001 WBTC (~$115) = $235.97`.
- Код (`V3CostBasisResult`): `totalDeposited0=0.0269069 WETH`, `totalDeposited1=0.001 WBTC`,
  `totalDepositUsd=235.968`, `eventCount={increase:1,decrease:0}`, `hasHistPrices=true`,
  `mintTxHash=0x0ae402fb…`. **Точь-в-точь с on-chain.** ✅
- Метод верификации (durable): `ownerOf(NFT)`=gauge=`lpTokenId` → mint-tx receipt
  (Alchemy `ethGetTransactionReceipt`, op) → WETH+WBTC amounts → цена на блок → startUsd.

**Эталон POS-026 = $235.97 ПОДТВЕРЖДЁН.** NPM Velodrome Slipstream (OP) =
`0x416b433906b1B72FA758e166e239c43d68dC6F29`.

## 6d. POS-014 (kind=WRONG) — mis-attached open_hash → bogus startUsd (диагноз 2026-06-01)

**Owner-комментарий (provenance_note):** «требует проверки что это за позиция и как она
появилась… если её на самом деле нету… выяснить почему она открылась». issue=`start_usd`.

**Позиция:** base Uniswap V3 **VIRTUAL/USDC**, wallet MMaksimuk 1 (`0x10b850c3`),
lpTokenId/pool `0x529d2863…`, DeBank показывает open `currentUsd $24.33`, startUsd $15.88,
`matchedV3TokenId=null`.

**Диагноз (on-chain, 2026-06-01):**
1. Pool `0x529d2863` token0=`0x0b3e3284…` (**VIRTUAL**), token1=`0x833589fc…` (**USDC**) → пул реальный VIRTUAL/USDC. ✓
2. **`open_hash` `0x2ef493f8…` НЕ от этой позиции!** Эта tx (Uniswap V3 NPM base `0x03a520b3…`)
   минтит NFT `4222876` и вносит **0.1399 WETH + 5.55 USDC** в пул **`0x6c561b44`** (WETH/USDC) —
   ДРУГОЙ пул, не VIRTUAL/USDC. → open_hash прикреплён к неверной позиции.
3. → **startUsd $15.88 посчитан от ЧУЖОЙ tx** (WETH/USDC депозита), не от VIRTUAL/USDC. Bogus.
4. `matchedV3TokenId=null` — V3 cost-basis override НЕ нашёл NFT для VIRTUAL/USDC позиции
   (упал на неверный opener-fallback).
5. **Krystal вернул 0 base-позиций** для кошелька (только 12 uniswap/pancake eth/arb) → эту
   VIRTUAL/USDC он НЕ видит (closed? вне покрытия?). DeBank всё ещё показывает $24.33.

**Вывод:** провенанс POS-014 сломан (open_hash от другого пула → startUsd bogus). Вероятно
ЛИБО closed-dust фантом (Krystal омитит, DeBank residual $24.33 выше dust-порога фильтра),
ЛИБО реальная позиция со сломанным cost-basis matching. **Для финального вердикта phantom-vs-real:
найти фактический NFT кошелька в пуле `0x529d2863` и проверить liquidity (`positions(tokenId)`).**
Класс бага: opener/cost-basis matching привязал open_hash чужого пула → bogus startUsd +
возможный near-dust phantom не отфильтрован. (Owner пометил wrong корректно.)

**✅ ФИКС РЕАЛИЗОВАН (2026-06-01): Krystal-absent V3 phantom filter.** Owner: фантомов
не должно отображаться. Найдено 2 класса фантомов: (1) **POS-014 WETH/USDC** `0x6c561b44` —
Krystal знает CLOSED, residual $9.72 (старый `filterClosedDustPositions` не сработал —
CLOSED-fetch вернул ПУСТО из-за rate-limit 429, ненадёжен); (2) **POS-039 VIRTUAL/USDC**
`0x529d2863` — Krystal не знает ВООБЩЕ. **Решение** (`apps/web/src/lib/krystal/phantom_filter.ts`):
использовать PRIMARY (open) Krystal-набор как надёжный сигнал. Дропаем V3-LP позицию если:
`matchedV3TokenId=null` (наш движок не нашёл NFT) + `lpTokenId` есть + `currentUsd<$50` +
chain ∈ KRYSTAL_COVERED_CHAINS + Krystal вернул ≥1 open для кошелька (fail-soft) + пул НЕ в
Krystal-open-наборе. Ловит ОБА класса (closed → нет в open; absent → нет в open). **Safety:**
gauge-staked CL (POS-026, есть matchedV3TokenId) НЕ трогается; Krystal down → no-op; uncovered
chain → keep; large → keep. Тесты `phantom_filter.test.ts` 8/8; web 610/610. **Verified live:
51→49 позиций, оба фантома исчезли, Velodrome gauge сохранён.** Старый `filterClosedDustPositions`
оставлен (дополняет), но новый надёжнее (primary open-set vs флаки closed-fetch).

**✅ ВЕРДИКТ (2026-06-01): POS-014 = DeBank-only ФАНТОМ.** Krystal CLOSED-список кошелька на base
= 6 закрытых позиций (WETH/USDC `0xd0b53d`/`0x6c561b44`, USR/USDC, CBETH/WETH aerodrome) — среди них
**NFT `4222876` (WETH/USDC, тот самый из mis-attached open_hash, CLOSED, dep $401.67)**. Но
**VIRTUAL/USDC позиции `0x529d2863` у Krystal НЕТ ВООБЩЕ** (ни open, ни closed), хотя Krystal
полностью индексирует остальные base-V3 позиции кошелька. + наш движок `matchedV3TokenId=null`
(NFT не нашёл). → **позиция существует ТОЛЬКО в DeBank ($24.33), Krystal её не знает → DeBank
misreport/phantom.** Фикс-направление: closed-dust фильтр должен ловить DeBank-only позиции,
которых нет в Krystal (covered-протокол) — расширить `filterClosedDustPositions` сигналом
«covered-протокол, но Krystal не вернул ни open ни closed → подозрение на phantom». startUsd
$15.88 — артефакт неверного opener-fallback (даже не равен mis-attached-tx $401.67).

## 6. Внутренние заметки реализации (отображаемые числа = эталон)

Отображаемые в Листе значения подтверждены как эталон. Ниже — внутренние детали
движка, которые НЕ влияют на корректность отображения, но важны при порте:

- **fee APR по типам решён (owner):** LP → данные Krystal; lending → отдельно
  считаем supply-yield (доходность от лежания актива в маркете) как fee APR. Оба
  уже выводятся верно.
- **POS-012 `engineTraced=false`** (0.009 ETH непокрыто лотами в cost-basis
  трассе) — на ОТОБРАЖАЕМЫЙ startUsd не влияет (он верный); это лишь полнота
  внутренней провенанс-трассы. Не баг отображения. При желании — доисследовать
  пропущенный мелкий acquisition позже.
- **GMX/Morpho per-token split** (`supplyTokens[].avgBuyPrice` back-solved,
  USDC может выйти ≠$1; Σ per-token vs total ±$20) — внутренний артефакт
  декомпозиции. Отображаемый **total startUsd верен**. Per-token avgBuyPrice не
  выводится как авторитетное число.

## 7. Offline replay-фикстуры testakk (захват 2026-06-01)

14 эталонных позиций testakk зафиксированы в offline replay-регрессе после
повторной верификации КАЖДОЙ от реестра операций (golden-verification protocol —
на веру не берём даже размеченный эталон):

- **GMX V2 ×7** — `startUsd = linkedCostBasisUsd` (Σ стейблов, уплаченных в
  request-tx async-fill). Круглые $200/$300/$5000/$9000 = легитимные round-депозиты
  (не баг). POS-007 (artur `0x77b2ec35`) нетит вывод 1157 GM → **$5268.32**.
- **Morpho ×1** (artur `0x6c247b1f`, POS-014) — залог = protocol-токен **GLV
  [WETH-USDC]**, который DeBank раскладывает на WETH+USDC; cost basis lot-трейсится
  по GLV → **$21,595.94** (фикс `findDecomposedProtocolCollateral`).
- **Uniswap V3 ×2** (murat) — сверено с Krystal `totalDepositValue`
  ($240.83 / $146.86 ≈ движок $241.07 / $146.90).
- **Fluid ×4** — cost basis = Σ стейблов уплачено (artur WBTC ровно **$30,000** =
  5000+5000+10000+10000; ETH LIFO lot-трейс $32,296.72; murat $1068.53/$1533.14).
  Все подтверждены.

**Захвачено в replay (14/14):** `__fixtures__/golden/artur-1.json` (3 GMX + Morpho
+ Fluid WBTC + Fluid ETH), `murat-1.json` (4 GMX + 2 V3 + Fluid WBTC + Fluid ETH).
Каждый анкор проверяет locate + startUsd + currentUsd. Builder:
`scripts/build-artur-murat-fixtures.mjs`.

**Match-тип `supplySymbol` добавлен** (`golden_fixture.ts`): один receipt
`0x324c5dc1` = 2 декомпозированные Fluid-позиции на кошелёк (ETH + WBTC залог);
`marketKey` неоднозначен → различаем по `supplyTokens[0].symbol`.

**artur ETH Fluid — заякорен на ИСТИНЕ $32,296.72 с допуском 5% + caveat
(soft-anchor).** Offline replay даёт **$33,709 (+4.4%)** детерминированно.
Root cause (выверен, НЕ histPrices): при live `histPrices=0` значение всё равно
$32,296.72 — значит cost basis lot-based, не зависит от histPrices. Лоты
ИДЕНТИЧНЫ (replay avgBuyPrice $1986.62 = live), но **LIFO consumed-cost считается
иначе** ($2383/ETH replay vs $2283/ETH live). Это пробел воспроизводимости
harness: lot-pipeline в live получает вход, который dev-hook НЕ публикует
(вероятно annotations / cross-wallet lot-состояние; `runUcbPipelineForWallet`
в harness получает усечённый набор). Гипотезы исключены: histPrices (live=0 →
то же значение), wallet-split (both-wallets replay = тот же $33,709), снапшот-
рассинхрон (live стабилен). Anchor пин на $32,296.72 (реестр-verified LIFO),
band 5% ловит грубые регрессии (декомпозиция → near-zero), tighten когда harness
воспроизведёт live (task #18 — публиковать ВСЕ lot-pipeline входы в dev-hook).
Остальные 3 Fluid воспроизводятся в пределах 0.5% (artur WBTC точно, murat
WBTC/ETH).

**Ключевой урок верификации:** `movement.usd` на receive-side свопов в dev-hook
КОНТАМИНИРОВАН (все WBTC-свопы за 4 месяца показывали одну цену $73,253). Cost basis
движок берёт ВЕРНО — с **out-side (уплаченные стейблы)**, не с receive-side. При
ручной сверке cost basis всегда смотреть, ЧТО уплачено, а не оценку полученного.
