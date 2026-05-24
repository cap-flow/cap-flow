/**
 * PR-K1: Tests для Krystal V3 position adapter.
 *
 * Fixtures: реальные responses от cloud-api.krystal.app для lex@mail.ru
 * (2 кошелька, 6 V3 NFT всего на Arbitrum/Ethereum/Base, Uniswap V3).
 *
 * Targets:
 *  - POS-001 NFT 5469945 (Uniswap V3 arb WETH/USDC 0.05%) — критичный case,
 *    DeBank показывает stale $13.84 pending, Krystal real-time $251.44.
 *  - POS-007 NFT 1197028 (Uniswap V3 eth WETH/USDT) — critical для claimed
 *    fees (наш classifier дал $758, Krystal $32.90 = реальный).
 */

import { describe, expect, it } from "vitest";

import { krystalToV3Summary, type KrystalV3Summary } from "./adapter";
import type { KrystalPosition } from "./types";

import lex2Fixture from "./__fixtures__/lex2.json";
import lex1Fixture from "./__fixtures__/lex1.json";

const lex2 = lex2Fixture as unknown as KrystalPosition[];
const lex1 = lex1Fixture as unknown as KrystalPosition[];

const allPositions = [...lex2, ...lex1];
function findByTokenId(tokenId: string): KrystalPosition {
  const p = allPositions.find((x) => x.tokenId === tokenId);
  if (!p) throw new Error(`fixture missing tokenId=${tokenId}`);
  return p;
}

describe("krystalToV3Summary — Uniswap V3 LP", () => {
  it("POS-001 #5469945 WETH/USDC arb: real fees ~$251 (DeBank stale = $13.84)", () => {
    const summary = krystalToV3Summary(findByTokenId("5469945"));

    expect(summary.tokenId).toBe("5469945");
    expect(summary.chainCode).toBe("arb");
    expect(summary.protocolKey).toBe("uniswapv3");
    expect(summary.pair).toEqual(["WETH", "USDC"]);
    expect(summary.status).toBe("IN_RANGE");

    // Current value ≈ $15,109 (matches Uniswap UI / Revert)
    expect(summary.currentUsd).toBeCloseTo(15109.43, 0);
    expect(summary.currentTokens).toHaveLength(2);
    const wethCur = summary.currentTokens.find((t) => t.symbol === "WETH")!;
    const usdcCur = summary.currentTokens.find((t) => t.symbol === "USDC")!;
    expect(wethCur.amount).toBeCloseTo(5.6478, 3);
    expect(wethCur.usd).toBeCloseTo(11987.43, 0);
    expect(usdcCur.amount).toBeCloseTo(2870.56, 1);
    expect(usdcCur.usd).toBeCloseTo(2870.56, 1);

    // Real-time pending fees ≈ $251.44 (наш PR-1b наконец должен дать ту же)
    expect(summary.pendingFeeUsd).toBeCloseTo(251.44, 0);
    expect(summary.pendingFeeTokens).toHaveLength(2);
    const wethFee = summary.pendingFeeTokens.find((t) => t.symbol === "WETH")!;
    expect(wethFee.amount).toBeCloseTo(0.0588, 3);

    // Claimed fees: 0 (lex не делал claim для этой NFT)
    expect(summary.claimedFeeUsd).toBe(0);
    expect(summary.claimedFeeTokens).toEqual([]);

    // Cost basis (Krystal providedAmounts — может отличаться от нашей UCB
    // wrt cross-protocol attribution; используется только для cross-check)
    expect(summary.providedTokens).toBeDefined();
  });

  it("POS-003 #5404456 WETH/USDC arb: pending $14.67 (DeBank stale = $236.58)", () => {
    const summary = krystalToV3Summary(findByTokenId("5404456"));
    expect(summary.pair).toEqual(["WETH", "USDC"]);
    expect(summary.currentUsd).toBeCloseTo(1901.96, 0);
    expect(summary.pendingFeeUsd).toBeCloseTo(14.67, 1);
    expect(summary.claimedFeeUsd).toBeCloseTo(32.13, 1);
  });

  it("POS-007 #1197028 WETH/USDT eth: claimed $32.90 (наш классификатор inflated до $758)", () => {
    const summary = krystalToV3Summary(findByTokenId("1197028"));
    expect(summary.chainCode).toBe("eth");
    expect(summary.pair).toEqual(["WETH", "USDT"]);
    expect(summary.currentUsd).toBeCloseTo(994.88, 0);
    expect(summary.pendingFeeUsd).toBeCloseTo(9.15, 1);
    // Krystal claimed: real value, без principal contamination от
    // decreaseLiquidity+collect multicall'а.
    expect(summary.claimedFeeUsd).toBeCloseTo(32.9, 1);
    expect(summary.claimedFeeUsd).toBeLessThan(100); // SANITY: не $758
  });

  it("POS-004 #4911255 WETH/USDC base: parity (наш движок уже верный, sanity check)", () => {
    const summary = krystalToV3Summary(findByTokenId("4911255"));
    expect(summary.chainCode).toBe("base");
    expect(summary.currentUsd).toBeCloseTo(2064.92, 0);
    expect(summary.pendingFeeUsd).toBeCloseTo(23.57, 1);
    expect(summary.claimedFeeUsd).toBeCloseTo(55.4, 1);
  });

  it("returns canonical chain code from Krystal chain.id", () => {
    expect(krystalToV3Summary(findByTokenId("5469945")).chainCode).toBe("arb"); // 42161
    expect(krystalToV3Summary(findByTokenId("4911255")).chainCode).toBe("base"); // 8453
    expect(krystalToV3Summary(findByTokenId("1197028")).chainCode).toBe("eth"); // 1
  });

  it("handles missing tradingFee gracefully (returns 0 / empty array, no throw)", () => {
    const minimal: KrystalPosition = {
      chain: { id: 1, name: "Ethereum" },
      pool: {
        id: "0xpool",
        poolAddress: "0xpool",
        protocol: { key: "uniswapv3", name: "Uniswap V3" },
      },
      ownerAddress: "0xowner",
      id: "0xnpm-1",
      tokenId: "1",
      currentPositionValue: 1000,
      currentAmounts: [],
    };
    const summary = krystalToV3Summary(minimal);
    expect(summary.pendingFeeUsd).toBe(0);
    expect(summary.pendingFeeTokens).toEqual([]);
    expect(summary.claimedFeeUsd).toBe(0);
    expect(summary.claimedFeeTokens).toEqual([]);
  });
});

describe("summary type contract", () => {
  it("compiles — KrystalV3Summary shape stable", () => {
    const x: KrystalV3Summary = {
      tokenId: "1",
      chainCode: "arb",
      protocolKey: "uniswapv3",
      pair: ["WETH", "USDC"],
      status: "IN_RANGE",
      ownerAddress: "0xowner",
      poolAddress: "0xpool",
      currentUsd: 1000,
      currentTokens: [{ symbol: "WETH", amount: 0.5, usd: 1000, address: "0x0" }],
      pendingFeeUsd: 0,
      pendingFeeTokens: [],
      claimedFeeUsd: 0,
      claimedFeeTokens: [],
      providedTokens: [],
    };
    expect(x.tokenId).toBe("1");
  });
});
