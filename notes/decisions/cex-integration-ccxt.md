---
date: 2026-05-14
stage: post-SaaS
---

# CEX integrations через CCXT (Bybit / OKX / Bitget / MEXC)

## Контекст

Capflow видел только on-chain активность через DeBank/Helius. Пользователи
держат значимую часть капитала на CEX (Bybit, OKX, Bitget, MEXC) — без
этих данных «общий капитал» неполный, cost basis не может корректно
учитывать вложения через биржу, а P&L отчёт пропускает половину торговли.

Запрос: подключать CEX-биржи API-ключом, тянуть балансы и торговую
историю «по аналогии с DeBank для on-chain».

## Решение

**CCXT** как unified-адаптер. Поддерживает 100+ бирж, нормализует
балансы / orders / trades в общий формат, актив поддерживается.
Альтернативы (Mesh, CoinStats SaaS) проиграли по цене и по гибкости.

**Хранение ключей** — AES-256-GCM (reuse `secret-cipher.ts` из B5) с
`enc:v1:<iv>:<tag>:<ct>` префиксом. Cipher-key выводится через SHA-256
из `INTEGRATION_SECRETS_KEY` или COOKIE_SECRET (≥32 chars).

**Read-only enforcement** — `probePermissions()` behavioral-probe через
`fetchBalance()` (большинство CCXT-бирж не возвращают permissions
напрямую). Если probe fails → отказываем БЕЗ insert'а. `trade`/`withdraw`
помечаются `unknown:true`, UI просит пользователя создать read-only ключ.

**Sync model** — balance: snapshot per call (один row per asset, общий
`snapshot_at`), trades: upsert с unique-index `(cex_account_id,
exchange_trade_id)`. Re-sync идемпотентен, новые сделки берутся через
`since = latestTradeTimestamp + 1`.

## Альтернативы

- **Mesh** — закрытый API, $0.20/connection/month. Дешевле собственного
  кода, но vendor-lock и нельзя кастомизировать парсинг.
- **CoinStats SaaS** — портфельный агрегатор, уже частично интегрирован
  для read-only watch (не торговая история). Хорош как complement, но
  не заменит trade history.
- **Прямые интеграции (без CCXT)** — отдельный код на каждую биржу.
  Дороже поддерживать; при добавлении exchange'а CCXT даёт нам код
  бесплатно. Пожертвовали тонким контролем за rate-limit-стратегией.

## Реализация

### Backend

```
apps/api/src/modules/cex/
├── cex.types.ts          — whitelist + shared types
├── cex.client.ts         — CCXT factory + normalizeBalance/Trade
├── cex.client.test.ts    — 17 тестов
├── cex.repository.ts     — Drizzle: insert/list/archive/snapshot/upsertTrades
├── cex.service.ts        — connect/list/disconnect/sync
├── cex.service.test.ts   — 9 тестов с FakeRepo + DI factory
└── cex.routes.ts         — POST / GET / DELETE /:id / POST /:id/sync
```

DB schema: `packages/db/src/schema/cex_accounts.ts` →
`packages/db/drizzle/0010_cex_accounts.sql`. Три таблицы:
- `cex_accounts` — encrypted blobs + permissions jsonb + last_synced_at
- `cex_balances` — snapshots по `(cex_account_id, snapshot_at)`
- `cex_trades` — unique `(cex_account_id, exchange_trade_id)` для
  идемпотентности

DI: `app.ts` создаёт `CexRepository`, `CexService` (с `createCexClient`
в качестве `ICexClientFactory`), регистрирует `cexRoutes` под `/api/v1/cex`.

### Frontend

```
apps/web/src/features/cex/{api,hooks}.ts   — Zod + React Query
apps/web/src/components/cex/CexExchangesPanel.tsx   — UI panel
```

Встроен в RegistryPage сразу после WalletList. Карточки бирж со статусом
lastSync, ошибкой, кнопкой "Синхронизировать"; форма подключения с
per-exchange инструкциями ("как создать read-only ключ"). OKX/Bitget
форма автоматически просит passphrase (третий параметр HMAC).

### Тестирование

`pnpm --filter @cap-flow/api exec vitest run src/modules/cex/` →
26 passed (17 client + 9 service). Manual end-to-end не делался —
требуется реальный API-ключ от пользователя.

## Ограничения

- **Permissions inspection** — CCXT не вытаскивает trade/withdraw флаги
  стандартным методом. Сейчас они `unknown:true`. Если в будущем нужны
  точные permissions — добавить exchange-specific override (Bybit
  `privateGetUserQueryApi`, OKX `privateGetUsersSubaccountApikey` и т.д.).
- **Trade history depth** — `fetchMyTrades(since)` ограничен exchange-side
  rate-limit'ом и pagination'ом. Для глубокой истории нужно
  cursor-based crawler с retry'ями (пока tickет под бизнес-нужду).
- **Margin / Futures / Earn** — сейчас все balance lines пишутся с
  `accountType="spot"`. Multi-account support потребует pass'ить
  `params: {accountType}` в `fetchBalance` и эмитить разные snapshots.
- **Integration с operations ledger** — CEX trades сейчас живут в
  отдельной таблице. Промоутить их в `operations` (для FIFO/LIFO/WAC
  cost basis) — отдельный этап.
- **Auto-sync** — пока только ручной "Синхронизировать". Worker
  cron-job для авто-pull раз в час — следующий шаг (по аналогии с
  on-chain wallet refresh).
