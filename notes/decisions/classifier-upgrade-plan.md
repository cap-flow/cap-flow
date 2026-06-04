# Апгрейд классификатора операций: `unknown`→0, любой протокол (план, 2026-06-04)

Сгенерён workflow'ом (карта кода + характеристика unknown + словарь topic0 → синтез). План, не код.

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
- **P1** (9): UniV3 `collect` → (a) topic0→claim_rewards (классификация сразу), (b) суммы из Krystal/on-chain (`needs_backfill`).
- **P2** (54): hard-allowlist value-less селекторов (points/approve/referral) → `noise`/`approve`, убрать из unknown-очереди.
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
