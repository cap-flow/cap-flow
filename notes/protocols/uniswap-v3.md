# Uniswap V3

## Контракты

| Сеть | NPM | Factory |
|---|---|---|
| Ethereum | 0xC36442b4a4522E871399CD717aBDD847Ab11FE88 | 0x1F98431c8aD98523631AE4a59f267346ea31F984 |
| Arbitrum | те же | те же |
| Optimism | те же | те же |
| Polygon | те же | те же |
| Base | 0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1 | 0x33128a8fC17869897dcE68Ed026d694621f6FDfD |
| BNB | 0x7b8A01B39D58278b5DE7e48c8449c9f4F5170613 | 0xdB1d10011AD0Ff90774D0C6Bb92e5C5c8b4461F7 |

## Чтение позиций

`NonfungiblePositionManager.positions(tokenId)` →
```
{ token0, token1, fee, tickLower, tickUpper, liquidity,
  feeGrowthInside0LastX128, feeGrowthInside1LastX128,
  tokensOwed0, tokensOwed1 }
```

## Цена из tick

```
P_human = 1.0001^tick × 10^(decimals0 − decimals1)
```

Пример: WETH/USDC, tickLower = 195000.
`P = 1.0001^195000 × 10^(18-6)` ≈ некая цена USDC за WETH.

## Amounts при разных ценах

Для `liquidity = L`, `sqrtPriceX96`:
- Внутри диапазона: смесь token0 и token1
- При `price ≤ Pa`: всё в token0 (base)
- При `price ≥ Pb`: всё в token1 (quote)

Формулы (whitepaper §6.2.9):
```
amount0 = L × (sqrtPb − sqrtP) / (sqrtP × sqrtPb)
amount1 = L × (sqrtP − sqrtPa)
```

## Fee tiers

- 0.01% (1) — стейбл-стейбл
- 0.05% (500) — major pairs
- 0.30% (3000) — стандарт
- 1.00% (10000) — экзотика

## Проверка работы в проекте

V3 popup на странице открытых позиций показывает на реальных позициях:
- POS-001 (WETH/USDC 0.05%): Pa=1900, Pb=3800, current=2308 — в диапазоне
- POS-002 (WBTC/USDT0 0.05%): Pa=64980, Pb=99989, current=78137 — в диапазоне
