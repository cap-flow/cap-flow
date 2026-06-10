# Отдельный движок аналитики `@cap-flow/analytics` — план

> Решение owner (2026-06-08). Аналитику (капитал/PnL/ROI/APR/аллокация/активы/налоги) сейчас
> считает БРАУЗЕР каждого юзера, в нескольких разделах разными функциями. Нужен ОДИН отдельный
> серверный движок аналитики — НЕ внутри UCB, потребляет позиции+операции как ВХОД, выдаёт ВСЮ
> аналитику для ВСЕХ разделов. Цель: не зависеть от браузера, убрать параллельные расчёты,
> корректные цифры везде.

## ⭐ ГЛАВНАЯ МЕТОДОЛОГИЯ: ПЕРЕНОС, НЕ ПЕРЕПИСЫВАНИЕ (lift-and-shift)
Движок строим НЕ с нуля. Сначала **разбираемся, как браузер считает каждую метрику СЕЙЧАС**, и
**переносим ТУ ЖЕ логику дословно** в пакет. Так:
- Паритет «бесплатный» by construction — это буквально тот же код, а не новый, который потом
  мучительно сводить.
- Браузер становится тонким **ре-экспортом** из пакета (shim, нулевое изменение поведения) —
  точно как уже сделано в `@cap-flow/ucb` (напр. `apps/web/src/lib/portfolio/lending_cost_basis_override.ts`
  = `export * from "@cap-flow/ucb/..."`).
- После выноса сервер гоняет ТЕ ЖЕ функции на канонических позициях → результат совпадает с
  браузером автоматически. Единственное, что может разойтись — это ВХОДЫ (серверные позиции vs
  клиентские, расположение fiat-пометок), а НЕ логика.
**Правило: ни одной метрики не переписывать «по-новому». Сначала найти текущую формулу в коде,
перенести 1:1, тестами зафиксировать, потом (если надо) улучшать ОТДЕЛЬНО.**

## АРХИТЕКТУРА (owner)
- Пакет `@cap-flow/analytics` — ОТДЕЛЬНЫЙ от `@cap-flow/ucb`. UCB = позиции + per-position cost
  basis/PnL (уже на сервере через shadow). Analytics = АГРЕГАЦИИ поверх позиций+ops. Связь только
  по данным (вход = позиции+ops+опции), без кодовой связки в UCB-расчёт. Type-only импорт
  `OpenPosition` из ucb допустим. Чистые функции, без клиентских зависимостей.

## ПОЛНАЯ КАРТА АНАЛИТИКИ ПО СЕРВИСУ (покрыть ВСЁ — ничего не пропустить)
| Раздел (страница) | Аналитика | Текущая считалка (клиент) |
|---|---|---|
| **Дашборд** `HomePage` | капитал/own-capital/долг, total PnL, аллокация (donut), per-protocol, кредитный капитал | `computeDashboardMetrics`, `computeProtocolBorrowAggregates`, `computePositionLendingMetrics` (`lib/dashboard/metrics.ts`) |
| **Лист открытых позиций** `/performance` `OpenPositionsPage` | per-position startUsd/currentUsd/PnL%/fee APR/leverage/HF/ROI + агрегаты таблицы | `useComputedPositions`→`buildOpenPositions` + table-агрегаты |
| **Аналитика** `/insights` (OpenPositionsPage) | аналитический срез | **`computeAnalytics`** (`lib/dashboard/metrics.ts`) |
| **Деталь позиции** `PositionDetailPage` | cost basis, PnL, разбивка fee, lot-trace | `useComputedPositions` + `getPositionLotCostBasis` |
| **Кошелёк** `WalletDetailPage` | дашборд-метрики по кошельку | `computeDashboardMetrics` |
| **Портфель** `PortfolioPage` | позиции/сводка | `buildOpenPositions` |
| **Активы** `AssetsPage` | per-asset cost basis, unrealized PnL$/%, realized | `lib/portfolio/asset_rollup.ts` |
| **Закрытые** `ClosedPositionsPage` | realized PnL по закрытым (by family) | realized PnL (`realizedByFamily`/`realizedUsd`/`totalPnl`) |
| **Налоги** `TaxPage` | realized PnL / налоговые лоты / capital gains | realized PnL (`realizedPnlUsd`) |
| **Лента** `TimelinePage` | события/доход во времени | event/income агрегаты |
| **Реестр** `RegistryPage` | LP close attribution | `computeLpCloseAttribution` |
| **Покрытие** `CoveragePage` | метрики покрытия данных | coverage-агрегаты |
| **Popup истории** `PurchaseHistoryPopup` | cost basis trace, покрытие | `computePositionCoverage` + lot-trace |

