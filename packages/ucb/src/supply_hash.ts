/**
 * Pure supply-amounts fingerprint — shared UCB engine (A0). Moved verbatim
 * from `apps/web/src/lib/portfolio/position_overrides.ts` (a localStorage-
 * backed module); that file now re-exports this so its import sites are
 * unchanged. `open_positions` uses it as a fallback position key.
 */
export function supplyAmountsHash(
  supply: ReadonlyArray<{ symbol: string; amount: number }>,
): string {
  if (supply.length === 0) return "";
  return [...supply]
    .map((s) => `${s.symbol.toUpperCase()}:${s.amount.toFixed(4)}`)
    .sort()
    .join(",");
}
