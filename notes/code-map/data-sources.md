# Data Sources

Внешние API, через которые проект получает on-chain данные.

## EVM (Ethereum + L2)

### DeBank Cloud
`apps/web/src/lib/debank.ts`. Основной источник для EVM.
- `/v1/user/all_history_list` — история транзакций (с пагинацией)
- `/v1/user/all_complex_protocol_list` — открытые DeFi-позиции
- `/v1/user/all_token_list` — спот-балансы
- `/v1/user/total_balance` — суммарная стоимость

Ключ: `Settings → Интеграции → DeBank AccessKey`. Прокси через Vite (`/debank/...`)
для обхода CORS.

### Alchemy (V3 RPC)
`apps/web/src/lib/v3/`. Используется только для V3 LP позиций.
- `eth-mainnet` / `arb-mainnet` / `opt-mainnet` / `polygon-mainnet`
  / `base-mainnet` / `bnb-mainnet` subdomains
- `viem.createPublicClient` + `multicall` для batched eth_call

См. [[v3-pipeline]].

### DefiLlama
`apps/web/src/lib/defillama.ts`. Исторические цены токенов на момент tx.
- Используется в [[lp-cost-basis|cost basis tracker]] для расчёта депозита
  V3 в момент `lp_add`
- Кэш в localStorage `capflow.cache.defillama.v1`

## Solana

### Helius
`apps/web/src/lib/helius.ts`. История транзакций + балансы Solana.
- `/v0/addresses/:addr/transactions` — история
- `/v0/addresses/:addr/balances` — балансы

Ключ: `Settings → Helius API key`.

### Vybe Network
`apps/web/src/lib/vybe.ts`. Solana DeFi-позиции (Drift, Kamino, Marginfi и т.д.).
- `/wallets/:addr/defi-positions`

Ключ: `Settings → Vybe X-API-Key`.

### SonarWatch
`apps/web/src/lib/sonar.ts`. Бесплатный fallback для Solana DeFi-позиций.
- `/portfolio/fetch?address=...&addressSystem=solana`
- Без ключа.

### Jupiter
`apps/web/src/lib/jupiter.ts`. Цены SPL-токенов.
- `/price/v2?ids=...`
- Без ключа.

## Адаптеры

`apps/web/src/lib/portfolio/live_adapters.ts` приводит ответы всех
источников к единому типу `LiveSnapshot`:

```ts
LiveSnapshot {
  totalUsd: number
  tokens: LiveTokenBalance[]
  positions: LiveProtocolPosition[]
}
```

`adaptDeBankLive` / `adaptSolanaLive` / `adaptVybeLive` / `adaptSonarLive` —
конвертеры. См. [[portfolio-pipeline]].
