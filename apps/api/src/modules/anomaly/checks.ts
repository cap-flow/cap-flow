/**
 * Epic C — anomaly detector, Stage C1: pure metrics-only check catalog.
 *
 * These are PURE functions (no DB, no I/O) over the account-level snapshot
 * metrics already persisted in `portfolio_snapshots.metrics` (built by
 * `portfolio-refresh.service.ts`). The detector service (C2) reads the latest
 * snapshot per account and runs `runMetricsChecks` to produce `AnomalyFinding[]`,
 * which C3 upserts into `anomaly_flags`.
 *
 * Tunable thresholds live at the top so signal/noise can be tuned (C6) before
 * any UI. Each check returns a finding only when it trips — a quiet snapshot
 * yields `[]`.
 *
 * Severity ladder mirrors the schema (`info|warn|error`). These are PRE-port
 * checks (phase `pre`): they read existing snapshot metrics and need neither the
 * shared engine nor `ucb_shadow_results` (those gate the POST-port checks C7–C8).
 *
 * NOTE on the three states (Q3): a tripped check is an *anomaly* (human reviews),
 * NEVER an assertion that a position is "broken". The golden-confirmed vs
 * unverified distinction is applied downstream (golden cross-reference, C8) — a
 * pure check here only computes "this metric looks off", not "this is wrong".
 */

export type Severity = "info" | "warn" | "error";
export type CheckPhase = "pre" | "post";

/** A single detector finding, shaped for the `anomaly_flags` write path (C3). */
export interface AnomalyFinding {
  /** Stable id of the rule that tripped (idempotency key component). */
  readonly checkId: string;
  /** Coarse family for grouping in the report (C6). */
  readonly anomalyType: string;
  readonly severity: Severity;
  readonly phase: CheckPhase;
  /** The metric value that tripped the rule (for the flag row + report). */
  readonly observedValue: number | null;
  /** The boundary it violated, when meaningful (else null). */
  readonly expectedValue: number | null;
  /** Structured context (raw inputs, human-readable reason). */
  readonly detail: Record<string, unknown>;
}

/**
 * Minimal read-model of `portfolio_snapshots.metrics` that the C1 checks consume.
 * Field names + nullability mirror `portfolio-refresh.service.ts` exactly:
 *   - `pnlOwnPct` is null when `startUsdEffective <= 0` (can't divide).
 *   - `costBasisError` is present only when cost-basis assembly threw.
 *   - `errors` is the (truncated) refresh error list.
 * The C2 service maps a snapshot's `metrics` jsonb onto this view.
 */
export interface SnapshotMetricsView {
  readonly startUsdEffective: number;
  readonly ownCapitalUsd: number;
  readonly totalUsd: number;
  readonly pnlOwnUsd: number;
  readonly pnlOwnPct: number | null;
  readonly costBasisError?: string | null;
  readonly errors?: readonly string[];
  readonly operationsCount?: number;
}

/** Tunable thresholds — adjust against signal/noise in C6 before any UI. */
export const THRESHOLDS = {
  /** start ~$0 is only suspicious when real own-capital is meaningfully large. */
  startZeroFloorUsd: 1,
  startZeroOwnCapitalFloorUsd: 500,
  /** PnL% bands: below = lost more than invested; above = implausible gain. */
  pnlPctLossErrorBelow: -100,
  pnlPctGainWarnAbove: 1000,
  /** Slack on the "lost more than you could" check (leverage adds real noise). */
  pnlImpossibleNegSlackPct: 0.01,
} as const;

/**
 * C1.1 `start_zero_nonzero_value` — cost basis collapsed to ~$0 while the
 * account clearly holds real value. The canonical near-zero symptom (e.g. the
 * POS-011 gauge-CL `$0`/`$20` fakes): a position worth real money showing no
 * traced cost basis. Error.
 */
export function checkStartZeroNonzeroValue(
  m: SnapshotMetricsView,
): AnomalyFinding | null {
  if (
    m.startUsdEffective < THRESHOLDS.startZeroFloorUsd &&
    m.ownCapitalUsd > THRESHOLDS.startZeroOwnCapitalFloorUsd
  ) {
    return {
      checkId: "start_zero_nonzero_value",
      anomalyType: "cost_basis",
      severity: "error",
      phase: "pre",
      observedValue: m.startUsdEffective,
      expectedValue: THRESHOLDS.startZeroFloorUsd,
      detail: {
        reason:
          "startUsdEffective ~$0 but ownCapitalUsd is large — cost basis likely missing/zeroed",
        ownCapitalUsd: m.ownCapitalUsd,
        startUsdEffective: m.startUsdEffective,
      },
    };
  }
  return null;
}

