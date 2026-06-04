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

/** Net/leverage line for a position. `leverage` is null when undefined (e.g. fully levered). */
export interface LeverageDisplay {
  /** Net exposure now = currentUsd − currentDebtUsd (clamped ≥ 0). */
  netUsd: number;
  /** currentUsd / netUsd, or null when netUsd is too small to be meaningful. */
  leverage: number | null;
}

/**
 * Leverage / net-exposure indicator derived from the position's LIVE protocol
 * debt (`currentDebtUsd`), NOT from historical borrow-op attribution.
 *
 * The lending protocol itself ties the debt to this position's collateral
 * (one market, one health factor), so this needs no fund-flow tracing and is
 * not fooled by cross-protocol borrows or by stale/missing `borrow` ops in the
 * registry. Returns null when there is no meaningful debt → plain LP / staking /
 * no-borrow positions show NO "net · N×" line (the false-leverage class of bug
 * that came from reading the unreliable `netStartUsd`).
 *
 * Debt below `max($1, 1% of currentUsd)` is treated as noise (no line).
 */
export function leverageDisplay(
  currentUsd: number,
  currentDebtUsd: number,
): LeverageDisplay | null {
  if (!Number.isFinite(currentUsd) || !Number.isFinite(currentDebtUsd)) return null;
  if (currentDebtUsd <= Math.max(1, currentUsd * 0.01)) return null;
  const netUsd = currentUsd - currentDebtUsd;
  const leverage =
    netUsd >= MIN_START_USD_FOR_PCT ? currentUsd / netUsd : null;
  return { netUsd: Math.max(0, netUsd), leverage };
}
