/**
 * Pure V3 cost-basis aggregation (UCB engine — B3-full layer 2a). Extracted from
 * the web `use_liquidity_events.ts` compute loop so the client + the server turn
 * the SAME on-chain events into the SAME `V3CostBasisResult`. The per-event USD
 * pricing (slot0 ratio → p0/p1, or DefiLlama fallback) is INJECTED as
 * `priceForEvent` — the fetch that produces those prices stays client/server-side.
 *
 * Cost basis = Σ(IncreaseLiquidity USD) − Σ(DecreaseLiquidity USD), clamped ≥ 0
 * (WAC: original capital invested minus what the user already withdrew).
 */
import type { V3CostBasisResult, V3LiquidityEvent } from "./v3_types.js";

/** Minimal position shape the aggregation needs (token decimals + id). */
export interface V3CostBasisInput {
  tokenId: bigint;
  token0: { decimals: number };
  token1: { decimals: number };
}

/** Per-event USD prices for token0 / token1 (or null when unpriceable). */
export type PriceForEvent = (
  e: V3LiquidityEvent,
) => { p0: number; p1: number } | null;

export function computeV3CostBasis(
  position: V3CostBasisInput,
  increases: readonly V3LiquidityEvent[],
  decreases: readonly V3LiquidityEvent[],
  priceForEvent: PriceForEvent,
): V3CostBasisResult {
  const dec0 = position.token0.decimals;
  const dec1 = position.token1.decimals;

  let totalDeposited0 = 0;
  let totalDeposited1 = 0;
  let totalWithdrawn0 = 0;
  let totalWithdrawn1 = 0;
  let totalDepositUsd = 0;
  let totalWithdrawUsd = 0;
  let hasHistPrices = false;
  // Per-tx withdrawal amounts for the collect-vs-decrease split downstream.
  const withdrawalsByTxHash = new Map<string, { amount0: number; amount1: number }>();

  for (const e of increases) {
    const a0 = Number(e.amount0Raw) / 10 ** dec0;
    const a1 = Number(e.amount1Raw) / 10 ** dec1;
    totalDeposited0 += a0;
    totalDeposited1 += a1;
    const px = priceForEvent(e);
    if (px) {
      hasHistPrices = true;
      totalDepositUsd += a0 * px.p0 + a1 * px.p1;
    }
  }
  for (const e of decreases) {
    const a0 = Number(e.amount0Raw) / 10 ** dec0;
    const a1 = Number(e.amount1Raw) / 10 ** dec1;
    totalWithdrawn0 += a0;
    totalWithdrawn1 += a1;
    // Aggregate multiple decrease events in one multicall tx; lowercase the hash
    // for a consistent match against op.hash (DeBank is often mixed-case).
    const key = e.txHash.toLowerCase();
    const prev = withdrawalsByTxHash.get(key);
    if (prev) {
      withdrawalsByTxHash.set(key, {
        amount0: prev.amount0 + a0,
        amount1: prev.amount1 + a1,
      });
    } else {
      withdrawalsByTxHash.set(key, { amount0: a0, amount1: a1 });
    }
    const px = priceForEvent(e);
    if (px) {
      totalWithdrawUsd += a0 * px.p0 + a1 * px.p1;
    }
  }

  const netCostBasisUsd = Math.max(0, totalDepositUsd - totalWithdrawUsd);

  // Earliest IncreaseLiquidity = mint tx (matches OpenPosition.openHash).
  const sortedInc = [...increases].sort((a, b) =>
    Number(a.blockNumber - b.blockNumber),
  );
  const mintTxHash = sortedInc[0]?.txHash;
  const mintBlockTime = sortedInc[0]?.blockTime;

  return {
    tokenId: position.tokenId,
    totalDeposited0,
    totalDeposited1,
    totalWithdrawn0,
    totalWithdrawn1,
    totalDepositUsd,
    totalWithdrawUsd,
    netCostBasisUsd,
    eventCount: { increase: increases.length, decrease: decreases.length },
    hasHistPrices,
    ...(mintTxHash && { mintTxHash }),
    ...(mintBlockTime !== undefined && { mintBlockTime }),
    ...(withdrawalsByTxHash.size > 0 && { withdrawalsByTxHash }),
  };
}