/**
 * C1.2 `pnl_pct_out_of_band` — PnL% outside a believable band.
 *   < −100% → error (lost more than invested → likely bad cost basis/leverage).
 *   > +1000% → warn (implausible gain → likely understated cost basis).
 * Skipped when `pnlOwnPct` is null (no cost basis to divide by).
 */
export function checkPnlPctOutOfBand(
  m: SnapshotMetricsView,
): AnomalyFinding | null {
  if (m.pnlOwnPct == null) return null;
  if (m.pnlOwnPct < THRESHOLDS.pnlPctLossErrorBelow) {
    return {
      checkId: "pnl_pct_out_of_band",
      anomalyType: "pnl",
      severity: "error",
      phase: "pre",
      observedValue: m.pnlOwnPct,
      expectedValue: THRESHOLDS.pnlPctLossErrorBelow,
      detail: {
        reason: "pnlOwnPct below −100% — lost more than invested",
        pnlOwnPct: m.pnlOwnPct,
        pnlOwnUsd: m.pnlOwnUsd,
        startUsdEffective: m.startUsdEffective,
      },
    };
  }
  if (m.pnlOwnPct > THRESHOLDS.pnlPctGainWarnAbove) {
    return {
      checkId: "pnl_pct_out_of_band",
      anomalyType: "pnl",
      severity: "warn",
      phase: "pre",
      observedValue: m.pnlOwnPct,
      expectedValue: THRESHOLDS.pnlPctGainWarnAbove,
      detail: {
        reason: "pnlOwnPct above +1000% — implausible gain, cost basis likely understated",
        pnlOwnPct: m.pnlOwnPct,
        pnlOwnUsd: m.pnlOwnUsd,
        startUsdEffective: m.startUsdEffective,
      },
    };
  }
  return null;
}

/**
 * C1.3 `pnl_impossible_negative` — own-capital PnL is more negative than the
 * total invested (beyond a small slack). Without leverage you cannot lose more
 * than you put in; a violation flags a cost-basis/debt accounting error. Error.
 * (Leverage can make this legitimately true → slack + downstream human review.)
 */
export function checkPnlImpossibleNegative(
  m: SnapshotMetricsView,
): AnomalyFinding | null {
  if (m.startUsdEffective <= 0) return null;
  const floor = -m.startUsdEffective * (1 + THRESHOLDS.pnlImpossibleNegSlackPct);
  if (m.pnlOwnUsd < floor) {
    return {
      checkId: "pnl_impossible_negative",
      anomalyType: "pnl",
      severity: "error",
      phase: "pre",
      observedValue: m.pnlOwnUsd,
      expectedValue: floor,
      detail: {
        reason:
          "pnlOwnUsd more negative than total invested (−startUsdEffective) beyond slack",
        pnlOwnUsd: m.pnlOwnUsd,
        startUsdEffective: m.startUsdEffective,
        slackPct: THRESHOLDS.pnlImpossibleNegSlackPct,
      },
    };
  }
  return null;
}

/**
 * C1.4 `cost_basis_error_present` — the refresh swallowed a cost-basis assembly
 * error into `metrics.costBasisError` (so a malformed row couldn't crash the
 * snapshot). Surface it. Warn.
 */
export function checkCostBasisErrorPresent(
  m: SnapshotMetricsView,
): AnomalyFinding | null {
  if (m.costBasisError != null && m.costBasisError !== "") {
    return {
      checkId: "cost_basis_error_present",
      anomalyType: "cost_basis",
      severity: "warn",
      phase: "pre",
      observedValue: null,
      expectedValue: null,
      detail: {
        reason: "metrics.costBasisError is set — cost basis assembly failed",
        costBasisError: m.costBasisError,
      },
    };
  }
  return null;
}

/** All C1 metrics-only checks, in catalog order. */
export const METRICS_CHECKS: ReadonlyArray<
  (m: SnapshotMetricsView) => AnomalyFinding | null
> = [
  checkStartZeroNonzeroValue,
  checkPnlPctOutOfBand,
  checkPnlImpossibleNegative,
  checkCostBasisErrorPresent,
];

/** Run every C1 check over one account's latest snapshot metrics. */
export function runMetricsChecks(m: SnapshotMetricsView): AnomalyFinding[] {
  const out: AnomalyFinding[] = [];
  for (const check of METRICS_CHECKS) {
    const finding = check(m);
    if (finding) out.push(finding);
  }
  return out;
}
