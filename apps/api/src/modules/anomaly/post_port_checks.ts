/**
 * Epic C post-port checks (phase "post") — run over the SERVER's canonical
 * positions (`ucb_shadow_results`, now that B5/B3-full/B4 land) instead of the
 * legacy snapshot metrics. The strongest signal is `golden_case_drift`: every
 * golden_cases oracle is automatically re-verified against the live server
 * compute, turning the curated anchors into a continuous regression gate.
 *
 * Pure functions over already-loaded rows (no DB/IO) — the detector service
 * loads canonical positions + golden cases and feeds them here.
 */
import type { AnomalyFinding } from "./checks.js";

/** Minimal canonical-position view (subset of OpenPosition from ucb_shadow_results). */
export interface CanonicalPosition {
  id: string;
  walletId: string;
  chain: string;
  protocol: { id: string };
  lpTokenId?: string | null;
  matchedV3TokenId?: string | null;
  openHash?: string | null;
  startUsd: number;
  currentUsd: number;
  netPnlUsd: number;
  coverageIncomplete?: boolean;
}

/** Minimal golden-case view (numbers already parsed from numeric). */
export interface GoldenCaseView {
  id: string;
  walletId: string;
  chain: string;
  protocolId: string;
  marketKey: string | null;
  openHash: string | null;
  label: string;
  /** 'golden' = expected is the correct value; 'wrong' = owner-flagged bad. */
  kind: string;
  status: string;
  expectedStartUsd: number | null;
  toleranceAbsUsd: number;
  tolerancePct: number;
}

export const POST_PORT_THRESHOLDS = {
  /** lp_uncovered_nearzero: startUsd ~0 but the position holds real value. */
  nearZeroStartUsd: 1,
  nearZeroCurrentUsdFloor: 100,
  /** pnl_impossible_negative slack (leverage adds real noise). */
  pnlImpossibleNegSlackPct: 0.01,
} as const;

function eqKey(a: string | null | undefined, b: string | null | undefined): boolean {
  if (a == null || b == null) return false;
  return a.toLowerCase() === b.toLowerCase();
}

/** Match a golden case to its canonical position (per-wallet; mirrors verify scripts). */
export function matchCanonical(
  g: GoldenCaseView,
  positions: readonly CanonicalPosition[],
): CanonicalPosition | undefined {
  return positions.find((p) => {
    if (p.walletId !== g.walletId) return false;
    if (p.chain !== g.chain || p.protocol.id !== g.protocolId) return false;
    if (g.marketKey) {
      return (
        eqKey(p.matchedV3TokenId, g.marketKey) || eqKey(p.lpTokenId, g.marketKey)
      );
    }
    if (g.openHash) return eqKey(p.openHash, g.openHash);
    return true; // chain+protocol only (rare; e.g. single-position protocol)
  });
}

function withinTolerance(
  computed: number,
  expected: number,
  absTol: number,
  pctTol: number,
): boolean {
  const diff = Math.abs(computed - expected);
  const tol = Math.max(absTol, Math.abs(expected) * pctTol);
  return diff <= tol;
}

/**
 * `golden_case_drift` (error) — for each active golden ('golden') case, the
 * matching canonical startUsd must be within tolerance of the expected value.
 * Beyond → error carrying goldenCaseId + driftPct. No matching position →
 * `golden_case_unmatched` (warn): the server compute didn't produce it at all.
 */
