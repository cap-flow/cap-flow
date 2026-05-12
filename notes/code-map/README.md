# Code Map

Навигационная карта по проекту. Не дублирует код — описывает **что где
лежит и как куски связаны**.

## Что это

- [[frontend]] — структура UI: страницы, роутинг, ключевые компоненты
- [[data-sources]] — внешние API (DeBank, Helius, Alchemy, Vybe, Sonar, DefiLlama, Jupiter)
- [[portfolio-pipeline]] — как сырые on-chain ops становятся `OpenPosition[]`
- [[cost-basis-pipeline]] — как считается средняя цена покупки токенов
- [[v3-pipeline]] — путь от Alchemy RPC до V3 popup
- [[storage]] — что лежит в localStorage и где

## Высокоуровневая архитектура

```
┌──────────────────────────────────────────────────────────┐
│                    LoadedWalletsProvider                  │
│  (контекст: ops + live snapshot per wallet)               │
└──────────┬───────────────────────────────────────────────┘
           │
   ┌───────┴────────┬─────────┬──────────┬──────────┐
   ▼                ▼         ▼          ▼          ▼
RegistryPage  OpenPosPage  Portfolio  LedgerPage  Settings
(сырые ops)   (live позиц.)  (live)    (manual)
```

Все страницы получают данные через единый `useLoadedWallets()` хук.
Внутри провайдера — async-загрузка через [[data-sources|внешние API]] и
кэш в localStorage.