**Ключевые lib-источники:** `lib/dashboard/metrics.ts` (958 строк: `computeDashboardMetrics`
стр.527, `computeAnalytics`, `computeProtocolBorrowAggregates` 364, `computePositionLendingMetrics`
438; интерфейсы `DashboardMetrics` 110 / `ComputeOptions` 187 / `LendingMetrics` 66 /
`ProtocolBreakdown` 82 / `StartCapitalByCur` 28 / `BorrowInterest` 44); `lib/portfolio/asset_rollup.ts`;
realized PnL (`computeRealizedPnlByFamily`); `computeLpCloseAttribution`; `computePositionCoverage`.
Утилиты уже в `@cap-flow/ucb` (cost_basis_tracker, protocols, junk_filter, types) — переиспользовать.

**Входы:** `positions: OpenPosition[]`, `ops: ClassifiedOp[]`, `ComputeOptions` (`startUsdAll` =
ручные fiat-покупки, `fxRate` ₽/$). ⚠ Хвост: `startUsdAll`/fiatPurchase сейчас ТОЛЬКО в
localStorage браузера ([[capflow_fixed_start_capital_usd]]) → для серверного старт-капитала
перенести в БД (фиксирован в ₽ И в $, не пересчитывается по курсу).

## ПАРАЛЛЕЛЬНАЯ СЕРВЕРНАЯ СЧИТАЛКА (схлопнуть, не плодить третью)
`portfolio_snapshots.metrics` в `apps/api/.../portfolio-refresh.service.ts:572` — ОТДЕЛЬНАЯ логика,
UI её НЕ использует → анти-паттерн #3 ([[capflow_anti_recurrence_methodology]]). Новый движок
должен ЕЁ ЗАМЕНИТЬ.

## ИСТОЧНИК ПОЗИЦИЙ
Клиентский `useComputedPositions`; на сервере — канонические из UCB shadow (`ucb_shadow_results`,
флаг `ucbServerShadow` global ON). Движок аналитики берёт их как вход.

## ЭТАПЫ (по порядку; lift-and-shift + safe-pattern, верификация на каждом)
1. **Инвентаризация (как считает браузер СЕЙЧАС).** Пройти ВСЮ карту, для КАЖДОЙ метрики выписать
   текущую формулу/функцию и её вход (что чистое, что клиентское). Это карта переноса. Показать
   owner ДО правок.
2. **Перенос 1:1 в `@cap-flow/analytics`.** Вынести ВСЕ считалки ДОСЛОВНО как чистые функции
   (`computeDashboardMetrics`, `computeAnalytics`, lending/borrow, asset_rollup, realized,
   lp-attribution, coverage). Клиентские импорты (`Loaded` и т.п.) → параметрами. Перенести тесты.
3. **Web → тонкие ре-экспорты** из пакета во ВСЕХ разделах (нулевое изменение поведения). Сверь:
   цифры на КАЖДОЙ странице не изменились (это и есть проверка, что перенос дословный).
4. **Серверный сервис аналитики.** Гоняет тот же движок на канонических позициях+ops → хранит
   (`account_analytics`) → отдаёт по API (`GET /accounts/:id/analytics`, разделы как поля).
5. **Сверка паритета ПО КАЖДОМУ РАЗДЕЛУ.** server == client (per-field diff) на всех страницах.
   Т.к. логика идентична — расхождения только из-за ВХОДОВ (серверные vs клиентские позиции,
   fiat-пометки). Свести к нулю; расхождение = баг входа/движка, чинить, не маскировать.
6. **Fiat-пометки в БД** — перенести `startUsdAll`/fiatPurchase из localStorage на сервер.
7. **Схлопнуть параллельность** — заменить `portfolio_snapshots.metrics` выводом нового движка.
8. **Cutover** — UI берёт аналитику с сервера во ВСЕХ разделах; ретайр клиентских считалок последним.

## ИНВАРИАНТ
На каждом шаге и в КАЖДОМ разделе: **server-analytics == client** (паритет = 0). Логика переносится
дословно → паритет by construction; ловим только расхождения входов. Клиентские считалки удалять
ПОСЛЕДНИМИ. Ни одна страница карты не остаётся без серверного эквивалента.

## ПРАВИЛА
- **Перенос, не переписывание** (главное). Test-first, root cause до фикса.
- НЕ плодить ещё одну считалку — движок ЗАМЕНЯЕТ и клиентские, и `portfolio_snapshots.metrics`.
- После правки пакета: `pnpm --filter <pkg> build` (экспорт из dist).
- Гейты: api/web vitest, tsc baselines (api 36 / web 251), web build ✓.
- Окружение: node ≥22.19, docker capflow-postgres + cap-flow-redis-1, API `cd apps/api && pnpm dev`
  (3000), web 5173. Worktree `condescending-fermi-99f0ac`, ветка `claude/capital-summary`. Ничего
  не мёржить без «да» владельца.

## Связанное
[[capflow_anti_recurrence_methodology]] · [[capflow_fixed_start_capital_usd]] ·
[[capflow_credit_capital_pnl]] · `notes/decisions/ucb-cutover-plan.md` · `notes/decisions/MERGE-READINESS.md`
