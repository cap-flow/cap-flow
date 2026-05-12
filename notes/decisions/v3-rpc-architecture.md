---
date: 2026-05-03
stage: 3
---

# V3 RPC архитектура

## Контекст

Для V3-позиций нужны диапазоны Pa/Pb и текущая цена пула. DeBank в
`/all_complex_protocol_list` отдаёт только `supply_token_list` — без тиков
и без NFT tokenId. Альтернативы:

1. **Uniswap V3 subgraph** — бесплатно, но только официальные деплои
2. **On-chain RPC** — универсально, любой V3-форк, точно
3. **Парсить DeBank description** — ненадёжно
4. Игнорировать — потерять exit-сценарии

## Решение

Выбран **on-chain RPC через Alchemy + viem multicall**.

Структура:
- `apps/web/src/lib/v3/chains.ts` — `V3Deployment[]` с адресами NPM/Factory
  per (protocol, chain). Поддерживаемые сейчас:
  - Uniswap V3: ETH, Arb, Op, Polygon, Base, BNB
  - PancakeSwap V3: ETH, Arb, Base, BNB (одинаковые адреса)
  - SushiSwap V3: ETH, Arb, Op, Polygon, Base, BNB, Avalanche (адреса разные)
- `apps/web/src/lib/v3/abis.ts` — минимальные ABI (NPM, Factory, Pool, ERC20)
- `apps/web/src/lib/v3/positions.ts` — `fetchV3PositionsForDeployment()`
  через цепочку multicall:
  1. `NPM.balanceOf(wallet)` → сколько NFT
  2. `tokenOfOwnerByIndex` × N → tokenIds
  3. `positions(tokenId)` × N → (token0, token1, fee, ticks, liquidity)
  4. `Factory.getPool(token0, token1, fee)` × N → poolAddr
  5. `pool.slot0()` × unique pools → sqrtPriceX96, currentTick
  6. `ERC20.symbol/decimals` × unique tokens
- `apps/web/src/lib/v3/hook.ts` — React-хук `useV3Positions(loaded, key)`
  обновляет данные при изменении кошельков

## Почему Alchemy

- Один ключ работает на ETH/Arb/Op/Polygon/Base/BNB — не нужно отдельных
  RPC за сеть
- Бесплатный тариф 100M CU/мес — на одну V3 позицию ~100-200 CU
- viem batch + multicall сжимает много calls в 2-3 round-trip'a

## Расширение

Для нового V3-форка с тем же ABI: добавить запись в `V3_DEPLOYMENTS` с
адресами NPM/Factory и `protocolMatch` regex для DeBank `protocolName`.

Для Algebra-based (другой ABI): отдельный модуль с собственным ABI и
функцией fetch'а.
