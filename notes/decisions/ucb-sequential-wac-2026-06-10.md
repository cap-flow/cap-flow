# UCB: последовательная per-token WAC (owner-методика, locked 2026-06-10)

Owner зафиксировал методологию на живом кейсе testakk/Artur (ребаланс GMX
2026-06-09: вывод из 3 GM-рынков, стейбл-нога обратно в GM, волатильная нога →
Fluid) и подтвердил каждую цифру вручную.

## Правила (locked)

1. **Покупка receipt-токена (GM/GLV/…):** цена = уплаченный стейбл ПО НОМИНАЛУ /
   полученное количество — по КОНКРЕТНОМУ токену (tokenId), рынки одного
   протокола НЕ смешиваются.
2. **Последовательная WAC:** средневзвешенная пересчитывается после каждой
   покупки; продажа списывает по WAC, действующей НА МОМЕНТ продажи.
   «Всего вложено / всего куплено» задним числом — ЗАПРЕЩЕНО (нарушает
   сохранение денег: списано+остаток ≠ вложено; testakk 0x70d9: +$166.80).
3. **Ноги вывода:** стейбл-нога забирает свою долю ПО НОМИНАЛУ (cap = списанная
   стоимость), весь остаток — волатильной ноге (по USD-долям между волатильными).
   Излишек стейбла сверх стоимости = реализованный gain.
4. **«Доллар = доллар» ВЕЗДЕ:** стейбл-расход всегда по номиналу, никогда по
   стоимости потреблённых стейбл-лотов (cost-0 лоты от borrow/rewards давали
   фантомную «скидку»).
5. **ETH = WETH** — один канонический пул (D4); unwrap — no-op.
6. **Rewards (ревизия D6):** входят в пул ПО РЫНОЧНОЙ цене на момент клейма
   (зафиксированный доход). Было cost=0.
7. **Продажа в стейбл = реализация PnL** (стейбл по номиналу, цепочка стоимости
   обрывается).
8. **Morpho withdrawCollateral ≠ borrow:** receives-only из receipt-less
   lending: стейбл → borrow, non-stable → lend_withdraw (возврат залога).
   Движок наследует стоимость возврата из C10 selfLoopCollateral-пула.
9. **Решение (б):** для price-зависимых компонент (rewards/fiat/волатильная
   оплата) канонический источник = block-fixed кэш `op_token_prices`.
10. Lending-позиции уважают per-user тогл методологии (task #18, без изменений).

## Что чинилось (все слои, тесты test-first)

- `cross_protocol.ts`: pendingPairCost — перенос стоимости между async-парами
  (burn→legs И creator→fill), стейбл-номинал в swap/deposit, selfLoop-наследование
  для возврата залога, rewards @ market.
- `non_lp_opener_resolve.ts`: `sequentialReceiptStartUsd` вместо gross×netFraction.
- `position_lot_cost_basis.ts` (lending walker): async-withdraw пары + правило
  стейбл-face/residual.
- `cost_basis_tracker.ts`: `attributeReceiptCloses` — per-token sequential WAC для
  receipt-закрытий; legacy pro-rata остаётся ТОЛЬКО для V3-style (locked lex POS-001).
- `async_deposit_linker.ts`: sumOutgoingUsd — стейблы по номиналу.
- Классификаторы (web + api-порт, держать в синхроне!).
- `use_opener_detector.ts`: кэш v5→v6, TTL 7d→24h (startUsd меняется операциями).
- `features/feature-flags/api.ts`: api.get БЕЗ schema падал после fetch →
  ВСЕ публичные фиче-флаги были false на фронте → B6-адопция не включалась. Починено.
- `post_port_checks.ts::matchCanonical`: openHash-разрешение коллизий marketKey
  (два Fluid-вольта на одном lpTokenId).

## Эталоны (golden_cases POS-101…POS-105, active)

| Позиция | startUsd | Источник |
|---|---|---|
| GMX 0x70d9 | $5 908.92 | арифметика номиналов (owner verified) |
| GMX 0x47c0 | $3 375.45 | — // — |
| GMX 0x77b2 | $2 689.22 | — // — |
| Fluid WBTC | $31 624.68 | trace + block-fixed (±$0.13 от $31 624.55) |
| Fluid ETH | $35 560.34 | engine canonical, LIFO-тогл (WAC: $37 898.09), tol 1% |

Morpho ($21 566) — golden отложен до отдельного GLV-трейса.

Детектор: golden_case_drift 0/5 после фикса матчера; 2 tracker_divergence
resolved с нотой (внутренний PositionTracker недосчитывает receipt-less
Fluid-вольты — чек требует доработки, display корректен).

## Скрипты-инструменты (apps/api/scripts/)

- `gm-sequential-wac.mts` — эталонный трейс GM-рынков по методике.
- `asset-pool-trace.mts` — полная симуляция ETH/WBTC-пулов до Fluid.
- `engine-fluid-probe.mts` — ground-truth probe лотов движка.
- `scan-anomalies.mts` — ручной прогон детектора.
- `enqueue-refresh.mts` — постановка refresh-джоба в очередь.

## Прочее

- `apps/api/package.json`: `pnpm dev` теперь поднимает server+worker вместе
  (воркер был не запущен — серверные пересчёты не шли).
