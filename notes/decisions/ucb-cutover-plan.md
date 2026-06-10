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

## Флаги (карта)
- `capflow.feature.ucbServerShadow` — global ON (shadow, инертно, не отдаётся).
- `capflow.feature.ucbServerCanonical` — per-account, OFF; флипается на этапе 4.
- `chain_classifier.topic0.enabled` — OFF (отдельный rollout классификатора, не связан с cutover).

## Связанное
`notes/decisions/MERGE-READINESS.md` · `notes/decisions/ucb-server-port-master-plan.md` ·
[[capflow_ucb_b5_state]] · [[capflow_anti_recurrence_methodology]] · [[capflow_debug_protocol]]
