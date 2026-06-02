/**
 * Pure V3 per-event USD pricing (UCB engine — B3-full layer 2). Extracted from
 * the web `use_liquidity_events.ts::deriveUsdPrices` so the client + the server
 * turn a pool slot0 ratio (or a DefiLlama fallback) into token0/token1 USD prices
 * identically. The fetch that PRODUCES the slot0 ratio + the DefiLlama lookup is
 * injected — this stays pure/testable.
 *
 * Priority (first that resolves wins):
 *   1. slot0 ratio (price1Per0) when one side is a USD-stable
 *   2. slot0 ratio + USD anchor pool (WETH/USDC slot0 same block) for
 *      volatile/volatile pairs where one side is the anchor token
 *   3. DefiLlama historical per-token USD at the event block time
 *   4. null (event unpriceable → skipped in the cost-basis sum)
 */
import { isStableSymbol } from "./protocols.js";

/** Pool price snapshot at the event block (slot0-derived). */
export interface V3PoolPrice {
  /** token1 per 1 token0 (decimal-adjusted). */
  price1Per0: number;
  /** Non-stable anchor token address (lowercase) when a USD anchor was read. */
  anchorTokenAddress?: string;
  /** USD price of the anchor token at the event block. */
  anchorTokenUsd?: number;
}

export interface V3PriceToken {
  symbol: string;
  address: string;
}

/** Injected DefiLlama lookup: (tokenAddress, symbol, blockTime) → USD or null. */
export type LlamaPriceForToken = (
  address: string,
  symbol: string,
  blockTime: number,
) => number | null;

/**
 * Derive { p0, p1 } USD prices for an event. `pp` is the pool slot0 price (may be
 * undefined — e.g. Velodrome Slipstream slot0 decode fails → go straight to the
 * DefiLlama fallback). `blockTime` + `llamaPriceForToken` drive the fallback.
 */
export function deriveUsdPrices(
  token0: V3PriceToken,
  token1: V3PriceToken,
  pp: V3PoolPrice | undefined,
  blockTime: number | undefined,
  llamaPriceForToken: LlamaPriceForToken,
): { p0: number; p1: number } | null {
  const t0Sym = token0.symbol;
  const t1Sym = token1.symbol;
  const t0Addr = token0.address.toLowerCase();
  const t1Addr = token1.address.toLowerCase();
  const stable0 = isStableSymbol(t0Sym);
  const stable1 = isStableSymbol(t1Sym);

  if (pp) {
    if (stable1) {
      return { p0: pp.price1Per0, p1: 1 };
    }
    if (stable0 && pp.price1Per0 > 0) {
      return { p0: 1, p1: 1 / pp.price1Per0 };
    }
    const anchorAddr = pp.anchorTokenAddress?.toLowerCase();
    const anchorUsd = pp.anchorTokenUsd;
    if (anchorAddr && anchorUsd && anchorUsd > 0) {
      if (t0Addr === anchorAddr && pp.price1Per0 > 0) {
        return { p0: anchorUsd, p1: anchorUsd / pp.price1Per0 };
      }
      if (t1Addr === anchorAddr) {
        return { p0: anchorUsd * pp.price1Per0, p1: anchorUsd };
      }
    }
  }

  // DefiLlama fallback — direct per-token historical USD prices.
  if (blockTime) {
    const p0 = llamaPriceForToken(t0Addr, t0Sym, blockTime);
    const p1 = llamaPriceForToken(t1Addr, t1Sym, blockTime);
    if (p0 != null && p0 > 0 && p1 != null && p1 > 0) {
      return { p0, p1 };
    }
  }
  return null;
}
