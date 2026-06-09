# Эталонные LP-позиции — mmaksimuk (2026-06-03)

19 LP-эталонов (Uniswap V3×16 / V4×1 / Velodrome×1 / Pancake×1), оба кошелька.
**Анкер = startUsd (cost basis) + полный реестр on-chain.** Динамику (currentUsd/PnL/fee)
НЕ морозим. cost basis = Σ DEPOSIT.value (block-time priced). Источник: LP→Krystal /transactions,
Velodrome→on-chain mint×slot0. Допуск 1%. Raw per-позиция — JSON-файлы рядом.

| tokenId | protocol | chain | startUsd (Σ deposit) | deposits | claimed | source | first deposit tx |
|---|---|---|---|---|---|---|---|
| 5299587 | uniswapv3 | 42161 | $8149.342885473098 | 1 | 1 | krystal | 0xdf9aa67e47e82af1… |
| 1196206 | uniswapv3 | 1 | $6329.485805811174 | 4 | 1 | krystal | 0x000a4e55f0de2e6d… |
| 147480 | uniswapv4 | 42161 | $1749.143752971976 | 1 | 0 | krystal | 0x351a9f8bcf42ce2d… |
| 1245807 | uniswapv3 | 1 | $1735.5152163054045 | 1 | 0 | krystal | 0xd61363000461fcbf… |
| 5292019 | uniswapv3 | 42161 | $1726.3781703206423 | 1 | 1 | krystal | 0xcb32fb6a978901d3… |
| 5266800 | uniswapv3 | 42161 | $501.1988326665513 | 1 | 1 | krystal | 0x1a6919d0f4e6d626… |
| 1245582 | uniswapv3 | 1 | $468.13043220774045 | 1 | 0 | krystal | 0x179e77241b6d363a… |
| 1220776 | uniswapv3 | 1 | $256.9661868149454 | 1 | 0 | krystal | 0x3ac1c0fee957c3c8… |
| 1220777 | uniswapv3 | 1 | $256.9659645403443 | 1 | 0 | krystal | 0x9931b234f2e96a73… |
| 1237257 | uniswapv3 | 1 | $245.5207108076448 | 1 | 0 | krystal | 0xb8aca50e3bdcb9e5… |
| 3427934 | velodrome-cl | 10 | $237.80 | 1 | 0 | etherscan_slot0 | 0x0ae402fb84370ce4… |
| 1227688 | uniswapv3 | 1 | $223.2760403741615 | 3 | 0 | krystal | 0xdf14a5f37b365209… |
| 5446793 | uniswapv3 | 42161 | $187.12398172438762 | 1 | 0 | krystal | 0x5227fb5202c718f4… |
| 1197113 | uniswapv3 | 1 | $165.54141625915668 | 1 | 1 | krystal | 0xa7bccc4420816d3a… |
| 1220760 | uniswapv3 | 1 | $138.68100562151182 | 1 | 0 | krystal | 0xb3cbb65dc86517f9… |
| 5375541 | uniswapv3 | 42161 | $121.46874325361262 | 1 | 0 | krystal | 0xaaf0bd08213eb250… |
| 1237252 | uniswapv3 | 1 | $78.06101970455704 | 1 | 0 | krystal | 0x69057d9d6e1645b2… |
| 5393696 | uniswapv3 | 42161 | $75.59689618488501 | 1 | 0 | krystal | 0x4db146c330750add… |
| 238921 | pancakev3 | 42161 | $33.06 | 0 | 0 | krystal_position_level | —… |

## Заметки по флагам
- **#147480 (Uniswap V4)**: V4 `totalDepositValue` ЗАДВАИВАЕТ providedAmounts → cost basis ТОЛЬКО из /transactions Σ DEPOSIT ($1749.14, не $3499).
- **#3427934 (Velodrome, gauge-staked)**: Krystal не покрывает (owner=gauge). cost basis из on-chain mint IncreaseLiquidity × hist-price@block. DefiLlama $237.80 / slot0 $235.97 (anchor $235.97). ⚠ интермиттентный placeholder $104.70 при сбое gauge-discovery (Alchemy 429) — anchor ловит это как drift.
- **#1220776/#1220777 (USDT/SLVon)**: два разных NFT, делят supplyHash-instanceId → утечка override-ключа (FAIL, к фиксу).
- **#238921 (PancakeSwap)**: ⚠ Krystal /transactions ПУСТ; cost basis из position-level totalDepositValue ($33.06, net). On-chain первый mint ~150 CAKE gross, частично выведена. Единственный из 19, где cb не сошёлся от /transactions — менее надёжный эталон.

## Связь с golden_cases (БД)
Эти 19 размечены в `golden_cases` (kind=golden, expected_start_usd + tolerance 1% + source_of_truth).
Этот ledger = слой 2 (репо, полный реестр). derivation в БД содержит сводку; полный реестр здесь.
