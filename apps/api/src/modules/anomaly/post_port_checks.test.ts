/**
 * Epic C — post-port checks (golden_case_drift + canonical invariants).
 */
import { describe, expect, it } from "vitest";

import {
  checkCanonicalInvariants,
  checkClientServerDivergence,
  checkCostBasisFromSpot,
  checkFeeAprWithoutFee,
  checkGoldenCaseDrift,
  checkStableAvgpriceOff,
  runPostPortChecks,
  type CanonicalPosition,
  type GoldenCaseView,
} from "./post_port_checks.js";
import type {
  ShadowDiffSummary,
  ShadowPositionDelta,
} from "../ucb/shadow-diff.js";

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

describe("checkFeeAprWithoutFee", () => {
  it("feeApr > 0 + fee ≈ $0 → error (POS-004/005)", () => {
    const out = checkFeeAprWithoutFee([pos({ feeAprLifetime: 0.42, feesLifetimeUsd: 0 })]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      checkId: "fee_apr_without_fee",
      anomalyType: "lp_data",
      severity: "error",
      observedValue: 0.42,
      expectedValue: 0,
      positionId: "POS-1",
    });
  });

  it("feeApr > 0 с реальными fee → тихо", () => {
    expect(checkFeeAprWithoutFee([pos({ feeAprLifetime: 0.42, feesLifetimeUsd: 12.5 })])).toEqual([]);
  });

  it("feeApr null → тихо", () => {
    expect(checkFeeAprWithoutFee([pos({ feeAprLifetime: null, feesLifetimeUsd: 0 })])).toEqual([]);
  });

  it("feeApr флоат-пыль (~1e-13) → тихо (регресс-гард Alice POS-002)", () => {
    expect(
      checkFeeAprWithoutFee([pos({ feeAprLifetime: 8.7e-13, feesLifetimeUsd: 4.2e-13 })]),
    ).toEqual([]);
  });
});