export function checkGoldenCaseDrift(
  goldenCases: readonly GoldenCaseView[],
  positions: readonly CanonicalPosition[],
): AnomalyFinding[] {
  const out: AnomalyFinding[] = [];
  for (const g of goldenCases) {
    if (g.status !== "active") continue;
    if (g.kind !== "golden") continue; // 'wrong' handled by a separate signal
    if (g.expectedStartUsd == null) continue; // flag-only golden, nothing to drift
    const p = matchCanonical(g, positions);
    if (!p) {
      out.push({
        checkId: "golden_case_unmatched",
        anomalyType: "golden",
        severity: "warn",
        phase: "post",
        observedValue: null,
        expectedValue: g.expectedStartUsd,
        goldenCaseId: g.id,
        walletId: g.walletId,
        chain: g.chain,
        protocolId: g.protocolId,
        marketKey: g.marketKey,
        detail: {
          reason: `golden ${g.label} has no matching canonical position (server compute missing it)`,
          label: g.label,
        },
      });
      continue;
    }
    if (withinTolerance(p.startUsd, g.expectedStartUsd, g.toleranceAbsUsd, g.tolerancePct)) {
      continue;
    }
    const driftAbs = p.startUsd - g.expectedStartUsd;
    const driftPct = g.expectedStartUsd !== 0 ? (driftAbs / Math.abs(g.expectedStartUsd)) * 100 : null;
    out.push({
      checkId: "golden_case_drift",
      anomalyType: "golden",
      severity: "error",
      phase: "post",
      observedValue: p.startUsd,
      expectedValue: g.expectedStartUsd,
      goldenCaseId: g.id,
      positionId: p.id,
      walletId: g.walletId,
      chain: g.chain,
      protocolId: g.protocolId,
      marketKey: g.marketKey,
      detail: {
        reason: `canonical startUsd $${p.startUsd.toFixed(2)} drifts from golden ${g.label} $${g.expectedStartUsd.toFixed(2)}`,
        label: g.label,
        driftAbs,
        driftPct,
        toleranceAbsUsd: g.toleranceAbsUsd,
        tolerancePct: g.tolerancePct,
      },
    });
  }
  return out;
}

/**
 * Canonical-position invariants (no golden needed):
 *   - `lp_uncovered_nearzero` (error): startUsd ~$0 but currentUsd is real money
 *     AND not honestly flagged coverageIncomplete (the POS-011 plausible-fake).
 *   - `pnl_impossible_negative` (error): lost more than the collateral cost basis.
 */
export function checkCanonicalInvariants(
  positions: readonly CanonicalPosition[],
): AnomalyFinding[] {
  const out: AnomalyFinding[] = [];
  for (const p of positions) {
    if (
      p.startUsd < POST_PORT_THRESHOLDS.nearZeroStartUsd &&
      p.currentUsd > POST_PORT_THRESHOLDS.nearZeroCurrentUsdFloor &&
      !p.coverageIncomplete
    ) {
      out.push({
        checkId: "lp_uncovered_nearzero",
        anomalyType: "cost_basis",
        severity: "error",
        phase: "post",
        observedValue: p.startUsd,
        expectedValue: null,
        positionId: p.id,
        walletId: p.walletId,
        chain: p.chain,
        protocolId: p.protocol.id,
        marketKey: p.lpTokenId ?? p.matchedV3TokenId ?? null,
        detail: {
          reason: `startUsd ~$0 but currentUsd $${p.currentUsd.toFixed(2)} — cost basis missing (not flagged coverageIncomplete)`,
          currentUsd: p.currentUsd,
        },
      });
    }
    if (
      p.startUsd > 0 &&
      p.netPnlUsd < -p.startUsd * (1 + POST_PORT_THRESHOLDS.pnlImpossibleNegSlackPct)
    ) {
      out.push({
        checkId: "pnl_impossible_negative",
        anomalyType: "pnl",
        severity: "error",
        phase: "post",
        observedValue: p.netPnlUsd,
        expectedValue: -p.startUsd,
        positionId: p.id,
        walletId: p.walletId,
        chain: p.chain,
        protocolId: p.protocol.id,
        marketKey: p.lpTokenId ?? p.matchedV3TokenId ?? null,
        detail: {
          reason: `netPnlUsd $${p.netPnlUsd.toFixed(2)} is more negative than the cost basis −$${p.startUsd.toFixed(2)}`,
          startUsd: p.startUsd,
        },
      });
    }
  }
  return out;
}

/** All post-port checks over canonical positions + golden cases. */
export function runPostPortChecks(
  positions: readonly CanonicalPosition[],
  goldenCases: readonly GoldenCaseView[],
): AnomalyFinding[] {
  return [
    ...checkGoldenCaseDrift(goldenCases, positions),
    ...checkCanonicalInvariants(positions),
  ];
}
