/**
 * Epic C / C1 — pure metrics-check catalog tests (offline, no DB).
 * Hand-built `SnapshotMetricsView` fixtures exercise each rule's trip and
 * no-trip boundaries.
 */
import { describe, it, expect } from "vitest";

import {
  runMetricsChecks,
  checkStartZeroNonzeroValue,
  checkPnlPctOutOfBand,
  checkPnlImpossibleNegative,
  checkCostBasisErrorPresent,
  THRESHOLDS,
  type SnapshotMetricsView,
} from "./checks.js";

/** A healthy baseline that trips nothing; override per test. */
function healthy(over: Partial<SnapshotMetricsView> = {}): SnapshotMetricsView {
  return {
    startUsdEffective: 1000,
    ownCapitalUsd: 1100,
    totalUsd: 1100,
    pnlOwnUsd: 100,
    pnlOwnPct: 10,
    ...over,
  };
}

describe("C1 start_zero_nonzero_value", () => {
  it("trips (error) when start ~$0 but own capital large", () => {
    const f = checkStartZeroNonzeroValue(
      healthy({ startUsdEffective: 0, ownCapitalUsd: 5000, pnlOwnPct: null }),
    );
    expect(f?.checkId).toBe("start_zero_nonzero_value");
    expect(f?.severity).toBe("error");
    expect(f?.observedValue).toBe(0);
  });

  it("does NOT trip when own capital below floor (small dust position)", () => {
    expect(
      checkStartZeroNonzeroValue(
        healthy({ startUsdEffective: 0, ownCapitalUsd: 400, pnlOwnPct: null }),
      ),
    ).toBeNull();
  });

  it("does NOT trip when start basis is present", () => {
    expect(
      checkStartZeroNonzeroValue(healthy({ startUsdEffective: 900, ownCapitalUsd: 5000 })),
    ).toBeNull();
  });
});

describe("C1 pnl_pct_out_of_band", () => {
  it("error below −100%", () => {
    const f = checkPnlPctOutOfBand(healthy({ pnlOwnPct: -150 }));
    expect(f?.severity).toBe("error");
    expect(f?.expectedValue).toBe(THRESHOLDS.pnlPctLossErrorBelow);
  });

  it("warn above +1000%", () => {
    const f = checkPnlPctOutOfBand(healthy({ pnlOwnPct: 1500 }));
    expect(f?.severity).toBe("warn");
  });

  it("does NOT trip inside the band", () => {
    expect(checkPnlPctOutOfBand(healthy({ pnlOwnPct: 250 }))).toBeNull();
    expect(checkPnlPctOutOfBand(healthy({ pnlOwnPct: -90 }))).toBeNull();
  });

  it("skips when pnlOwnPct is null (no cost basis)", () => {
    expect(checkPnlPctOutOfBand(healthy({ pnlOwnPct: null }))).toBeNull();
  });
});

describe("C1 pnl_impossible_negative", () => {
  it("trips when loss exceeds invested beyond slack", () => {
    // start 1000, slack 1% → floor −1010; loss −1200 trips
    const f = checkPnlImpossibleNegative(
      healthy({ startUsdEffective: 1000, pnlOwnUsd: -1200, ownCapitalUsd: -200, pnlOwnPct: -120 }),
    );
    expect(f?.severity).toBe("error");
    expect(f?.checkId).toBe("pnl_impossible_negative");
  });

  it("does NOT trip a total loss within slack (−1000 vs floor −1010)", () => {
    expect(
      checkPnlImpossibleNegative(
        healthy({ startUsdEffective: 1000, pnlOwnUsd: -1000, ownCapitalUsd: 0, pnlOwnPct: -100 }),
      ),
    ).toBeNull();
  });

  it("skips when no cost basis (startUsdEffective <= 0)", () => {
    expect(
      checkPnlImpossibleNegative(healthy({ startUsdEffective: 0, pnlOwnUsd: -500 })),
    ).toBeNull();
  });
});

describe("C1 cost_basis_error_present", () => {
  it("warns when costBasisError set", () => {
    const f = checkCostBasisErrorPresent(healthy({ costBasisError: "boom" }));
    expect(f?.severity).toBe("warn");
    expect(f?.detail.costBasisError).toBe("boom");
  });

  it("does NOT trip when absent or empty", () => {
    expect(checkCostBasisErrorPresent(healthy())).toBeNull();
    expect(checkCostBasisErrorPresent(healthy({ costBasisError: "" }))).toBeNull();
    expect(checkCostBasisErrorPresent(healthy({ costBasisError: null }))).toBeNull();
  });
});

describe("C1 runMetricsChecks aggregator", () => {
  it("returns [] for a healthy snapshot", () => {
    expect(runMetricsChecks(healthy())).toEqual([]);
  });

  it("collects multiple findings at once", () => {
    const findings = runMetricsChecks(
      healthy({
        startUsdEffective: 0, // start_zero (needs ownCapital>500)
        ownCapitalUsd: 5000,
        pnlOwnPct: null, // pnl_pct skipped
        costBasisError: "x", // cost_basis_error
      }),
    );
    const ids = findings.map((f) => f.checkId).sort();
    expect(ids).toEqual(["cost_basis_error_present", "start_zero_nonzero_value"]);
  });

  it("every finding carries phase 'pre' and a non-empty detail", () => {
    const findings = runMetricsChecks(healthy({ pnlOwnPct: -200 }));
    expect(findings.length).toBeGreaterThan(0);
    for (const f of findings) {
      expect(f.phase).toBe("pre");
      expect(Object.keys(f.detail).length).toBeGreaterThan(0);
    }
  });
});
