---
date: 2026-05-04
stage: 9
---

# CoinStats — универсальный wallet API

## Контекст

DeBank покрывает ~36 EVM-сетей, Helius/Vybe/Sonar — Solana. Но у нас не
покрыты:
- TON, Bitcoin, Aptos, Sui, Cardano, Tron, XRP, Stellar, Algorand
- Cosmos-экосистема (Osmosis, Injective, Celestia, Sei, Akash, Stride и т.д.)
- Новые EVM L2: Berachain, Monad, HyperEVM, Sonic, Soneium, Plume, Worldchain,
  Unichain, Zircuit, Plasma и десятки других

Если у пользователя появятся такие кошельки — мы их сейчас не отобразим.

## Решение

Подключён CoinStats как **комплементарный источник** для не-EVM-DeBank
и не-Solana сетей.

Roles:
| Сеть | Источник |
|---|---|
| EVM (DeBank-supported) | DeBank (как primary, без изменений) |
| Solana | Helius + Vybe + Sonar (как primary) |
| Все остальные 80+ сетей | **CoinStats** |
| Любая EVM при недоступности DeBank | CoinStats fallback |

Не пытаемся **заменить** DeBank на CoinStats для EVM — наш классификатор
ops, V3 RPC matching, cost basis tracker — всё построено вокруг
DeBank-формата ops. Замена потребовала бы переписать всю pipeline без
существенного выигрыша.

## Реализация (фаза 1)

- `apps/web/src/lib/integrations.ts` — поле `coinstatsApiKey`
- `apps/web/src/pages/SettingsPage.tsx` — карточка `CoinStats (147 сетей)`
- `apps/web/vite.config.ts` — прокси `/coinstats/*`
- `apps/web/src/lib/coinstats.ts` — модуль с типами и функциями:
  - `fetchSupportedBlockchains` — список 147 сетей
  - `fetchWalletBalance` — спот-балансы (40 credits)
  - `fetchWalletDefi` — staking/lending/LP позиции
  - `fetchWalletTransactions` — история (30 credits, требует sync)
  - `syncWallet` — PATCH для индексации (50 credits)

## Стоимость

CoinStats бесплатный тариф: 1М credits/мес. Один кошелёк на refresh =
~70-100 credits (balance + defi). Хватит на десятки кошельков с
ежедневным refresh.

## Дальше (фазы 2-4)

См. ROADMAP. Нужно добавить chain selector в форму кошелька, маршрут в
провайдере, и адаптер CoinStats → `LiveSnapshot` для унификации с
существующим UI.

## Альтернативы (отвергнуты)

- **Zerion API** — похожая универсальность но платный с порога
- **Covalent (GoldRush)** — мощный API но дорогой и сложный pricing
- **Множество отдельных интеграций** (TON через TONapi, Aptos через
  Aptos Indexer и т.д.) — слишком много кода поддерживать
