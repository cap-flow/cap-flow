---
date: 2026-05-11
stage: SaaS Phase 4
---

# SaaS Phase 4 — Cost basis из operations ledger

## Контекст

Phase 3c закрыла Solana balances (без USD-цен SPL). Phase 4 переносит
**первый кусок** cost basis tracker'а на сервер: WAC по user-entered
`operations` ledger. Полный chain-classifier WAC (порт
`apps/web/src/lib/portfolio/cost_basis_tracker.ts` со всеми зависимостями
— protocols, junk_filter, token_roles, LP attribution) — отдельная фаза,
**Phase 5**, потому что требует sync chain decode pipeline на сервере.

Идея разделения: ledger даёт «правду от пользователя» (то что он сам
записал в журнал операций — buy/sell с ценой), и этого достаточно для
показа avg в UI. Полный chain-classifier даст «правду из цепи»
(автоматически прочитанные swap'ы / LP open-close), но без него UI уже
не остаётся пустым.

## Решение

### Двухслойная модель cost basis

```
[Слой 1] ledger WAC ← Phase 4 (этот док)
[Слой 2] chain-classifier WAC ← Phase 5
```

Формула одинаковая (cumulative weighted average):

```
avg = Σ paid_usd / Σ bought_amount
```

При продажах WAC **не сбрасывается** — это «история покупок за всё
время», а `runningAmount` пляшет вверх-вниз.

### Idempotent batch import через `(account_id, legacy_id)`

`POST /api/v1/accounts/:id/operations/import` принимает до 5000 строк за
вызов. Клиент (legacy app) генерит UUID на каждую запись в момент
создания — этот `legacyId` — стабильный ключ. Postgres
`INSERT ... ON CONFLICT DO UPDATE`, и через трюк `(xmax = 0)` в
`RETURNING` различаем insert vs update — возвращаем
`{inserted, updated, total}`.

```sql
INSERT INTO operations (..., legacy_id) VALUES (...)
ON CONFLICT (account_id, legacy_id) DO UPDATE SET ...
RETURNING id, (xmax = 0) AS was_insert;
```

### Cost basis в `PortfolioRefreshService` — inline, fail-soft

При каждом refresh worker читает **всю** историю операций аккаунта
(`OperationsRepository.listAllForReplay`) и прогоняет через
`computeCostBasis()`. Результат пишется в `metrics.costBasis: []`.
Ошибки чтения / расчёта проглатываются в `metrics.costBasisError` —
плохая запись не должна обрушить refresh balances.

Snapshot `metrics` теперь:
```
{
  totalUsd: <EVM>,
  addressesEvm, addressesSolana, addressesSkipped,
  refreshedFrom: [...],
  perAddress: [...],
  operationsCount: 0..N,
  costBasis: [
    {symbol, avgUsd, runningAmount, totalPaidUsd, totalBoughtAmount, lastUpdate}
  ],
  costBasisError?: "...",
  generatedAt
}
```

## Альтернативы

- **Сразу портировать `cost_basis_tracker.ts`** — слишком большой
  слайс. Требует `classifier.ts` + `solana_classifier.ts` + `protocols.ts`
  + `junk_filter.ts` + `token_roles.ts` + DefiLlama hist-prices fetch.
  Это Phase 5, разбитая на 5-7 микро-этапов.
- **Materialized `position_meta` на каждом refresh** — отложено до
  момента когда появится LP attribution (Phase 5+). Сейчас metrics —
  одна строка JSON, читать дешевле чем join.
- **Realised PnL при `sell`** — не делаем. WAC остаётся cumulative,
  частичные продажи только декрементят `runningAmount`. Realised PnL
  потребует FIFO lots (текущая логика на фронте использует кумулятив,
  и мы оставляем тот же контракт).

## Реализация

### Files (новые)
- `packages/db/src/schema/operations.ts` — TS surface для legacy таблицы
  (enums op_type / op_source / funds_kind, 29 колонок numeric/text).
- `apps/api/src/modules/operations/operations.repository.ts` —
  `listByAccount`, `listAllForReplay`, `upsertBatch`, `findById`,
  `delete`, stats.
- `apps/api/src/modules/operations/operations.service.ts` — tenant
  isolation через `accounts.getById(actor)`, audit events
  `operations.import` / `operations.deleted`.
- `apps/api/src/modules/operations/operations.routes.ts` — 4 endpoint'а
  (list, stats, import, delete) под `/api/v1/accounts/:id/operations[/...]`.
- `apps/api/src/modules/cost-basis/cost-basis.ts` — pure
  `computeCostBasis(ops)`, без I/O, типизирован под Drizzle-string
  numerics.

### Files (изменения)
- `apps/api/src/app.ts` — DI + регистрация routes.
- `apps/api/src/worker.ts` — `OperationsRepository` в DI
  `PortfolioRefreshService`.
- `apps/api/src/modules/portfolio/portfolio-refresh.service.ts` —
  inline вызов `computeCostBasis`, новые поля metrics.
- `packages/db/src/schema/index.ts` — re-export `operations`.

### Env
Без изменений — никаких новых ключей.

## E2E

| # | Что | Результат |
|---|---|---|
| 1 | POST /operations/import с 3 строками (buy 1 ETH/2000 USDC, buy 0.5/1500 USDC, sell 0.3 ETH) | `{inserted: 3, updated: 0, total: 3}` ✓ |
| 2 | POST /accounts/:id/refresh | 202 + `manual-…` jobId ✓ |
| 3 | job в `recentJobs` со `state: "completed"`, `failedReason: null` | ✓ |
| 4 | snapshot `metrics.operationsCount: 3` | ✓ |
| 5 | `metrics.costBasis[0]` = `{symbol: "ETH", avgUsd: 2333.33, totalPaidUsd: 3500, runningAmount: 1.2}` (avg = 3500/1.5, running = 1.0+0.5-0.3) | ✓ |
| 6 | `metrics.costBasisError` отсутствует | ✓ |
| 7 | `metrics.totalUsd: $1,280,948.39` — EVM balance не сломался (даже чуть выше 3b baseline $1,276,679) | ✓ |
| 8 | повторный POST /operations/import с тем же payload | `{inserted: 0, updated: 3, total: 3}` ✓ |
| 9 | stats после re-import: `count: 3` (без дублей) | ✓ |

*E2E запущен 2026-05-12 на тестовом аккаунте admin с Vitalik's address +
Mango Markets v4 Solana address.*

## Ограничения

- **Поддерживаются только `buy / sell / swap / transfer / deposit /
  withdraw / fee`**. `open / close / loan* / div / other` — игнорируются
  (Phase 5: position-level tracking).
- **Crossed swap (asset → asset)** — не синтезирует cost basis на in-side;
  только декрементит out-side. Для in-side нужна hist-price lookup, это
  hold до Phase 5 (тогда же DefiLlama fetch появится).
- **Stable detection** — статический Set 11 символов (USDT/USDC/DAI/…).
  Расширим если пользователи начнут заводить экзотику.
- **Receipt-токены (aToken, GLV, GM)** не различаются — `cost_basis_tracker.ts`
  фронта это делает через `isReceiptOfProtocol(symbol, protoId, tokenId)`,
  но эта инфа доступна только при chain decode. Ledger не знает что
  `aUSDC` — это receipt; в журнале он будет обычным символом.
- **WAC кумулятивен**: продажа 50% позиции не реализует PnL и не сбрасывает
  paid_usd. Realised PnL — отдельный слайс если потребуется.
- **Pagination в /operations** — limit ≤ 5000, default 5000. Для аккаунта
  на 50k+ операций нужен offset-based paging; не релизуем пока не появится
  такая нагрузка.
