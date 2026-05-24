/**
 * PR-K2 tests: cross-validation Capflow OpenPosition vs Krystal V3 summary.
 *
 * Tolerance: 5% или $1 (whichever bigger). Catch'аем real bugs (POS-001
 * pending $13 vs $251, POS-007 claimed $758 vs $33), ignore'аем micro-diff
 * от oracle prices.
 */

import { describe, expect, it } from "vitest";

import { findKrystalDivergences } from "./validate";
import type { KrystalV3Summary } from "./adapter";
import type { OpenPosition } from "../portfolio/open_positions";

function pos(args: {
  id: string;
  matchedV3TokenId?: string;
  currentUsd: number;
  feesUsd: number;
  feesClaimedUsd: number;
}): OpenPosition {
  return {
    id: args.id,
    walletId: "lex-2",
    walletName: "lex 2",
    walletChain: "evm",
    chain: "arb",
    protocol: { id: "uniswap3", name: "Uniswap V3" },
    kind: "lp",
    itemName: "Liquidity Pool",
    openedAt: 1770000000,
    openHash: "0xabc",
    ageDays: 30,
    supplyTokens: [],
    debtTokens: [],
    openedInTokens: [],
    startUsd: 1000,
    netStartUsd: 1000,
    currentUsd: args.currentUsd,
    currentDebtUsd: 0,
    healthRate: null,
    feesUsd: args.feesUsd,
    feesSource: "v3_rewards",
    feesClaimedUsd: args.feesClaimedUsd,
    feesLifetimeUsd: args.feesUsd + args.feesClaimedUsd,
    feeApr: null,
    feeAprLifetime: null,
    feesClaimedHistory: [],
    feesByToken: [],
    creditFundedUsd: 0,
    coverageIncomplete: false,
    ...(args.matchedV3TokenId && { matchedV3TokenId: args.matchedV3TokenId }),
  };
}

function summary(args: {
  tokenId: string;
  currentUsd: number;
  pendingFeeUsd: number;
  claimedFeeUsd: number;
}): KrystalV3Summary {
  return {
    tokenId: args.tokenId,
    chainCode: "arb",
    protocolKey: "uniswapv3",
    pair: ["WETH", "USDC"],
    status: "IN_RANGE",
    currentUsd: args.currentUsd,
    currentTokens: [],
    pendingFeeUsd: args.pendingFeeUsd,
    pendingFeeTokens: [],
    claimedFeeUsd: args.claimedFeeUsd,
    claimedFeeTokens: [],
    providedTokens: [],
  };
}

describe("findKrystalDivergences", () => {
  it("POS-001-style: pending fees $13 vs Krystal $251 → critical divergence", () => {
    const capflow = [
      pos({
        id: "POS-001",
        matchedV3TokenId: "5469945",
        currentUsd: 14847,
        feesUsd: 13.84,
        feesClaimedUsd: 3.61,
      }),
    ];
    const krystal = new Map([["5469945", summary({
      tokenId: "5469945",
      currentUsd: 15109,
      pendingFeeUsd: 251.44,
      claimedFeeUsd: 0,
    })]]);
    const divergences = findKrystalDivergences(capflow, krystal);
    expect(divergences).toHaveLength(1);
    const d = divergences[0]!;
    expect(d.posId).toBe("POS-001");
    expect(d.fields).toContain("pendingFeeUsd");
    // currentUsd diff ($14847 vs $15109) = ~1.7% < 5% → NOT divergent
    expect(d.fields).not.toContain("currentUsd");
  });

  it("POS-007-style: claimed $758 vs Krystal $32.90 → claimed divergence (Bug #1 collect/decrease)", () => {
    const capflow = [
      pos({
        id: "POS-007",
        matchedV3TokenId: "1197028",
        currentUsd: 984,
        feesUsd: 9.13,
        feesClaimedUsd: 758.83,
      }),
    ];
    const krystal = new Map([["1197028", summary({
      tokenId: "1197028",
      currentUsd: 995,
      pendingFeeUsd: 9.15,
      claimedFeeUsd: 32.9,
    })]]);
    const divergences = findKrystalDivergences(capflow, krystal);
    expect(divergences).toHaveLength(1);
    expect(divergences[0]!.fields).toContain("feesClaimedUsd");
  });

  it("matching positions (within 5% / $1): no divergence", () => {
    const capflow = [
      pos({
        id: "POS-004",
        matchedV3TokenId: "4911255",
        currentUsd: 2041,
        feesUsd: 23.52,
        feesClaimedUsd: 55.29,
      }),
    ];
    const krystal = new Map([["4911255", summary({
      tokenId: "4911255",
      currentUsd: 2064.92,
      pendingFeeUsd: 23.57,
      claimedFeeUsd: 55.4,
    })]]);
    const divergences = findKrystalDivergences(capflow, krystal);
    expect(divergences).toHaveLength(0);
  });

  it("$1 absolute tolerance: tiny absolute diff не считается divergence", () => {
    const capflow = [
      pos({
        id: "POS-TINY",
        matchedV3TokenId: "tiny",
        currentUsd: 5,
        feesUsd: 0.5,
        feesClaimedUsd: 0,
      }),
    ];
    // $0.5 vs $1.4 — 180% diff, но absolute diff $0.9 < $1 → NOT flagged
    const krystal = new Map([["tiny", summary({
      tokenId: "tiny",
      currentUsd: 5,
      pendingFeeUsd: 1.4,
      claimedFeeUsd: 0,
    })]]);
    const divergences = findKrystalDivergences(capflow, krystal);
    expect(divergences).toHaveLength(0);
  });

  it("ignores positions без matchedV3TokenId (не V3 или ещё не override'нулись)", () => {
    const capflow = [
      pos({
        id: "POS-AAVE",
        currentUsd: 1000,
        feesUsd: 50,
        feesClaimedUsd: 0,
      }),
    ];
    const krystal = new Map();
    expect(findKrystalDivergences(capflow, krystal)).toEqual([]);
  });

  it("Krystal missing data для matched tokenId: пропускаем тихо", () => {
    const capflow = [
      pos({
        id: "POS-X",
        matchedV3TokenId: "9999",
        currentUsd: 1000,
        feesUsd: 0,
        feesClaimedUsd: 0,
      }),
    ];
    const krystal = new Map();
    expect(findKrystalDivergences(capflow, krystal)).toEqual([]);
  });

  it("multi-field divergence: возвращает все поля в одном entry", () => {
    const capflow = [
      pos({
        id: "POS-MULTI",
        matchedV3TokenId: "m",
        currentUsd: 1000,
        feesUsd: 10,
        feesClaimedUsd: 100,
      }),
    ];
    const krystal = new Map([["m", summary({
      tokenId: "m",
      currentUsd: 2000, // 100% diff
      pendingFeeUsd: 50, // 400% diff
      claimedFeeUsd: 200, // 100% diff
    })]]);
    const d = findKrystalDivergences(capflow, krystal);
    expect(d).toHaveLength(1);
    expect(d[0]!.fields).toEqual(
      expect.arrayContaining(["currentUsd", "pendingFeeUsd", "feesClaimedUsd"]),
    );
  });
});
