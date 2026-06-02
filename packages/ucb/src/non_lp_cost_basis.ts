/**
 * Stage 2 cost basis for non-LP positions — OUT-side rule (UCB engine):
 * startUsd = value SPENT at open (underlying tokens OUT), NOT a valuation of the
 * receipt token. Moved verbatim from web `lib/nonlp/cost_basis.ts` (B4 slice 2a)
 * so both the client opener detector and the server fetch service share it.
 *
 * Verified example: IPOR — spent 100 USDC → got 91.3 ipsrUSDfusion → startUsd =
 * $100 (not the receipt's current $104). GMX — spent 1000 USDC → got 875 GM →
 * startUsd = $1000.
 *
 * Stage 2a: OUT-side all in STABLES → startUsd = Σ × $1 (no historical-price
 * API). Stage 2b: volatile OUT (ETH/BTC vaults) priced via DefiLlama historical.
 */
import type { OpenedInToken } from "./non_lp_opener.js";

/**
 * Known USD-stables (by symbol, case-insensitive) → historical price ≈ $1 at any
 * time, so startUsd = amount without a price-API call. EUR-stables are NOT here
 * (their rate ≠ $1 — needs DefiLlama, Stage 2b).
 */
const USD_STABLES = new Set([
  "USDC",
  "USDC.E",
  "USDBC",
  "USDT",
  "USD₮0",
  "USDT0",
  "USD0",
  "DAI",
  "FRAX",
  "LUSD",
  "GUSD",
  "USDP",
  "TUSD",
  "USDD",
  "USDE",
  "SUSDE",
  "RUSD",
  "SRUSD",
  "CRVUSD",
  "GHO",
  "DOLA",
  "MIM",
  "ALUSD",
  "BUSD",
  "FDUSD",
  "PYUSD",
  "USDX",
]);

export function isUsdStable(symbol: string): boolean {
  return USD_STABLES.has(symbol.toUpperCase().trim());
}

/**
 * startUsd from the OUT-side when ALL spent tokens are USD-stables. Returns null
 * if any OUT is non-stable (needs Stage 2b / fallback) or OUT is empty. "All
 * must be stable": a USDC+ETH deposit needs ETH priced historically (Stage 2b);
 * partial valuation would understate startUsd — better null than lie.
 */
export function startUsdFromStableOut(
  openedInTokens: readonly OpenedInToken[],
): number | null {
  if (openedInTokens.length === 0) return null;
  let sum = 0;
  for (const t of openedInTokens) {
    if (!isUsdStable(t.symbol)) return null; // non-stable → bail to Stage 2b
    sum += t.amount;
  }
  return sum > 0 ? sum : null;
}

/**
 * Stage 2b: startUsd when the OUT has volatile tokens (WETH/WBTC/WAVAX/…).
 * Stables → $1, volatile → historical price at deposit (`priceByAddress`,
 * lowercased addr → USD). If ANY volatile token lacks a price → null (partial
 * valuation would understate; better fallback than lie). `priceByAddress` is
 * built by the caller from DefiLlama historical.
 */
export function startUsdFromPricedOut(
  openedInTokens: readonly OpenedInToken[],
  priceByAddress: ReadonlyMap<string, number>,
): number | null {
  if (openedInTokens.length === 0) return null;
  let sum = 0;
  for (const t of openedInTokens) {
    if (isUsdStable(t.symbol)) {
      sum += t.amount;
      continue;
    }
    const px = priceByAddress.get(t.address.toLowerCase());
    if (px == null || !(px > 0)) return null; // no price → bail
    sum += t.amount * px;
  }
  return sum > 0 ? sum : null;
}
