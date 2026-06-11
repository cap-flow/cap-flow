# UCB cutover plan — переход с браузерного расчёта на серверный движок

> Решение владельца (2026-06-08). Как перевести существующих юзеров с client-compute
> (расчёт позиций в браузере) на серверный движок `@cap-flow/ucb` **без поломки текущей
> логики**: параллельный расчёт «в тени» → сверка «всё совпало» → переключение по одному
> аккаунту → удаление браузерного кода. Это ОТДЕЛЬНАЯ фаза ПОСЛЕ мёржа ветки в main
> (сам мёрж инертен — все рискованные флаги OFF).

## Принцип безопасности
Пока `ucbServerCanonical` OFF для аккаунта — сервер считает позиции параллельно и **НЕ
отдаёт в UI**; юзер видит браузерный расчёт. Переключаем по одному аккаунту и ТОЛЬКО когда
его server↔client diff = 0 на выдержке. Откат — мгновенный (флаг обратно). Сломать текущую
браузерную логику невозможно, пока флаг не флипнут.

## Механизм (уже в коде — не изобретать)
| Слой | Файл/флаг | Статус |
|---|---|---|
| Shadow-расчёт (параллельно, не отдаётся) | `ucb-shadow.service.ts`, флаг `capflow.feature.ucbServerShadow` (global **ON**) | ✅ |
| Per-position сверка server↔client | `ucb/shadow-diff.ts::diffShadowPositions` (`deltaStartUsd`, `materialDivergenceCount`) | ✅ |
| Приём клиентских позиций для сверки | `POST /accounts/:id/ucb/shadow-diff` (пишет `ucb_shadow_results.diff_summary`) | ✅ route есть |
| Детект расхождений | `client_server_cost_basis_divergence` + `tracker_divergence` (post_port_checks) | ✅ |
| Переключение UI на сервер | `features/ucb/serve-decision.ts::shouldAdoptServerPositions` + флаг `ucbServerCanonical` (per-account) | ✅, OFF |
| Тонкий клиент берёт позиции с сервера | `features/ucb/api.ts::ucbApi.servePositions` (`GET /accounts/:id/ucb/positions`) | ✅ |

## ⚠ Известный пробел (доделать ПЕРЕД массовой сверкой)
Клиент сейчас **не вызывает** `POST .../ucb/shadow-diff` автоматически → из 247 shadow-строк
**0 имеют `diff_summary`** (проверено 2026-06-08). Механизм сверки есть, данных нет. Задача:
после клиентского расчёта в `use_computed_positions` (за флагом, напр. когда `ucbServerShadow`
известен для аккаунта) слать свои позиции на `ucbApi` shadow-diff → `diff_summary` заполняется
→ детектор гонит сверку по всем. Без этого переход «вслепую».

## Этапы cutover (строго по порядку; не идти дальше при ненулевом diff)
1. **Shadow для всех.** `ucbServerShadow` ON (уже), воркер запущен, все аккаунты рефрешнуты
   → shadow посчитан для каждого свежим (исправленным) движком.
2. **Включить клиентский shadow-diff POST** (пробел выше) → `diff_summary` по всем юзерам.
3. **Свести diff к нулю.** Разобрать КАЖДОЕ material-расхождение (класс aida/artur:
   token→token cost loss, receipt-spot, async-linker, V3-match). Чинить в движке
   (`@cap-flow/ucb`), test-first, не маскировать. Цель: **0 material divergence по ВСЕМ
   юзерам на N рефрешей подряд**.
4. **Флип `ucbServerCanonical` по одному аккаунту** — у кого diff=0 и выдержка прошла. UI
   переходит на серверные позиции. Что-то не так → флаг обратно (мгновенный откат).
