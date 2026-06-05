# Апгрейд классификатора операций: `unknown`→0, любой протокол (план, 2026-06-04)

Сгенерён workflow'ом (карта кода + характеристика unknown + словарь topic0 → синтез). План, не код.

## ✅ ПРОГРЕСС topic0-лестницы (2026-06-04, вечер)
- **Этап 0 (фундамент) DONE** — `packages/ucb/src/topic0_dict.ts` (commit `1569615`): чистый
  словарь выверенных сигнатур (ERC4626/UniV2/V3/V4-swap/Aave V2+V3/Compound v2+v3/Curve/
  Convex/Synthetix/Lido/ether.fi/Morpho) + резолв коллизий по категории + `classifyByTopic0`
  (главное событие по рангу, шум Transfer/Approval пропущен) + `detectDataDecodeFamily`.
  В shared-пакете (без web/api drift). Тесты 16/16.
- **Этап 2a (проводка) DONE** — `classifier.ts`: `ClassifyContext.logsByTxHash` (опц.) →
  `doClassify` сразу после failed зовёт `classifyByTopic0`; уверенный topic0 выигрывает
  (op_type + note `topic0:<event>`), иначе старая лестница (сеть безопасности). Без логов =
  no-op, **ноль регресса**. Capability серверная (web не трогаем). Тесты +4 (classifier 462/462).
