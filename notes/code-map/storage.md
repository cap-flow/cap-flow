# Storage

Что лежит в localStorage и где.

## Ключи

| Ключ | Тип | Источник | Назначение |
|---|---|---|---|
| `capflow.integrations` | `Integrations` | `Settings` | API-ключи DeBank, Helius, Vybe, Alchemy |
| `capflow.wallets` | `WalletsState` | `RegistryPage` | Список добавленных кошельков |
| `capflow.profile` | `Profile` | `Settings` | Имя, аватар, язык |
| `capflow.theme` | `"light" \| "dark"` | `ThemeProvider` | Тема UI |
| `capflow.cache.v6.wallet.{id}` | `Loaded` | `LoadedWalletsProvider` | Кэш загруженных ops + live |
| `capflow.cache.defillama.v1` | hist prices | `defillama.ts` | DefiLlama цены за дату |
| `capflow.credit_overrides` | `Record<key, true>` | `OpenPositionsPage` | Ручные метки кредитных позиций |

## useLocalStorage hook

`apps/web/src/lib/useLocalStorage.ts`. Нюансы реализации:
- **Synchronous write** в setter (не ждёт useEffect)
- Кросс-табная синхронизация через нативный `storage` event
- In-tab синхронизация через custom event `capflow:storage`
- No-op write если контент не изменился (защита от циклов)

## Versioning кэша

`apps/web/src/lib/cache.ts` поддерживает `CACHE_VERSION` (сейчас 6).
При каждом значимом изменении логики (классификатор, адаптер балансов,
фильтр спама) поднимаем версию — старые кэши автоматически инвалидируются
при загрузке модуля.

## Объём

| Что | Объём | Замечание |
|---|---|---|
| Один EVM кошелёк | 100КБ–2МБ | Зависит от глубины истории |
| Один Solana кошелёк | 50КБ–1МБ | |
| DefiLlama цены | 5–20КБ | Только для V3 hist цен |

При >5МБ суммарно localStorage может начать выкидывать `QuotaExceededError`
— тогда нужно мигрировать на IndexedDB.

## Гидратация

При первом рендере `LoadedWalletsProvider` сканирует `capflow.cache.v6.wallet.*`
ключи и поднимает все ранее загруженные кошельки в state. Это даёт
**мгновенный старт без API-запросов** — весь UI собирается из кэша.

`load()` потом подсасывает только новые ops (incremental sync) через
`since` параметр в `/v1/user/all_history_list`.
