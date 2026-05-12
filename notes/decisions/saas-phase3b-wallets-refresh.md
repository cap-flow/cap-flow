---
date: 2026-05-11
stage: SaaS Phase 3b
---

# SaaS Phase 3b — wallets CRUD + real refresh pipeline (DeBank)

## Контекст

Phase 0-8 закрыли весь SaaS-каркас. Этапы 1-3a после Phase 8 добавили
sidebar links и реальные blockchain клиенты (Tronscan/Etherscan для
billing, Alchemy/DeBank skeletons для balances). Но
`PortfolioRefreshService.refreshAccount` всё ещё писала stub
(`metrics: {stub: true, totalUsd: 0}`) — потому что не было wallets/
addresses в БД через TS-схему, и refresh-service не вызывал реальные
upstream-провайдеры.

Phase 3b закрывает эту дыру: persistent wallet model + real DeBank
integration в worker pipeline.

## Решение

### Schema → TS surface, миграция не нужна

Таблицы `wallets` + `wallet_addresses` уже существуют в БД (legacy
pre-SaaS, см. Phase 0 introspect `notes/decisions/saas-phase0-auth.md`).
Phase 3b добавляет только **TS-описание** в `packages/db/src/schema/`:

```
wallets (
  id, account_id → accounts(id) CASCADE,
  name, kind enum('internal'|'external'),
  unique (account_id, name),
  created_at, updated_at
)

wallet_addresses (
  id, wallet_id → wallets(id) CASCADE,
  address, type enum('evm'|'solana'|'tron'|'btc'|'other'),
  chains integer[],
  unique (wallet_id, address),
  created_at
)
```

Никаких SQL-миграций — таблицы уже есть в проде.

### CRUD endpoints с tenant isolation

`apps/api/src/modules/wallets/`:
- `wallets.repository.ts` — listByAccount, findById, create, rename,
  delete; listAddresses, addAddress, deleteAddress, findAddressWithAccount
  (join для tenant-guard).
- `wallets.service.ts` — каждая мутация проходит через
  `accounts.getById(accountId, actor)` (Phase 2 Forbidden/NotFound).
  Конфликты `unique (account_id, name)` / `unique (wallet_id, address)`
  ловятся через PG error message → `ConflictError`.
- `wallets.routes.ts` — REST дерево под `/api/v1/accounts/:id/wallets[/:wid][/addresses[/:aid]]`.

Audit-log events: `wallet.created`, `wallet.renamed`, `wallet.deleted`,
`wallet.address_added`, `wallet.address_deleted`.

### Real refresh pipeline (DeBank only, stage-2)

`PortfolioRefreshService.refreshAccount` теперь:

1. Подтягивает все `wallet_addresses` для аккаунта через
   `WalletsRepository.listAddressesByAccount` (НЕ через WalletsService —
   worker — trusted service path, без AuthUser).
2. Фильтрует `type === "evm"` (остальные — solana/tron/btc/other —
   записывает в `metrics.addressesSkipped` для tech-audit).
3. Для каждой EVM-адреса вызывает `DeBankClient.getTotalBalance(address)`
   (один call покрывает все chains в DeBank).
4. Каждый upstream call логируется в `api_usage` (provider, endpoint,
   httpStatus, durationMs, error).
5. Складывает `totalUsd` всех адресов, пишет snapshot c
   `metrics: {totalUsd, refreshedFrom, perAddress, errors, ...}`.

Cost basis / per-position math **намеренно** не делается — это требует
ledger (`operations`) + historical prices, которые требуют отдельной
фазы (порт `apps/web/src/lib/portfolio/cost_basis_tracker.ts` на сервер).
Phase 3b обеспечивает **TVL-уровень** аналитики — этого достаточно для
admin dashboard, who needs to see TVL × users в первую очередь.

### Wire-up

- `apps/api/src/app.ts` — instantiate `WalletsRepository` + `WalletsService`,
  register `walletsRoutes`.
- `apps/api/src/worker.ts` — bootstrap real `DeBankClient(env.DEBANK_API_KEY)`,
  передать в `PortfolioRefreshService` вместе с `WalletsRepository` +
  `ApiUsageRepository`.
- `apps/api/src/modules/portfolio/portfolio-refresh.service.ts` —
  переписан полностью: stub → real DeBank-driven calc.

### Ключи

API-ключи перенесены из `apps/web/.env.local` в `apps/api/.env`
(Alchemy/DeBank/Etherscan). Frontend всё ещё может читать `VITE_*`
для legacy путей; новый refresh идёт через server.