- **Этап 1 (log-fetch enrichment) — ОСТАЛОСЬ.** Тяжёлая внешне-API инфра, гейтить за рубильником
  (#136-139) + **shadow-diff перед флипом**. Безопасный порядок:
  1. **Shadow-diff СКРИПТ** (read-only, БЕЗ правки live-refresh): ops аккаунта из
     `chain_operations` → per (chain,tx_hash) `viem getTransactionReceipt` → logs
     `[{address, topic0: topics[0]}]` → `classifyByTopic0` → дифф topic0 vs текущий `op_type`
     (agree/disagree/no-signal). Переиспользовать `makeV3Client` (`v3/positions.fetch.ts:41`) +
     `alchemyHostForChain` (`integrations/alchemy.ts`). Rate-limit + кэш по tx_hash. Прогнать
     на 1 аккаунте, отревьюить дифф.
  2. **Live wiring (за НОВЫМ флагом):** `chain_classifier.service.ts::analyzeAccount` фетчит
     receipts → `logsByTxHash` → в `classifyHistory`. Per-account → дифф → broaden.
  3. **DATA-декодеры** GMX/Fluid/UniV4 ModifyLiquidity (имя/знак в data; нужны полные topic0
     GMX EventLog1/2 + Fluid LogOperate — выверить on-chain).
- **✅ Shadow-diff СКРИПТ собран + прогнан на Alice** (`apps/api/scripts/classifier-topic0-shadow.mts`,
  read-only): 95 tx → **52 agree / 16 disagree / 27 no-signal / 0 no-receipt**. Разбор 16 расхождений =
  shadow-diff поймал, что topic0 КАК ЕСТЬ **регрессировал бы**:
  - ✅ topic0 прав: V3 pool Burn `unstake→lp_remove` (DeBank мислейбл).
  - ❌ **дыра DATA-decode → регресс:** зап `lp_add→swap` (V4 ModifyLiquidity + часть Curve-arity не
    видны словарём → topic0 падает на Swap). 4 случая.
  - ⚠ **мульти-action (log_index=0):** fee-collect `claim_rewards→lp_remove` (V3 `decreaseLiquidity(0)`
    эмитит pool Burn amount=0 + Collect; словарь зовёт Burn→lp_remove по рангу — НЕВЕРНО для fee-collect,
    нужен data-decode Burn amount=0→collect). 5 случаев. Morpho `borrow↔WithdrawCollateral` в
    leverage-петле — 3 случая.
- **✅ DATA-декодеры V4 + V3 сделаны** (commit `db65d90`): V4 ModifyLiquidity (знак int256) + V3 pool
  Burn (amount=0→claim_rewards). Повторный shadow-diff Alice: disagree 16→14, fee-collect'ы (amount=0)
  теперь корректно claim. `dump-tx-topics.mts` — инструмент self-extending loop (дамп topic0 логов tx).
- **🔎 НАХОДКА по остатку `lp_add→swap` (НЕ data-decode!):** дамп логов 2 спорных tx показал — это
  **аггрегатор/зап**: юзер депозитит в yield-vault `@0x88888888…` (его user-facing событие
  `0xd3c1d9b397236779b29ee5b5b150c1110fc8221b6b6ec0be49c9f4860ceb2036` нам НЕИЗВЕСТНО), vault ВНУТРИ
  свопает на Curve TokenExchange / V4 Swap. ModifyLiquidity/AddLiquidity вообще НЕ эмитятся → декодеры
  не помогут. topic0 берёт внутренний своп → неверно. **ФИКС (follow-up):** (а) self-extending loop —
  `getContractAbi(0x88888888)` → опознать `0xd3c1d9b3` → добавить в словарь как deposit; (б)
  **contract-aware ранжировка**: события tx-target контракта важнее внутренних pool-свопов (Swap от
  DEX-пула не должен перебивать user-facing deposit). Morpho `borrow↔WithdrawCollateral` (3) — multi-action,
  нужен реальный log_index.
  **ВЕРДИКТ: НЕ флипать topic0 live до фиксов.** ПРЕРЕКВИЗИТЫ перед живым вживлением (этап 1.2):
  (а) DATA-декодеры V4 ModifyLiquidity (знак int256) + Curve-arity покрытие; (б) co-event/amount правила:
  V3 pool Burn amount=0 → claim_rewards (а не lp_remove); Swap проигрывает liquidity-событию даже когда
  оно data-decode; (в) расширить словарь недостающими Curve-arity. Затем **повторный shadow-diff →
  0 неожиданных регрессов** → только потом live за флагом. Curve/V4 zaps + V3-fee-collect — главные цели.

## Текущее состояние (карта)
Классификатор — `apps/api/src/modules/classifier/classifier.ts`, ядро `doClassify` (:86).
**DeBank-history-driven, НЕ событийный:** роутит по `protocol.category` + направлению движений
(`sends`/`receives`) + ролям токенов (`isProtocolToken`/`isReceiptOfProtocol`/`isStableSymbol`),
`cate_id` только для approve, `fnName` — в 2 узких guard'ах. topic0 НЕ используется.
⚠ **Зеркало в `apps/web/src/lib/portfolio/classifier.ts`** — менять в обоих (drift-риск).
⚠ `chain_operations`: `op_type` — колонка, остальное (protocol/movement/fnName) в `raw` jsonb;
`log_index` ХАРДКОД 0 → одна строка на `wallet+tx_hash` (мульти-action wrapper хранит ОДИН op_type).

## Что в `unknown` (69 строк, все кошельки)
- **6 материальных, mis-bucketed** (±$10k реального PnL): `redeemDelegations`×4 (+$6828),
  `execute`×2 (−$3464) — smart-account/router wrappers (ERC-7710); классификатор смотрит на ВНЕШНИЙ
  `fnName` и сдаётся, хотя movement заполнен (UNI-V3-POS in→lp_add, aArbWETH in→Aave supply, …).
- **9 под-захвачено**: UniV3 `collect` (eth+arb) — fee-claim, но DeBank вернул пустой movement.
- **54 шум**: points `bulkAddFxtlPoints`×21, approvals×4, referral, пустые transfer×25.

## Целевой дизайн — событийная лестница (первое совпадение)
| Ступень | Сигнал | Прим. |
|---|---|---|
| 0 | `failed` (`tx.status==0`) | без изменений |
| 1 | **topic0-словарь (НОВЫЙ PRIMARY)** | каждый лог tx → op_type по словарю; коллизии — по emitting-контракту/со-событиям; DATA-decode семейства (GMX/Fluid/V4/Curve) |
| 2 | имя метода `fnName` | только ПОСЛЕ topic0; НЕ для wrapper'ов (execute/redeemDelegations/multicall) |
| 3 | DeBank send/receive/approve + текущая лестница | весь нынешний классификатор = safety-net (ничего корректного не регрессирует) |
| 4 | эвристика по движению | IN→deposit/lp_add/supply; OUT→withdraw; NFT-протокол-токен in→lp_add; нет движения+value-less селектор→noop |
| 5 | `unknown` | теперь НЕдостижимо для value-bearing; любой хит → feedback loop, не тихая запись |

**Инверсия:** topic0 авторитетен и протокол-агностичен; fnName — вторичная подсказка; DeBank-логика
— сеть безопасности. Это убивает «wrapper fnName → сдаюсь».
**Предусловие:** текущий путь НЕ тянет receipts. Добавить log-fetch enrichment (eth_getTransactionReceipt
/Alchemy, кэш по tx_hash) → `logs[]` в `doClassify`. Нет логов → graceful degrade на ступень 3 (как сейчас).

## Где менять (file:line, выверено)
- `classifier.ts:36` `classifyHistory` + `:86` `doClassify` — прокинуть `logs[]`.
- `chain_classifier.service.ts` `analyzeAccount()` — добавить log-fetch enrichment ДО classify.
- После `classifier.ts:93` (`classifyProtocol`) — новый `classifyByTopic0(logs,movement,protocol)` ПЕРЕД лестницей.
- `classifier.ts:299` (unknown fallback) — заменить на эвристику движения (ступень 4); unknown только если movement пуст И селектор не allowlist-noise; `notes:["unknown:no-signal"]`.
- `classifier.ts:441` (dex unknown) — то же; V3 `Collect` topic0 → claim_rewards (фикс 9× collect).
- `junk_filter.ts:80/97` — разделить `junk:empty_movement` на `_inherent` (approve/points = noop)
  vs `_needs_backfill` (value-bearing селектор без movement → бэкфилл, не дропать).
- `types.ts` — добавить `topic0` + `classifiedBy:"topic0"|"fnName"|"movement"|"unknown"` в `ClassifiedOp` (для feedback-скана из `raw`).
- НОВЫЙ `topic0_dict.ts` (+тест) — словарь + collision-resolver + GMX/Fluid/V4/Curve data-decode dispatch.
- Зеркалить в `apps/web/.../classifier.ts` ИЛИ вынести словарь+лестницу в shared `packages/*` (убрать drift).

## Приоритет фиксов
- **P0 ✅ DONE (2026-06-04, condescending-fermi)**: 6 wrapper-строк классифицируются по
  МАТЕРИАЛЬНОМУ (≥$1) движению, sub-$1 dust игнорируется. Изменения в `classifier.ts` секции 10–12
  (apps/api + зеркало apps/web): (a) `matSends`/`matReceives` dust-фильтр; (b) delegation fee-collect
  терпит dust-OUT (`matSends.length===0`) → `claim_rewards` (3× redeemDelegations); (c) обобщён
  receipt-бранч с UNI-V*-POS на любой `isLendingReceipt` aToken (искл. variableDebt/stableDebt) →
  `lend_supply` (0x48c0 aArbWETH); execute→lp_add уже ловился. Тесты: `classifier.test.ts` +4 (api),
  `classifier.delegation.test.ts` +4 (web). Регрессия: api classifier 414/414, web 729/729, tsc clean.
  ⚠ Существующие 6 строк в `chain_operations` остаются `unknown` до ре-синка кошелька mmaksimuk
  (рефреш → переклассификация → POST). Фикс меняет БУДУЩУЮ классификацию.
- **P0 verify (workflow wf_663ffa96, 2026-06-04)**: adversarial multi-agent (4 dims + эмпирический прободатель
  + refute-верификация). Вердикты: correct/correct-with-caveats, **0 подтверждённых багов**. Прободатель 6/7;
  единственный провал — **section-9 ordering gap**: одноногая wrapper-операция (1 send + 1 deposit-receipt)
  короткозамыкалась в `swap` ДО секции 11 (1 USDC→aArbUSDC = swap вместо lend_supply; 1 send→UNI-V3-POS = swap
  вместо lp_add). 6 P0-строк все ≥2 ноги → не задеты, но это однозначная некорректность. **ЗАКРЫТО**: секция 9
  (оба classifier'а) теперь не делает swap-shortcut если единственный receive — deposit-receipt (LP-NFT либо
  `isLendingReceipt` aToken, искл. variableDebt/stableDebt). LST/vault (stETH/yv*/moo) НЕ исключены — свопаемы.
  Тесты +4 (api), +3 (web), вкл. регрессию «WETH→stETH остаётся swap». Регрессия: api classifier 418/418,
  web portfolio 521/521, tsc clean. Backlog из верификации: автоматический parity-тест (один fixture-набор
  через оба classifier'а) + isLendingReceipt-agreement guard (server protocols.ts vs @cap-flow/ucb dist).
- ~~**P0** (6 строк, ±$10k): wrapper'ы `redeemDelegations`/`execute`~~ — см. выше.
- **P1 ✅ DONE (2026-06-04, understand-workflow wf_b600e3c8)**: 9 UniV3 `collect` с ПУСТЫМ movement
  (8 eth + 1 arb, counterparty=NPM `0xc36442…88`) классифицируются как `claim_rewards`. Guard в `classifyDex`
  перед финальным unknown (оба classifier'а): `protocol && sends==0 && receives==0 && (fnName==='collect' ||
  to_addr===NPM)` → claim_rewards, notes `['v3-collect-fees','needs_backfill']`. protocol.id chain-префиксуется
  ОБОБЩЁННО (`startsWith(\`${chain}_\`) ? protocol : prefix`) — чинит eth-баг (голый 'uniswap3' не матчил LP)
  без мислейбла не-Uniswap dex (Velodrome остаётся velodrome3). **Scope = ТОЛЬКО классификация, без backfill**:
  on-chain декод обоих sample-txs дал amount0=0/amount1=0 (zero-fee collect, нечего backfill'ить).
  **Double-count = SAFE** (верифицировано по file:line): пустой movement → $0; `classifyJunk` ставит
  junk:empty_movement → `isJunkOp` скипает в computeClaimedFeesUsd/buildClaimedFeesHistory ДО чтения movement;
  Krystal override (override.ts:294-296) полностью заменяет feesClaimedUsd. Тест на инертность подтверждает.
  Критично: NPM из `it.tx.to_addr` (op.counterparty undefined внутри classifyDex). Тесты +6 (api),
  +5 (web `classifier.v3collect.test.ts`). Регрессия: api classifier 423/423, web portfolio 526/526, tsc clean.
  ⚠ 9 строк остаются unknown до ре-синка кошелька. ⚠ Re-audit при будущем backfill movement: realized_pnl.ts
  handleReward/computeRewardIncomeByFamily НЕ зовут isJunkOp — безопасны только из-за пустого movement сейчас.
- ~~**P1** (9): UniV3 `collect`~~ — см. выше.
- **P2 ✅ DONE (2026-06-04, understand-workflow wf_9c86160b + owner-decision)**: 54 value-less unknown'а
  выведены из unknown через НОВЫЙ терминальный `op_type='noise'` (owner выбрал «честный» вариант vs reuse-типов
  vs не-трогать). On-chain декод подтвердил: ВСЕ 54 value-safe (net-zero на EOA, уже несут junk:empty_movement).
  Маппинг: approve-семья (approve/approveForAll/setApprovalForAll/increaseAllowance) → `approve`; всё прочее
  value-less (points bulkAddFxtlPoints×21, spam/zero-value transfer×25, Gearbox multicall×2 [value в credit-account,
  не EOA], setTraderReferralCodeByUser, EIP-7702 пустой-fnName) → `noise`. Механизм: ОБОБЩЁННЫЙ empty-movement
  fallback ПЕРЕД финальным unknown в ОБОИХ tail'ах (doClassify:13 + classifyDex, после P1-collect-ветки):
  `sends==0 && receives==0` → APPROVE_FNS?approve:noise. Финальный `unknown` теперь достижим ТОЛЬКО для
  value-bearing (непустой movement) — это и есть value-bar. `noise` сохраняет junk:empty_movement → isJunkOp=true
  → инертно (нет exhaustive-switch/assertNever; op_type=text без CHECK-констрейнта → миграция не нужна).
  Изменения: OpType union +noise в ucb/src/types.ts + apps/api types.ts (3-я копия = web re-export, ucb rebuilt);
  OP_TYPE_LABEL +noise (PortfolioView.tsx, exhaustive Record). Тесты +13 (api), +10 (web classifier.p2noise.test.ts),
  обновлены 3 unknown→noise ассерта. Регрессия: api 1083/1083, web 747/747, tsc 0 ошибок обоих.
  ⚠ Deviation от owner-формулировки: referral отнёс к `noise` (не approve) — это не allowance, честнее. ⚠ 54 строки
  остаются unknown в БД до ре-синка кошельков.
- ~~**P2** (54): hard-allowlist value-less селекторов~~ — см. выше.

**ИТОГ unknown→0**: P0 (6 wrapper) + P1 (9 collect) + P2 (54 noise) = все 69 unknown типизированы. Финальный
`unknown` достижим только для value-bearing непустого movement (CI-bar). ⚠ Все 69 строк в БД ждут ре-синка.

**Материализация (admin-кнопка «Переклассифицировать»)**: обычный refresh инкрементальный — `LoadedWalletsProvider.load()`
ставит `stopWhen` по `knownHashes`/`serverLatestOpTime` и не доходит до старых строк. `load(wallet,{full:true})`
(и `loadAll({full:true})`) ОБНУЛЯЕТ cached/knownHashes/serverLatestOpTime → полная подкачка истории из DeBank →
переклассификация новым кодом → POST `/chain-ops/:walletId/sync` (`onConflictDoUpdate` → `EXCLUDED.op_type`,
идемпотентный upsert-перезатир, без дублей/удалений). Capability уже была в контексте; добавлена ТОЛЬКО
admin-only кнопка «Переклассифицировать» в тулбаре OpenPositionsPage рядом с «Обновить» (gate
`isAdmin || isImpersonating` — как golden, т.к. 69 строк на кошельках юзеров, правятся через impersonation),
variant=outline + window.confirm (тяжёлая операция, жжёт DeBank-кредиты), вызывает `loadAll({full:true})`.
Серверного нового эндпоинта НЕ нужно (sync уже user-scoped). Проверка результата: DB-запрос
`COUNT(*) WHERE op_type='unknown' AND jsonb_array_length(raw->'movement')>0` должен стать 0.

**Bulk + выборочный ре-синк (admin «Все позиции»)**: серверная классификация ИДЁТ И НА СЕРВЕРЕ —
`PortfolioRefreshService.refreshAccount` → `ChainClassifierService.analyzeAccount` (full `getHistory` из DeBank)
→ серверный `classifyHistory` (те же P0/P1/P2-фиксы) → `chainOpsRepo.upsertBatch` (перезатир op_type). Через
очередь `PortfolioRefreshQueue.enqueueManual(accountId, actorUserId, "admin")`. Эндпоинты УЖЕ существовали:
`POST /admin/portfolios/refresh-all` (все аккаунты) и `POST /admin/portfolios/:id/refresh` (один), behind
`requireAdmin`; клиент-api `adminPortfoliosApi.refreshAll/refreshOne` + хуки `useAdminPortfoliosRefreshAll/
useAdminPortfolioRefreshOne` тоже были. Добавлена ТОЛЬКО кнопка «Переклассифицировать выбранного/всех» в
тулбаре `AllPositionsPage` — читает фильтр `account` (выбран → refreshOne, «все аккаунты» → refreshAll),
confirm + alert о постановке в очередь. ⚠ analyzeAccount за feature-flag (`FLAG_KEY`) — ре-синк сработает
только для flag-enabled аккаунтов. Два пути сосуществуют: per-user client-кнопка на OpenPositions (быстрый,
для impersonated), bulk/selected server-кнопка на AllPositions (без impersonation, async-очередь).
→ unknown: 6 типизируются, 9 типизируются+backfill, 54 → noise. **unknown→0.**

## Self-extending feedback loop
1. Периодический скан: `unknown` ИЛИ `classifiedBy='movement'` с непустым movement → группировать по **неопознанному topic0** (из `raw.logs`).
2. Авто-подсказка: `getContractAbi(контракт)` → событие, где `keccak256(sig)==topic0` → имя → keyword-эвристика op_type (Mint/Deposit/Supply→supply/lp_add; Burn/Withdraw/Redeem→remove/withdraw; Borrow; Repay; Swap/Exchange→swap; Collect/RewardPaid/Claim→claim; Approval/Points→noise). Флаг `needs_data_decode` для single-EventEmitter/signed-delta.
3. Human confirm (golden-протокол — не авто-доверять): очередь `{topic0,контракт,событие,suggestedOpType,sampleTx,count,usdImpact}`.
4. Commit: запись в `topic0_dict.ts` (`status:confirmed`) + **golden/regression-тест** на sample-tx (как `classifier.test.ts`). Тест = защита от регрессии.

## Риски + проверка
- **Регрессия корректных** → collision-resolver + DeBank-лестница как ступень 3 + **shadow-diff** (новый vs старый op_type по всем строкам; флипать после ревью — паттерн shadow-diff-M5).
- **Стоимость receipt-fetch** → за external-API switch (#136-139), кэш по tx_hash, degrade на ступень 3.
- **DATA-decode семейства** (GMX/Fluid/V4/Curve) — баг decode → неверный знак cost basis; unit-тест каждого декодера.
- **web/server drift** → shared-пакет.
- **log_index=0** → мульти-op wrapper хранит ОДИН op_type; возможно нужен реальный log_index чтобы делить.
- **Проверка:** test-first (failing-тесты на 6 P0 + 9 collect → target op_type); регресс-сьют (classifier/protocols/token_roles/junk_filter) зелёный; **33 эталона — cost basis не хуже** (LP сверять с Krystal Σ DEPOSIT); shadow-diff-гейт (ожидаемо +6/+9/+54, 0 неожиданных флипов); CI-ассерт `unknown с непустым movement == 0`.

Связанные: `topic0-op-dictionary.md` (словарь), `taxonomy-standards.md`, `position-audit-protocol.md`.
