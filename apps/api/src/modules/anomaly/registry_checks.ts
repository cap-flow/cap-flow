/**
 * Epic C — anomaly detector, registry-integrity checks (PRE-port, runnable now).
 *
 * Unlike the C1 metrics checks (which need server-side cost basis — absent until
 * the UCB port lands, see master-plan C1 finding), these read the raw operation
 * registry (`chain_operations`) and need NO cost basis. They deliver detector
 * value today.
 *
 * `duplicate_op_divergent_pricing` (C5b) — the CONFIRMED non-determinism bug:
 * `chain_operations.raw.movement[].usd` is priced at SYNC time, not fixed at the
 * block. The same on-chain event `(chain, tx_hash, log_index)` synced under two
 * wallets/accounts gets two different USD values → non-deterministic cost basis
 * (POS-005). Measured on testakk: 560/2260 tx shared, 156 diverge >1%, max 25.9%.
 * The fix is Epic B1 (op_token_prices: block-fixed price + registry dedup); this
 * check MONITORS for it (and regressions) and feeds the report (C6).
 */
import type { AnomalyFinding } from "./checks.js";

/**
 * One registry op row's representative USD magnitude. The reader computes
 * `usd = Σ|movement[].usd|` per `(walletId, chain, txHash, logIndex)` row; the
 * pure check only compares magnitudes across rows sharing the dedup key.
 */
export interface OpPriceRecord {
  readonly chain: string;
  readonly txHash: string;
  readonly logIndex: number;
  readonly walletId: string;
  readonly accountId: string;
  /** Σ|movement[].usd| for this row (sync-time priced). */
  readonly usd: number;
}

export interface DuplicatePricingOptions {
  /** Relative spread above which a group is WARN. Default 1%. */
  readonly warnPct?: number;
  /** Relative spread above which a group is ERROR. Default 5%. */
  readonly errorPct?: number;
  /** Ignore rows below this USD (dust noise). Default $1. */
  readonly minUsd?: number;
}

/** Shared thresholds — single source so the SQL-backed tech-audit checker and
 *  this pure function never drift. */
export const DUPLICATE_PRICING_DEFAULTS = {
  warnPct: 0.01,
  errorPct: 0.05,
  minUsd: 1,
} as const;
const DEFAULTS = DUPLICATE_PRICING_DEFAULTS;

function dedupKey(r: OpPriceRecord): string {
  return `${r.chain}|${r.txHash.toLowerCase()}|${r.logIndex}`;
}

/**
 * Find on-chain events whose USD value diverges across the wallet/account rows
 * that recorded the SAME `(chain, tx_hash, log_index)`. One finding per
 * divergent group; severity by relative spread `(max−min)/max`.
 *
 * Pure + deterministic: groups are emitted in ascending dedup-key order so the
 * output is stable across runs (R4-style determinism).
 */
export function findDivergentDuplicatePricing(
  records: readonly OpPriceRecord[],
  options: DuplicatePricingOptions = {},
): AnomalyFinding[] {
  const warnPct = options.warnPct ?? DEFAULTS.warnPct;
  const errorPct = options.errorPct ?? DEFAULTS.errorPct;
  const minUsd = options.minUsd ?? DEFAULTS.minUsd;

  const groups = new Map<string, OpPriceRecord[]>();
  for (const r of records) {
    if (!(r.usd > minUsd)) continue;
    const key = dedupKey(r);
    const arr = groups.get(key);
    if (arr) arr.push(r);
    else groups.set(key, [r]);
  }

  const findings: AnomalyFinding[] = [];
  for (const key of [...groups.keys()].sort()) {
    const rows = groups.get(key)!;
    // Need ≥2 DISTINCT-valued rows from ≥2 wallets to be a divergence.
    if (rows.length < 2) continue;
    const distinctWallets = new Set(rows.map((r) => r.walletId)).size;
    if (distinctWallets < 2) continue;

    let min = Infinity;
    let max = -Infinity;
    for (const r of rows) {
      if (r.usd < min) min = r.usd;
      if (r.usd > max) max = r.usd;
    }
    if (!(max > 0)) continue;
    const spread = (max - min) / max;
    if (spread <= warnPct) continue;

    const severity = spread > errorPct ? "error" : "warn";
    const accounts = [...new Set(rows.map((r) => r.accountId))];
    findings.push({
      checkId: "duplicate_op_divergent_pricing",
      anomalyType: "registry_integrity",
      severity,
      phase: "pre",
      observedValue: spread,
      expectedValue: warnPct,
      detail: {
        reason:
          "same on-chain event priced differently across wallet/account rows (sync-time movement.usd) — non-deterministic cost basis",
        dedupKey: key,
        chain: rows[0]!.chain,
        txHash: rows[0]!.txHash,
        logIndex: rows[0]!.logIndex,
        minUsd: min,
        maxUsd: max,
        spreadPct: spread * 100,
        rowCount: rows.length,
        distinctAccounts: accounts.length,
        crossAccount: accounts.length > 1,
        accountIds: accounts,
      },
    });
  }
  return findings;
}
