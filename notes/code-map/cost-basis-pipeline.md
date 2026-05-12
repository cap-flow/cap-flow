# Cost Basis Pipeline

Как вычисляется средневзвешенная цена покупки актива и используется в UI.

## Файлы

- `apps/web/src/lib/portfolio/cost_basis_avg.ts` — простой helper
  `weightedAvgPurchase()` для одного символа из swap'ов
- `apps/web/src/lib/portfolio/cost_basis_tracker.ts` — полноценный
  `CostBasisTracker` со снапшотами по времени + LP-close attribution

## Базовая логика

Кумулятивная средневзвешенная цена покупки за всю историю кошелька:

```
avg = Σ заплаченных стейблов / Σ полученного актива
```

**Покупками** считаются только `swap` ops, где OUT — стейблы (USDC/USDT/DAI/USDT0)
и IN — целевой токен. Это «реальная цена за фиат».

## Расходы не меняют avg

`lend_supply`, `lp_add`, `transfer_out`, `repay`, `stake` — НЕ обнуляют
накопленные данные. Это «история покупок за фиат за всё время», и
расходы её не трогают. Только баланс меняется (для отладки).

## Снапшоты по времени

`tracker.avgAt(symbol, time)` — возвращает `avgUsd`, актуальный на момент
`time`. Используется в `open_positions.ts` чтобы при `lend_supply 0.35 ETH @ 2026-03-05`
взять avg, который был **на момент** депозита (а не сегодняшний).

Бинарный поиск по массиву snapshot'ов, добавляемых при каждом `tracker.buy`.

## Specific case: LP closes (Этап 5)

Двухпроходная атрибуция в `attributeLpCloses()`:

1. **Pass 1** — сгруппировать ops по `${protocolId}|${chain}`:
   - `lp_add`: `group.depositUsd += Σ amount × hist_price`
   - `lp_remove`: `group.closes.push({ ins, totalUsd })`

2. **Pass 2** — для каждого close:
   ```
   share = closeUsd / Σ allCloseUsd_в_этой_группе
   attributedCost = group.depositUsd × share
   ```
   Распределяется между IN-токенами по их USD-весу. Используется как
   `paidUsd` в `tracker.buy()`.

Без этого шага закрытие LP даёт искажённую среднюю — токены приходят с
текущей spot-ценой, и убыток LP «теряется».

См. [[../decisions/lp-cost-basis]].

## Где используется

### `OpenPosition.supplyTokens[].avgBuyPrice`
В `open_positions.ts` для каждого supply-токена:
```ts
const avg = tracker.avgAt(symbol, openedAt);
const startUsd = amount × avg;
```

Это «стартовая стоимость» позиции — сколько фиата пользователь реально
заплатил за токены, лежащие в позиции сейчас.

### Realized PnL по токенам в портфеле
PortfolioPage показывает `pnlUsd = currentUsd - costBasisUsd` и
`pnlPct = pnlUsd / costBasisUsd × 100` для каждого спот-балансного токена.

### Бейдж в Реестре операций
`RegistryPage` для каждого `lp_remove` показывает синий бейдж
«cost basis +$X» — атрибуцированную сумму.

## Что НЕ учитывается

- Покупки за **не-стейбл** (ETH ← BTC через swap, transfer_in от друга и т.д.)
  не входят в avg. Намеренно — пользователь хочет «сколько фиата я
  потратил на актив», а не «через какие активы прошёл».
- Bridge_in, transfer_in от внешних — не покупки.
- Yield/rewards (claim_rewards) — не покупки, а доход. Сейчас
  игнорируются в трекере (приходят с zero cost basis).

## Известные ограничения

- Группировка LP-close по `protocolId+chain` — две позиции в разных парах
  одного протокола на одной сети (e.g. Uniswap V3 ETH/USDC + ETH/WBTC)
  объединяются. Точное разделение требует tokenId, которого DeBank не отдаёт.
- Если в реестре истории не хватает (старые ops до `since`), avg может
  быть неточным.