describe("checkStableAvgpriceOff", () => {
  it("стейбл с avgBuyPrice ≠ $1 → info, один finding с tokens", () => {
    const out = checkStableAvgpriceOff([
      pos({
        supplyTokens: [
          { symbol: "EURC", isStable: true, avgBuyPrice: 1.12, startUsd: 100 },
          { symbol: "USDC", isStable: true, avgBuyPrice: 1.0, startUsd: 100 },
        ],
      }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      checkId: "stable_avgprice_off",
      anomalyType: "pricing",
      severity: "info",
      observedValue: 1.12,
      expectedValue: 1,
    });
    expect((out[0]!.detail as { tokens: unknown[] }).tokens).toEqual([
      { symbol: "EURC", avgBuyPrice: 1.12 },
    ]);
  });

  it("стейбл в пределах допуска / не-стейбл → тихо", () => {
    expect(
      checkStableAvgpriceOff([
        pos({
          supplyTokens: [
            { symbol: "USDC", isStable: true, avgBuyPrice: 1.02, startUsd: 100 },
            { symbol: "WETH", isStable: false, avgBuyPrice: 3000, startUsd: 100 },
          ],
        }),
      ]),
    ).toEqual([]);
  });
});

describe("checkCostBasisFromSpot", () => {
  it("priceSource=fallback, startUsd > $100 → warn", () => {
    const out = checkCostBasisFromSpot([
      pos({
        startUsd: 5000,
        supplyTokens: [{ symbol: "WETH", isStable: false, avgBuyPrice: null, startUsd: 150, priceSource: "fallback" }],
      }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      checkId: "cost_basis_from_spot",
      anomalyType: "cost_basis",
      severity: "warn",
      observedValue: 150,
      expectedValue: 0,
    });
  });

  it("priceSource=fallback > 50% от startUsd (но < $100) → warn", () => {
    const out = checkCostBasisFromSpot([
      pos({
        startUsd: 80,
        supplyTokens: [{ symbol: "WETH", isStable: false, avgBuyPrice: null, startUsd: 50, priceSource: "fallback" }],
      }),
    ]);
    expect(out.map((f) => f.checkId)).toContain("cost_basis_from_spot");
  });

  it("priceSource=fallback мелкий, ниже обоих порогов → тихо", () => {
    expect(
      checkCostBasisFromSpot([
        pos({
          startUsd: 5000,
          supplyTokens: [{ symbol: "WETH", isStable: false, avgBuyPrice: null, startUsd: 10, priceSource: "fallback" }],
        }),
      ]),
    ).toEqual([]);
  });

  it("priceSource=cost_basis с большим fallbackUsd → ТИХО (регресс-гард Alice: M6 priced-not-trusted ≠ silent-spot)", () => {
    expect(
      checkCostBasisFromSpot([
        pos({
          startUsd: 166,
          supplyTokens: [{ symbol: "PAXG", isStable: false, avgBuyPrice: null, startUsd: 166, fallbackUsd: 674, priceSource: "cost_basis" }],
        }),
      ]),
    ).toEqual([]);
  });

  it("нет fallback-токенов → тихо", () => {
    expect(
      checkCostBasisFromSpot([
        pos({ startUsd: 5000, supplyTokens: [{ symbol: "WETH", isStable: false, avgBuyPrice: null, startUsd: 100, priceSource: "cost_basis" }] }),
      ]),
    ).toEqual([]);
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

describe("checkClientServerDivergence (client↔server cost basis)", () => {
  const delta = (d: Partial<ShadowPositionDelta>): ShadowPositionDelta => ({
    key: "arb|arb_morphoblue|0x6c247b|", // chain|proto|lp|v3|sym (sym пуст)
    presence: "both",
    clientStartUsd: null,
    serverStartUsd: null,
    deltaStartUsd: null,
    clientNetStartUsd: null,
    serverNetStartUsd: null,
    deltaNetStartUsd: null,
    coverageMismatch: false,
    openedAtMismatch: false,
    reasons: [],
    divergent: false,
    ...d,
  });
  const summary = (deltas: ShadowPositionDelta[]): ShadowDiffSummary => ({
    divergentCount: deltas.filter((d) => d.divergent).length,
    matchedCount: deltas.filter((d) => d.presence === "both").length,
    clientOnlyCount: 0,
    serverOnlyCount: 0,
    materialDivergenceCount: deltas.filter((d) => d.divergent).length,
    thresholdUsd: 1,
    deltas,
  });

  it("POS-011 класс: client < server на $6,379 → error", () => {
    const out = checkClientServerDivergence(
      summary([
        delta({
          clientStartUsd: 15209.39,
          serverStartUsd: 21588.55,
          deltaStartUsd: 15209.39 - 21588.55,
          reasons: ["startUsd"],
          divergent: true,
        }),
      ]),
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.checkId).toBe("client_server_cost_basis_divergence");
    expect(out[0]!.severity).toBe("error");
    expect(out[0]!.observedValue).toBeCloseTo(15209.39, 2);
    expect(out[0]!.expectedValue).toBeCloseTo(21588.55, 2);
    expect(out[0]!.chain).toBe("arb");
    expect(out[0]!.protocolId).toBe("arb_morphoblue");
  });

  it("малое расхождение (<$50 и <5%) → warn", () => {
    const out = checkClientServerDivergence(
      summary([
        delta({
          clientStartUsd: 1000,
          serverStartUsd: 1010,
          deltaStartUsd: -10, // $10 = 0.99% от $1010 → warn
          reasons: ["startUsd"],
          divergent: true,
        }),
      ]),
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.severity).toBe("warn");
  });

  it("net-плечо: large deltaNet → error даже при малом gross", () => {
    const out = checkClientServerDivergence(
      summary([
        delta({
          clientStartUsd: 1000,
          serverStartUsd: 1000,
          deltaStartUsd: 0,
          clientNetStartUsd: 200,
          serverNetStartUsd: 800,
          deltaNetStartUsd: -600,
          reasons: ["netStartUsd"],
          divergent: true,
        }),
      ]),
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.severity).toBe("error");
  });

  it("parity (0 divergent) → 0 findings (после фикса diff молчит)", () => {
    expect(
      checkClientServerDivergence(
        summary([
          delta({
            clientStartUsd: 21588.55,
            serverStartUsd: 21588.55,
            deltaStartUsd: 0,
            divergent: false,
          }),
        ]),
      ),
    ).toHaveLength(0);
  });

  it("presence-mismatch (client_only) НЕ flag'ается этим чеком", () => {
    expect(
      checkClientServerDivergence(
        summary([
          delta({
            presence: "client_only",
            clientStartUsd: 500,
            reasons: ["presence:client_only"],
            divergent: false,
          }),
        ]),
      ),
    ).toHaveLength(0);
  });

  it("null/пустой summary → 0 findings (нет shadow-diff)", () => {
    expect(checkClientServerDivergence(null)).toHaveLength(0);
    expect(checkClientServerDivergence(undefined)).toHaveLength(0);
    expect(checkClientServerDivergence(summary([]))).toHaveLength(0);
  });
});
