# Glossary

Термины проекта.

## DeFi-механики

**LTV** (Loan-to-Value) — какую долю стоимости залога можно занять.

**LT / Liquidation Threshold** — при какой доле занятого от залога позиция
ликвидируется. LT всегда ≥ LTV.

**HF / Health Factor** — `Σ(collat × LT) / Σ(debt)`. Если HF < 1 — позиция
ликвидируется. Цвета HF в UI:
- ≥ 1.5 — зелёный (здоровая)
- 1.15–1.5 — оранжевый (под наблюдение)
- < 1.15 — красный с пульсирующей точкой (риск)

**Liquidation Penalty / Bonus** — скидка для ликвидатора (5–15% обычно).

**IL / Impermanent Loss** — отставание стоимости LP от стратегии HODL:
`IL = HODL_value − Current_LP_value`. Положительный IL = LP проиграл HODL.

## V3 / Concentrated Liquidity

**Pa, Pb** — нижняя и верхняя границы ценового диапазона позиции (token1/token0).

**tickLower, tickUpper** — целочисленные представления Pa и Pb. Цена через тик:
`P = 1.0001^tick × 10^(decimals0 − decimals1)`.

**sqrtPriceX96** — текущая цена пула в формате `sqrt(P_raw) × 2^96`.

**In range** — `tickLower ≤ currentTick < tickUpper`. Только тогда позиция
получает fees.

**P_break** — точка безубытка после выхода вниз:
`P_break = depositUsd / amount0AtPa`. Сколько должен стоить базовый актив,
чтобы вернуть депозит после фиксации в нём.

**Pending fees** — uncollected fees, ещё в позиции (`lp.rewards`).

**Claimed fees** — уже снятые в кошелёк через `claim_rewards`.

**Lifetime fees** — `pending + claimed`. Полный доход за время жизни
позиции.

## Протоколы

**Uniswap V3** — концентрированная ликвидность, NFT-позиции, 0.01/0.05/0.30/1% fee tiers.

**PancakeSwap V3 / SushiSwap V3** — прямые форки Uniswap V3, тот же ABI.

**Fluid Lending** — smart vaults с залогом и долгом, агрегатор DEX-style
ребалансер вместо кейпер-ликвидаций.

**Aave V3** — стандартный pool-based lending; `Pool.getUserAccountData()`
возвращает HF одной RPC.

**Morpho Blue** — изолированные lending-маркеты с фиксированным `lltv`.

**GMX V2** — perp + LP пулы (`GM` токен = LP-position-token).

## Внутренние термины

**Cost basis** — кумулятивная средневзвешенная цена покупки актива по истории
кошелька (`Σ заплачено / Σ получено`).

**Money-trace / taint tracking** — атрибуция кредитных средств по позициям
через FIFO consumption из `creditBalance`.

**Position weight** — `currentUsd / Σ currentUsd × 100%`.

**Total APR** — годовая доходность с учётом lifetime fees:
`(currentUsd + feesLifetime − startUsd) / startUsd × 365 / ageDays × 100`.
