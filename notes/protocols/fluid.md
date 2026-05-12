# Fluid Lending

## Что особенного

Smart vaults с **dual-debt механикой**: залог и долг могут быть LP-парами,
а не одиночными активами. Ликвидация работает через автоматический
ребалансер DEX-style, а не через keeper-bot и flashloan.

У каждого vault'а есть параметры:
- `LTV` — макс. доля долга к залогу
- `Liquidation Threshold` — при какой доле начинается ликвидация
- `Liquidation Factor` — сколько от позиции забирает ликвидатор за раз

## Что мы используем сейчас

DeBank отдаёт `health_rate` для Fluid vault'ов корректно. В UI показываем
как `HF X.XX` с цветовой раскраской.

Проверено на двух пользовательских позициях:
- POS-003 (ETH+WBTC залог, USDT0 долг) — HF 1.79
- POS-006 (ETH+WBTC залог, USDT0 долг) — HF 1.83

Ручная проверка по формуле `Σ(collat × LT) / Σ(debt)` с типичными LT 81%
для ETH/WBTC даёт совпадение.

## Что нужно добавить (Этап 7)

- Liquidation price per collateral asset через Fluid Resolver
- Адрес VaultResolver per chain (нужно найти в docs.fluid.instadapp.io)
- Расчёт: `(debtUsd × HF=1) / (LT × collatAmount)`

## Полезные ссылки

- docs.fluid.instadapp.io
- Адреса контрактов на Arbitrum: nontrivial — надо смотреть resolver per vault
