---
date: 2026-05-23
stage: UCB C5 Phase 3 (Task #18)
---

# UCB C5 Phase 3 (kill parallel pipeline) — отложен после findings

## Контекст

Task #18 цель — устранить anti-recurrence pattern #3 (параллельные pipeline'ы
`lots/build.ts` и `positions/cross_protocol.ts` для cost basis tracking).

Прогресс по фазам:
- **Phase 1** (✓ merged PR #5) — production callers `buildOpenPositions`
  всегда передают `lotsByWallet` от canonical pipeline. Inline
  `buildLotTrackerFromOps` fallback больше не активен в production.
- **Phase 2** (✓ merged PR #6) — `dual_pipeline_equivalence.test.ts` (16
  сценариев). На первом же прогоне поймал реальный bug в `inferMarketKey`
  (stable borrow → no lot). Зафиксили.
- **Phase 2b** (✓ merged PR #7) — расширил equivalence до 16 сценариев.
- **Phase 3** (попытка → откат) — drop-in replacement `buildLotTrackerFromOps`
  как тонкого wrapper'а над `buildLotsAndPositions`.

## Findings (почему откатили)

Замена сломала **6 существующих тестов** в `build.*.test.ts`:
1. `build.full_coverage.test.ts` (3 scenarios) — Aave-стиль `lend_supply`
   без receipt token в test movement
2. `build.self_loop.test.ts` (2 scenarios) — Vladimir POS-005 full loop +
   UCB C12 `lend_withdraw` lot
3. `build.async_deposit.test.ts` (1 scenario) — fallback m.usd path

**Root cause — фундаментальная семантическая разница, не bug**:
- Legacy `build.ts:handleSupply` всегда `consume`'ит out-side lots, независимо
  от наличия receipt token. Side-effect M3 normalization влияет на последующие
  `wacAt()` queries.
- Canonical `cross_protocol.ts:emitPositionEvent` consume'ит lots ТОЛЬКО когда
  `inferMarketKey()` возвращает не-null (т.е. либо receipt-токен в движениях,
  либо receipt-less protocol). Для Aave-style без receipt в test setup →
  никакого consume → разный `wacAt`.

## Решение

**Отложить Phase 3** до более глубокого audit'а:
1. Production-ли это поведение, или artefact тестов?
2. Если production-relevant — кто прав, legacy или canonical?
3. Если legacy → нужно перенести consume-on-supply логику в `handleLotsForOp`
   в `cross_protocol.ts`, потом drop-in wrapper.
4. Если canonical → нужно обновить тесты `build.*.test.ts` под новую
   семантику (документируя что pre-Phase-3 поведение было artifact).

## Альтернативы

- **Полная миграция через расширение equivalence-теста до 30+ scenarios**:
  trade-off — много механической работы, всё равно может пропустить edge cases.
  Текущий 16-test equivalence уже поймал 1 real bug, дальше diminishing returns.
- **Forcibly заменить + обновить тесты**: рискованно, легко прорвать
  production без визибельного теста.

## Реализация

Файлы, которые остались тронутыми (PR #5, #6, #7 уже merged):
- `WalletDetailPage.tsx`, `PortfolioPage.tsx` — plumb `lotsByWallet`
- `open_positions.ts` — dev warning в legacy fallback
- `positions/cross_protocol.ts:inferMarketKey` — stable borrow fix
- `lots/dual_pipeline_equivalence.test.ts` — 16 equivalence scenarios

`lots/build.ts` остаётся параллельным pipeline, но в production пути не
активен (dev warning'ом будет сигналить если кто-то его вызовет без
sharedLotTracker).

## Ограничения

- Anti-recurrence pattern #3 НЕ полностью устранён — `build.ts` всё ещё
  существует, тесты build.*.test.ts всё ещё гоняют legacy. Если будущий
  cost basis bug потребует фикса — может потребоваться duplicate fix в
  обоих местах (но equivalence-тест поймает divergence сразу).
- Phase 3 нужно завершить после более глубокого audit'а consume semantics.

## Следующие шаги

1. Audit `cross_protocol.ts:emitPositionEvent` — почему consume только для
   receipt protocols / receipt-less, а не для всех supply ops?
2. Sample real production data: на alexander/artur — Aave supply ops
   реально приходят с aETH в movement или без?
3. Если без → решить, должна ли cross_protocol эмулировать build.ts'ный
   "consume regardless" поведение, или это (правильно) убрано.
4. По решению — либо порт consume логики, либо update tests, потом
   wrapper-замена.
