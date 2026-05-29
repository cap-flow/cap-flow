/**
 * Guards for displaying position PnL percentages.
 *
 * A bare `startUsd > 0` check is NOT enough: when cost basis can't be derived
 * (e.g. Velodrome gauge-staked positions), startUsd collapses to a floating
 * dust value like 1.64e-15 — which is `> 0` yet makes `pnl / startUsd` explode
 * (POS-011 rendered +6.8e18 %). Treat anything below one cent as "cost basis
 * unknown" and surface it as a warning instead of a fake percentage.
 */

/** Below this, startUsd is treated as unknown/dust — percentages are meaningless. */
export const MIN_START_USD_FOR_PCT = 0.01;

/** True when startUsd is large enough for a percentage to be meaningful. */
export function isStartUsdMeaningful(startUsd: number): boolean {
  return Number.isFinite(startUsd) && startUsd >= MIN_START_USD_FOR_PCT;
}

/**
 * Position PnL %, or null when startUsd is below the meaningful threshold
 * (unknown / dust cost basis). Callers render "⚠ —" for null.
 */
export function safePnlPct(pnlUsd: number, startUsd: number): number | null {
  if (!isStartUsdMeaningful(startUsd)) return null;
  if (!Number.isFinite(pnlUsd)) return null;
  const pct = (pnlUsd / startUsd) * 100;
  return Number.isFinite(pct) ? pct : null;
}
