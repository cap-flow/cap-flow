---
date: 2026-05-24
stage: Post-Phase H (Task #48)
---

# Debug protocol — как расследовать bug-репорт пользователя

**Жёсткий протокол для Claude (и людей) перед любой работой по `cost basis / startUsd / PnL / доходность / fee APR / IL`.** Создан после рецидива POS-005 bug (cost basis $21,613 вместо $30,000) когда был принят пользовательский «3к» как ground truth без проверки реальных ops.

## Зачем

Класс багов «cost basis / startUsd / PnL неправильный» **рецидивирует** потому что систематически нарушается базовое правило:

> Принять заявленное пользователем значение как ground truth → побежать писать defensive clamp / fix → создать новый параллельный код path → регрессия в другом месте.

Это паттерн #1 из [anti-recurrence-methodology.md](./anti-recurrence-methodology.md) в новой форме: silent fallback не в коде, а в процессе расследования.

## Жёсткий протокол

### Шаг 0 — Reload контекста

1. ☐ Прочитать [ucb-universal-cost-basis.md](./ucb-universal-cost-basis.md)
2. ☐ Прочитать [anti-recurrence-methodology.md](./anti-recurrence-methodology.md)
3. ☐ Если bug касается V3 LP — [v3-etherscan-cost-basis.md](./v3-etherscan-cost-basis.md)
4. ☐ Если bug касается lending self-loop — обзор C10/C11/C12 fix history

Notes могут быть stale. Проверять против актуального кода через `grep` если есть подозрение что что-то изменилось.

### Шаг 1 — Ground truth БЕЗ догадок

Заявленные пользователем числа — **гипотезы**, не truth. Юзер может:
- Ошибаться в подсчёте (smell test, не аудит)
- Помнить старую цифру (до partial withdraw)
- Путать позиции (POS-005 vs POS-007)
- Иметь wrong mental model («должно быть 3к» = сумма последнего deposit, но WAC аккумулирует ВСЕ acquisitions cross-protocol)

**Источники ground truth (приоритет):**

| Источник | Когда | Команда |
|----------|-------|---------|
| **a) On-chain RPC truth** | V3 NFT amounts, aToken balance, oracle prices — всё что лежит в smart contracts. **Most authoritative для current state.** | useV3Positions hook / Etherscan IncreaseLiquidity / Revert Finance (для V3) |
| **b) DB query** | Cost basis aggregations, swap/transfer ops history | postgres MCP (требует разрешения юзера) |
| **c) Live React state** | `OpenPosition.supplyTokens` + `lots` через dev tools | `chrome-devtools` evaluate_script |
| **d) Purchase History popup** | UI в Position Detail page (per-lot breakdown) | navigate + screenshot |
| **e) Integration test** | Если есть test с этим scenario | `grep "POS-005\|artur" apps/web/src` |

**ВАЖНО:** DeBank / CoinStats / Vybe могут lying! Если показанные API данные противоречат on-chain (Revert / Etherscan) — on-chain wins. См. паттерн #4 в [anti-recurrence-methodology.md](./anti-recurrence-methodology.md).

ОБЯЗАТЕЛЬНО собрать:
- ☐ Все swap-ops для целевого asset cross-protocol
- ☐ Все transfer_in (cross-wallet или CEX deposit)
- ☐ Все partial withdrawals (lend_withdraw / lp_remove с этим asset)
- ☐ Self-loop borrow (если lending) — отдельно
- ☐ Aliased pairs (BTC↔WBTC↔cbBTC) через wrapped pool aliasing

### Шаг 2 — Гипотеза только после verification

Сформулировать: «expected $X на основе ops [hash1, hash2, hash3]». Сравнить с UI ($21,613.51 в случае POS-005).

| Diff | Действие |
|------|----------|
| Identical | Юзер ошибся. Ответить с breakdown, не править код. |
| < 1% | FP rounding — игнорировать или snap через D11 normalization. |
| > 1% но < 5% | Hist-price drift / fee accounting. Не клампать silent. |
| > 5% | **Реальный bug.** Идти в Шаг 3. |

### Шаг 3 — Root cause через code path tracing

НЕ писать fix пока не показал:
- ☐ Какая функция установила wrong startUsd (`open_positions.ts:LINE`)
- ☐ Какие inputs её привели к wrong output
- ☐ Какой UCB-инвариант нарушен (silent fallback / mutable state / parallel pipeline / другое)
- ☐ Где надо поправить (источник — НЕ display layer)

### Шаг 4 — Test-first fix

- ☐ Воспроизвести scenario в `*.test.ts` (failing test)
- ☐ Только после red test — править код
- ☐ Зелёный test = fix work
- ☐ Полный `vitest run` — нет regression в других scenarios

### Шаг 5 — Verification после deploy

- ☐ Live page проверить что число изменилось как ожидалось
- ☐ Console warnings проверить (anti-recurrence #5)
- ☐ Provenance в UI показывает source провenances корректно

## Анти-паттерны (запрещены)

❌ **«Defensive clamp» на догадке без root cause**
- `Math.max(0, currentUsd)` без знания почему было negative
- `Math.max(0, startUsd - fees)` без проверки double-count

❌ **«Принять заявленное» без verification**
- «Пользователь сказал должно быть 3к → значит startUsd 21.6к это bug»
- Может оба числа неверные

❌ **«Параллельный path» для специального случая**
- Добавление новой ветки в walker «для V3 LP» без миграции старого
- Создаёт паттерн #3 (parallel pipelines)

❌ **«Memory/notes как ground truth»**
- Stale notes citing without code verification — ошибка

❌ **«Fast forward to fix»**
- Сразу писать commit / PR без verification → loop регрессий

## Чек-лист перед commit fix'а cost basis

1. ☐ Шаги 0-5 выше пройдены полностью?
2. ☐ Ground truth получен из источника a/b/c/d (не догадка)?
3. ☐ Root cause локализован на конкретную строку?
4. ☐ Failing test добавлен ДО fix?
5. ☐ Все 3 памятки (UCB / anti-recurrence / cost-basis-methodology) свериться с фиксом?
6. ☐ Один pipeline затронут (не оба build.ts/cross_protocol.ts если уже унифицирован)?
7. ☐ Никаких новых silent fallback?

## Связанные

- [ucb-universal-cost-basis.md](./ucb-universal-cost-basis.md) — ядро (что считать)
- [anti-recurrence-methodology.md](./anti-recurrence-methodology.md) — корни регрессий + 7 actions
- [cost-basis-architecture.md](./cost-basis-architecture.md) — архитектура
- [v3-etherscan-cost-basis.md](./v3-etherscan-cost-basis.md) — V3 LP override алгоритм
