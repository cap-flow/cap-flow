/**
 * Epic C — post-port checks (golden_case_drift + canonical invariants).
 */
import { describe, expect, it } from "vitest";

import {
  checkCanonicalInvariants,
  checkGoldenCaseDrift,
  runPostPortChecks,
  type CanonicalPosition,
  type GoldenCaseView,
} from "./post_port_checks.js";

const pos = (p: Partial<CanonicalPosition>): CanonicalPosition => ({
  id: "POS-1",
  walletId: "w1",
  chain: "op",
  protocol: { id: "op_velodrome" },
  lpTokenId: "0xgauge",
  matchedV3TokenId: null,
  openHash: null,
  startUsd: 0,
  currentUsd: 0,
  netPnlUsd: 0,
  coverageIncomplete: false,
  ...p,
});

const golden = (g: Partial<GoldenCaseView>): GoldenCaseView => ({
  id: "g1",
  walletId: "w1",
  chain: "op",
  protocolId: "op_velodrome",
  marketKey: "0xgauge",
  openHash: null,
  label: "POS-011",
  kind: "golden",
  status: "active",
  expectedStartUsd: 237.8,
  toleranceAbsUsd: 1,
  tolerancePct: 0.02,
  ...g,
});

describe("checkGoldenCaseDrift", () => {
  it("POS-011: golden $237.80 vs canonical $20.40 → error w/ goldenCaseId + drift", () => {
    const out = checkGoldenCaseDrift([golden({})], [pos({ startUsd: 20.4, currentUsd: 112 })]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      checkId: "golden_case_drift",
      severity: "error",
      goldenCaseId: "g1",
      positionId: "POS-1",
      observedValue: 20.4,
      expectedValue: 237.8,
    });
    expect((out[0]!.detail as { driftPct: number }).driftPct).toBeCloseTo(-91.4, 0);
  });

  it("within tolerance → no finding", () => {
    const out = checkGoldenCaseDrift([golden({})], [pos({ startUsd: 237.5, currentUsd: 112 })]);
    expect(out).toEqual([]);
  });

  it("no matching canonical → golden_case_unmatched (warn)", () => {
    const out = checkGoldenCaseDrift([golden({})], [pos({ lpTokenId: "0xother" })]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ checkId: "golden_case_unmatched", severity: "warn", goldenCaseId: "g1" });
  });

  it("matches per-wallet (shared marketKey across wallets)", () => {
    const g = golden({ walletId: "w2", expectedStartUsd: 300 });
    const positions = [
      pos({ walletId: "w1", startUsd: 200 }),
      pos({ walletId: "w2", startUsd: 300 }),
    ];
    expect(checkGoldenCaseDrift([g], positions)).toEqual([]); // w2 matched, in tol
  });

  it("V3 NFT match via matchedV3TokenId", () => {
    const g = golden({ marketKey: "5417064", protocolId: "arb_uniswap3", chain: "arb", expectedStartUsd: 241.07 });
    const p = pos({ chain: "arb", protocol: { id: "arb_uniswap3" }, lpTokenId: "0xnpm", matchedV3TokenId: "5417064", startUsd: 241.07 });
    expect(checkGoldenCaseDrift([g], [p])).toEqual([]);
  });

  it("skips retired / 'wrong' / flag-only goldens", () => {
    expect(checkGoldenCaseDrift([golden({ status: "retired" })], [pos({ startUsd: 0 })])).toEqual([]);
    expect(checkGoldenCaseDrift([golden({ kind: "wrong" })], [pos({ startUsd: 0 })])).toEqual([]);
    expect(checkGoldenCaseDrift([golden({ expectedStartUsd: null })], [pos({ startUsd: 0 })])).toEqual([]);
  });
});

describe("checkCanonicalInvariants", () => {
  it("lp_uncovered_nearzero: startUsd ~0 + real currentUsd + not flagged → error", () => {
    const out = checkCanonicalInvariants([pos({ startUsd: 0.5, currentUsd: 112 })]);
    expect(out.map((f) => f.checkId)).toContain("lp_uncovered_nearzero");
  });

  it("coverageIncomplete suppresses lp_uncovered_nearzero (honest flag)", () => {
    const out = checkCanonicalInvariants([pos({ startUsd: 0.5, currentUsd: 112, coverageIncomplete: true })]);
    expect(out.map((f) => f.checkId)).not.toContain("lp_uncovered_nearzero");
  });

  it("pnl_impossible_negative: lost more than cost basis → error", () => {
    const out = checkCanonicalInvariants([pos({ startUsd: 100, currentUsd: 0, netPnlUsd: -150 })]);
    expect(out.map((f) => f.checkId)).toContain("pnl_impossible_negative");
  });

  it("normal position → no invariant findings", () => {
    expect(checkCanonicalInvariants([pos({ startUsd: 100, currentUsd: 90, netPnlUsd: -10 })])).toEqual([]);
  });
});

describe("runPostPortChecks", () => {
  it("combines golden drift + invariants", () => {
    const out = runPostPortChecks(
      [pos({ startUsd: 0.5, currentUsd: 112 })],
      [golden({})],
    );
    const ids = out.map((f) => f.checkId);
    expect(ids).toContain("golden_case_drift");
    expect(ids).toContain("lp_uncovered_nearzero");
  });
});
