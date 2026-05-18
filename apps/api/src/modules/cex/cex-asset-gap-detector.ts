/**
 * UCB Bob-test fix #5: detect assets c "missing acquisition data" on CEX.
 *
 * Корень проблемы: если CCXT адаптер не вернул deposit history (BingX
 * без proper API permission, retention limit и т.п.), CexCostBasisService
 * pool для этого asset стартует с cost=0. Subsequent sales выдают
 * overstated realized gain — это ломает tax export accuracy.
 *
 * Detector aggregates per-asset suma:
 *   inflow  = bought (in trades) + deposited
 *   outflow = sold (in trades) + withdrawn
 *
 * Если outflow > inflow с tolerance ±2% — emit warning. Severity:
 *   - 'error': ratio outflow/inflow ≥ 1.5× OR inflow == 0 with outflow > 0
 *   - 'warn':  всё что меньше
 *
 * Stable assets (USDT/USDC/DAI/...) исключаются — для них P2P fiat trail
 * через CexCostBasisService покрывает (или ничего не покрывает, но gap
 * не indicates anomaly).
 *
 * Pure function: input/output только данные, no DB / no side effects.
 */

const TOLERANCE = 0.02; // ±2% acceptable drift (precision / fees)
const ERROR_RATIO_THRESHOLD = 1.5;

const STABLE_ASSETS = new Set([
  "USDT",
  "USDC",
  "DAI",
  "TUSD",
  "BUSD",
  "PYUSD",
  "USDS",
  "USDE",
  "FDUSD",
  "GHO",
]);

export type AssetGapKind = "outflow_exceeds_inflow" | "no_acquisitions_at_all";
export type AssetGapSeverity = "warn" | "error";

export interface AssetFlow {
  readonly asset: string;
  /** Bought через CEX trades (base unit amount). */
  readonly bought: number;
  /** Sold через CEX trades. */
  readonly sold: number;
  /** Deposited (from on-chain) — base units. */
  readonly deposited: number;
  /** Withdrawn (to on-chain). */
  readonly withdrawn: number;
}

export interface AssetGap {
  readonly asset: string;
  readonly kind: AssetGapKind;
  readonly severity: AssetGapSeverity;
  /** outflow / inflow ratio (Infinity если inflow=0). */
  readonly ratio: number;
  /** outflow - inflow (positive = gap). */
  readonly missing: number;
  readonly inflow: number;
  readonly outflow: number;
}

export function detectCexAssetGaps(
  flows: ReadonlyArray<AssetFlow>,
): AssetGap[] {
  const gaps: AssetGap[] = [];

  for (const f of flows) {
    const asset = f.asset.toUpperCase();
    if (STABLE_ASSETS.has(asset)) continue;

    const inflow = f.bought + f.deposited;
    const outflow = f.sold + f.withdrawn;

    // Нет активности с этим asset — skip.
    if (outflow <= 0) continue;

    // Outflow ≤ inflow с tolerance — OK.
    if (inflow > 0 && outflow <= inflow * (1 + TOLERANCE)) continue;

    const ratio = inflow > 0 ? outflow / inflow : Number.POSITIVE_INFINITY;
    const missing = outflow - inflow;

    let kind: AssetGapKind;
    let severity: AssetGapSeverity;
    if (inflow === 0) {
      kind = "no_acquisitions_at_all";
      severity = "error";
    } else {
      kind = "outflow_exceeds_inflow";
      severity = ratio >= ERROR_RATIO_THRESHOLD ? "error" : "warn";
    }

    gaps.push({
      asset,
      kind,
      severity,
      ratio,
      missing,
      inflow,
      outflow,
    });
  }

  // Sort: errors first (severity desc), then by missing amount desc.
  return gaps.sort((a, b) => {
    if (a.severity !== b.severity) {
      return a.severity === "error" ? -1 : 1;
    }
    return b.missing - a.missing;
  });
}