## Альтернативы

- **Wallets endpoints под `/me/wallets` вместо `/accounts/:id/wallets`** —
  отвергли: account это первичный namespace в multi-tenant модели,
  и в Phase 5 admin может listAccounts other-users, так что
  account-prefixed natural.
- **`WalletsService.listAddressesForRefresh` (auth-skipped) внутри
  Service** vs. использовать Repository напрямую из worker — выбрал
  второе. Worker — trusted path, AuthUser там вообще нет; ходить через
  service-layer (который требует AuthUser в других методах) внесло бы
  fake-actor pattern.
- **Cross-check DeBank vs Alchemy** в каждом refresh — отложили в
  stage-3. Полезно для tech-audit, но добавляет 2× upstream calls на
  каждый refresh; на бета-нагрузке преждевременно.
- **Persisted token-level breakdown** в snapshot — отложили.
  `metrics.perAddress` уже содержит chain-level breakdown от DeBank;
  per-token нужен только когда пишем cost basis.
- **Schema migration для `wallets`** — не нужна. Таблицы есть в проде,
  только TS-описание добавили.

## Реализация

Изменения:
- `packages/db/src/schema/wallets.ts` (new, ~70 lines)
- `packages/db/src/schema/index.ts` (export)
- `apps/api/src/modules/wallets/wallets.repository.ts` (new)
- `apps/api/src/modules/wallets/wallets.service.ts` (new)
- `apps/api/src/modules/wallets/wallets.routes.ts` (new)
- `apps/api/src/modules/portfolio/portfolio-refresh.service.ts`
  (rewritten — stub → DeBank-driven)
- `apps/api/src/worker.ts` (wire WalletsRepository + DeBankClient +
  ApiUsageRepository in)
- `apps/api/src/app.ts` (register wallets routes + instantiate services)

## E2E (real DeBank live call, all green)

| # | Что | Результат |
|---|---|---|
| 1 | POST `/api/v1/accounts/:id/wallets` (admin, "EVM test") | 201 + walletId |
| 2 | POST `/wallets/:wid/addresses` (Vitalik's address, type=evm, chains=[1,42161,8453]) | 201 + normalized lowercase address |
| 3 | POST `/accounts/:id/refresh` | 202 + jobId |
| 4 | wait + worker log `[worker] refresh completed` | ✓ |
| 5 | GET `/accounts/:id/refresh-status` | `totalUsd: 1276679.17`, `refreshedFrom: ["debank"]`, `addressesEvm: 1` |
| 6 | GET `/admin/portfolios/aggregate` | platform `totalUsd: 1276679.17` |
| 7 | GET `/admin/portfolios` | vladimir/Main row shows lastSnapshotUsd=1276679 |
| 8 | api_usage debank row | 200 OK, 2121ms duration |
| 9 | Alice GET admin's `/wallets` | **403** (tenant isolation) |
| 10 | Alice GET her own `/wallets` | 200 `[]` |
| 11 | audit_log | wallet.created + wallet.address_added |

## Ограничения

- **Только DeBank, только EVM**. Non-EVM (Solana/Tron/BTC) адреса
  принимаются в БД, но не resolve-ятся в TVL — `metrics.addressesSkipped`
  считает их для admin tech-audit.
- **Нет client-side balance cross-check** (Alchemy). DeBank — single
  source of truth. Когда добавим, можно прокинуть `AlchemyClient`
  в `PortfolioRefreshService` constructor и сделать diff в `metrics`.
- **Cost basis / PnL = 0**. Snapshots содержат только current TVL.
  Полный pipeline требует:
  - port `apps/web/src/lib/portfolio/cost_basis_tracker.ts` на server,
  - persistent `operations` ledger через server endpoints,
  - historical prices через CoinGecko/DefiLlama (Phase 3 уже готов).
- **Нет frontend page `/wallets`**. Endpoints доступны через API;
  UI добавится как следующая итерация polish.
- **`AlchemyClient`** конструируется в `app.ts`, но не используется
  пока — placeholder для stage-3. (`void` на конструкторе чтобы
  TS-imports остались валидными.)
- **Worker tsx-watch reload**: после правок `portfolio-refresh.service.ts`
  manual job отрабатывает уже на старом worker процессе пока tsx watch
  не перезапустит. Обходной путь — перезапустить worker вручную.
  На prod (с `node dist/worker.js`) этой проблемы нет.
