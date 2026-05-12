---
date: 2026-05-11
stage: SaaS Phase 3c
---

# SaaS Phase 3c — Solana balances инфраструктура (Helius)

## Контекст

Phase 3b закрыла EVM через DeBank. Phase 3c добавляет Solana — второй
по востребованности экосистемы у Capflow users — без жёсткой зависимости
от API-ключа: инфраструктура готова, активируется автоматически когда
admin добавит `HELIUS_API_KEY` в `apps/api/.env`.

## Решение

### Single-provider strategy для Solana

В отличие от EVM (DeBank даёт TVL, Alchemy — token detail, два уровня),
для Solana на старте достаточно одного провайдера — Helius:
- одна HTTP-call → native lamports + array of SPL token balances
- per-mint USD pricing отложено (требует mint→coingecko_id mapping,
  это отдельный slice, не блокирует ostalin pipeline)

### `HeliusClient` следует тому же паттерну, что DeBank/Alchemy

- Constructor принимает `apiKey: string | undefined`.
- Геттер `isLive` решает на каждом вызове.
- Без ключа `getBalances` возвращает `{nativeLamports: 0, tokens: []}`,
  `getWalletBalances` (контракт `IBalanceProvider`) возвращает `[]`.
- С ключом → реальный `https://api.helius.xyz/v0/addresses/:addr/balances`.

### Pipeline разделил per-network ветки

`PortfolioRefreshService.refreshAccount` теперь итерирует addresses по
типу:
- `type === "evm"` → DeBank
- `type === "solana"` → Helius
- `type ∈ {tron, btc, other}` → запись в `metrics.addressesSkipped`

Snapshot `metrics`:
```
{
  totalUsd: <EVM only — Solana пока не price-resolve-ится>,
  addressesEvm: N,
  addressesSolana: M,
  addressesSkipped: K,
  refreshedFrom: ["debank", "helius?"],
  perAddress: [
    {address, walletName, kind: "evm"|"solana", totalUsd, chains, tokens?, error?}
  ],
  ...
}
```

`totalUsd` пока **EVM-only** — это намеренно. Когда добавится
mint→coingecko_id mapping + per-SPL price resolution, формула станет
`totalUsd = evmTotal + solanaTotal`. До тех пор Solana строки в
`perAddress` информационные (admin видит сколько токенов на адресе).

## Альтернативы

- **Подключить Coinstats** (multi-chain unified API, 147 сетей) — отложили.
  Coinstats хорош для общего TVL агрегатов, но Helius даёт **больше
  деталей** для Solana DeFi (mint addresses → нужны для resolution).
  Помимо этого Coinstats доступен только по pay-tier ключу с лимитами,
  Helius free-tier щедрее.
- **Сразу прайсить SPL** через Jupiter Price API — нужен mint-аддресс
  → CoinGecko platform mapping. Это отдельный slice — `coingecko_registry`
  расширить колонкой `solana_mint`, и `resolveCoingeckoId` сделать
  match-by-mint. На beta с 1-2 Solana адресами админа цена $0 в `metrics`
  не критична.
- **Port существующего Solana cost basis (`apps/web/src/lib/portfolio/
  solana_classifier.ts`)** на server — слишком большое для Phase 3c.
  Оставляем для Phase 4 (cost basis port).

## Реализация

### Env (новое)
- `HELIUS_API_KEY` (optional)
- `COINSTATS_API_KEY` (optional, заготовлен для Phase 3d)

### Files
- `apps/api/src/modules/integrations/helius.ts` — HeliusClient implements
  `IBalanceProvider`. Method `getBalances(address)` возвращает
  `{nativeLamports, tokens[]}`.
- `apps/api/src/modules/integrations/types.ts` — расширил `ProviderName`
  через `helius` + `coinstats`.
- `apps/api/src/modules/portfolio/portfolio-refresh.service.ts` —
  переписан: per-type branching (`evm` vs `solana` vs `else`), отдельная
  `logUsage` helper для DRY api_usage записей.
- `apps/api/src/worker.ts` — добавлен `HeliusClient` в DI в
  `PortfolioRefreshService`.

## E2E (graceful no-helius-key)

| # | Что | Результат |
|---|---|---|
| 1 | POST /accounts/:id/wallets/:wid/addresses (Mango Markets, type=solana) | 201 + addressId |
| 2 | Manual refresh | 202 + jobId |
| 3 | Worker log `refresh completed` | без ошибок |
| 4 | refresh-status `addressesSolana: 1, addressesEvm: 1, refreshedFrom: ["debank"]` (Helius пропущен — нет ключа) | ✓ |
| 5 | totalUsd остался $1,279,551 (EVM only) | ✓ |
| 6 | api_usage logs: только debank row (Helius isLive=false → не вызывается) | ✓ |

## Ограничения

- **Solana TVL = $0 пока не подключен mint pricing**. Цифра в
  `totalUsd` остаётся EVM-only. Когда добавится `coingecko_registry`
  по mint + Jupiter/CoinGecko per-SPL resolution — Solana встанет в
  общую сумму без правок refresh service.
- **HELIUS_API_KEY должен быть скопирован в `apps/api/.env`** для
  активации. Тот же паттерн что Tronscan/DeBank/Alchemy.
- **Нет Helius RPC fallback** для transaction history — только balances
  endpoint. История транзакций (для cost basis) — Phase 4 territory.
- **Tron balances (не billing)** не покрыты Phase 3c. Нужен отдельный
  TronBalanceClient (api.tronscan.org/api/account?address=...). Маленький
  slice если потребуется.