5. **Выдержка.** Все аккаунты на сервере, diff=0, 0 багов/ошибок ≥ согласованный срок.
6. **Удаление браузерной обработки.** ТОЛЬКО теперь. Убрать client-compute оркестрацию:
   `LoadedWalletsProvider` (fetch+linkAsyncDeposits+compute), `use_computed_positions`,
   клиентские вызовы overrides/трекеров. Клиент становится тонким потребителем
   `ucbApi.servePositions`. **⚠ Движок `@cap-flow/ucb` НЕ удалять** — сервер на нём считает;
   удаляется только in-browser оркестрация. Параллельные трекеры исчезают → анти-паттерн #3
   ([[capflow_anti_recurrence_methodology]]) закрыт навсегда.

## Инвариант перехода
На каждом шаге: **server == client по всем позициям всех юзеров** (`materialDivergenceCount`=0).
Любое расхождение = баг движка (чинить, не маскировать — [[capflow_debug_protocol]]). Право
флипнуть аккаунт = нулевой diff на выдержке. Браузерный код удаляется ПОСЛЕДНИМ, когда на нём
уже никто не считает.

## Инвентаризация кода под снос (измеримый эффект оптимизации)
Замеры на 2026-06-08 (worktree condescending-fermi). Это код, который после cutover (этап 6)
СТАНОВИТСЯ НЕНУЖНЫМ — браузер перестаёт считать, берёт готовое с сервера. ⚠ Движок
`@cap-flow/ucb` НЕ трогаем (сервер на нём считает) — удаляется только in-browser оркестрация.

**Контекст:** `apps/web/src/lib/portfolio/` = **9 206 строк** в 70 файлах, из них **28 уже тонкие
ре-экспорты** `@cap-flow/ucb` (исчезают «бесплатно», как только на них никто не ссылается).

| Файл (клиентская оркестрация расчёта) | строк | судьба после cutover |
|---|---|---|
| `components/data/LoadedWalletsProvider.tsx` | 1844 | → ~200 (fetch wallets + позиции с сервера); −~1600 (fetch/classify/link/compute) |
| `lib/dashboard/metrics.ts` (аналитика) | 958 | → web-шим; логика в `@cap-flow/analytics` (см. analytics-engine-plan) |
| `lib/portfolio/classifier.ts` (зеркало api) | 805 | удалить (классифицирует сервер) |
| `lib/portfolio/live_adapters.ts` (DeBank/Helius в браузере) | 765 | удалить (фетчит сервер) |
| `lib/portfolio/use_computed_positions.ts` (пайплайн + override'ы) | 678 | удалить (позиции с сервера) |
| `lib/portfolio/reducer.ts` (сборка позиций) | 544 | удалить |
| 28 тонких ре-экспорт-шимов | ~небольшие | удалить, как станут unreferenced |

**Грубый итог под снос:** ~**4,6–5,6 тыс. строк** клиентской оркестрации + 28 файлов-шимов →
браузер становится тонким клиентом. Один движок вместо 3–4 копий; баг чинится в одном месте;
страница грузится из готовых серверных данных вместо 2-минутного пересчёта (замер testakk:
2000+ ops, ~250 price-запросов, >2 мин).

⚠ Цифры — верхняя оценка; уточнять на этапе 6 (часть `LoadedWalletsProvider` остаётся как тонкий
fetch). Параллельный `portfolio_snapshots.metrics` схлопывается в движок аналитики (отдельный план).
Сопутствующее уменьшение: `position_lot_cost_basis` ↔ `cross_protocol` слить ПОСЛЕ cutover (станет
безопасно — параллельные трекеры исчезнут).

## Флаги (карта)
- `capflow.feature.ucbServerShadow` — global ON (shadow, инертно, не отдаётся).
- `capflow.feature.ucbServerCanonical` — per-account, OFF; флипается на этапе 4.
- `chain_classifier.topic0.enabled` — OFF (отдельный rollout классификатора, не связан с cutover).

## Связанное
`notes/decisions/MERGE-READINESS.md` · `notes/decisions/ucb-server-port-master-plan.md` ·
[[capflow_ucb_b5_state]] · [[capflow_anti_recurrence_methodology]] · [[capflow_debug_protocol]]
