---
date: 2026-05-24
stage: Post-Phase H (Task #48)
---

# Anti-recurrence methodology — почему cost basis баги повторяются и что делать

## Контекст

За одну сессию (2026-05-21) были исправлены 5 связанных багов на artur@gmail.com:
- **C11**: `wacAt(time)` null для consumed lots
- **C12**: `consume()` filter skip empty tokenId
- **C10**: `cross_protocol.ts` borrow ops не создавали lot
- **C10b**: `inferMarketKey` null для borrow IN-only
- **C8**: `cross_protocol.ts` игнорировал `linkedCostBasisUsd`

После этого ещё 3 раза возвращались к POS-005 ту же session-серию (Phases D/E/G/H в 2026-05-24): cost basis $21,613 vs честных $30,000. Все рецидивы — следствие 3 корневых паттернов ниже.

## 3 корневых паттерна

### Паттерн 1: «Тихие fallback'ы» вместо честных unknowns

Walker (`computePositionConsumedCostFromLots`, `handleSupply`, и т.п.) когда не нашёл cost basis из лотов — **молча fallback на `m.usd`** (market price). Получается plausible-looking число (например $17,280 для 0.226 WBTC) которое выглядит правдоподобно, но является ФЕЙКОМ.

**Симптом:** пользователь видит «cost basis $17,280», не различает фейк от истины, баг живёт месяцами.

### Паттерн 2: Mutable state vs append-only history

`lot.amount -= take` уничтожает информацию: после полного consume лот «забыт». C11 локально починил через `lot.consumes[]` журнал. Но lot по-прежнему mutable.

### Паттерн 3: Параллельные реализации того же tracker'а

Изначально:
- `build.ts:buildLotTrackerFromOps` (lots layer)
- `cross_protocol.ts:buildLotsAndPositions` (lots + positions layer)

— **два независимых pipeline'а** с пересекающейся логикой. Фиксы в build.ts не пробрасываются на cross_protocol.ts. Тесты через build.ts (где проще) проходят, но production использует cross_protocol.ts (где не работает).

C10 self-loop сначала добавили в build.ts → POS-005 баг остался → потом добавили в cross_protocol.ts. C8 — ровно та же история.

Phase H (2026-05-24) выявил **4-й pipeline на верхнем layer**: `open_positions.ts:computePositionConsumedCostFromLots` — walker который читал `tracker.wacAt(time)` для каждого supply. Расходился с popup (`getPositionLotCostBasis`) на leverage-loop сценариях.

## 7 действий чтобы остановить рецидив

1. **Удалить параллельный pipeline `build.ts`** ✅ (PR #12, Phase 3 v2, 2026-05-23) — `build.ts` теперь тонкий wrapper над `cross_protocol.ts`. −598 строк дублирующейся handler-логики. Был ещё **4-й pipeline** `computePositionConsumedCostFromLots` в `open_positions.ts` — удалён в Phase H (Task #48, 2026-05-24), заменён на `getPositionLotCostBasis` (тот же что popup использует). Display layer теперь всегда consistent с lots/popup.

2. **Property-based regression тесты** ⚠️ partial — `dual_pipeline_equivalence.test.ts` (16 scenarios) для нижнего layer + `artur_flow.integration.test.ts` cross-layer invariant: `|position.startUsd - popup.totalCostUsd| < $1` (Phase H, 2026-05-24). **TODO:** расширить cross-layer на ВСЕ позиции через synthetic fuzz (action не закрыт полностью).

3. **Loud unknown в walker.** ✅ PR #9 (Phase F) — dev `console.warn` в `computePositionConsumedCostFromLots` (теперь legacy, удалён в #48). `OpenPositionToken.fallbackUsd` поле для UI surfacing.

4. **Coverage gate в UI.** ✅ PR #10 (Phase G UI badge) — purple ⚠ рядом с ID-cell для позиций с `fallbackUsd > 0`. Combined с amber для `coverageIncomplete=true`.

5. **Live invariant warning в dev.** ✅ см. #3.

6. **Integration test точно для артуровского flow.** ✅ FULL (Phase H, 2026-05-24, Task #48) — `artur_flow.integration.test.ts` теперь имеет 4 теста:
   - `positionTracker` $30k assertion (lots layer)
   - `buildOpenPositions.supplyTokens[0].startUsd` $30k assertion (display layer)
   - cross-layer invariant `|position.startUsd - popup.totalCostUsd| < $1`
   - POS-006 GMX V2 GLV async-deposit ($16.6k linkedCostBasisUsd sum)
   
   Любая регрессия одного из C8/C10/C11/C12 или 4-го pipeline ловится в CI.

7. **Жёсткое правило:** handler НЕ может писать `m.usd` в `lot.costPerUnitUsd` для acquired lots. ✅ enforced в `cross_protocol.ts` (нет m.usd на acquire path после Phase E2/F). Withdraw/borrow используют explicit cost basis transfer.

## Чек-лист перед фиксом cost basis

Прежде чем коммитить fix в lot/position tracker:

1. ☐ Прошёл [debug-protocol.md](./debug-protocol.md) шаги 0-5?
2. ☐ Какой pipeline я меняю — lots или positions / display?
3. ☐ Применил ли я тот же fix во второй pipeline (если ещё есть)?
4. ☐ Тест проходит через production path (`buildLotsAndPositions` / `buildOpenPositions`), не через legacy?
5. ☐ Walker всё ещё silent fallback на m.usd где-нибудь?
6. ☐ Provenance UI на детальной странице явно показывает unknown%?
7. ☐ Cross-layer invariant test добавлен (popup ↔ display same number)?

## Связанные

- [debug-protocol.md](./debug-protocol.md) — обязательный protocol расследования (Шаг 0 ссылает сюда)
- [ucb-universal-cost-basis.md](./ucb-universal-cost-basis.md) — ядро UCB
- [cost-basis-architecture.md](./cost-basis-architecture.md) — архитектура
- [receipt-token-cost-basis.md](./receipt-token-cost-basis.md) — Aave/Compound aToken механика
- [ucb-c5-phase-3-deferred.md](./ucb-c5-phase-3-deferred.md) — почему `build.ts` kill отложили (Phase 3 первоначально), и как доделали через Phase 3 v2
