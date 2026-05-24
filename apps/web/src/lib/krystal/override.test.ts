/**
 * PR-K3: Krystal V3 → OpenPosition override (current state only, cost basis
 * остаётся UCB).
 *
 * Логика: для каждой V3 LP OpenPosition с `matchedV3TokenId` set, если в
 * Krystal Map есть summary для этого tokenId — overrride:
 *   - `supplyTokens[].amount`     ← krystal.currentTokens[].amount
 *   - `supplyTokens[].currentUsd` ← krystal.currentTokens[].usd
 *   - `currentUsd`                ← krystal.currentUsd
 *   - `feesUsd`                   ← krystal.pendingFeeUsd
 *   - `feesByToken`               ← krystal.pendingFeeTokens
 *   - `feesClaimedUsd`            ← krystal.claimedFeeUsd
 *   - `feesClaimedByToken`        ← krystal.claimedFeeTokens
 *   - `feesLifetimeUsd`           ← pending + claimed (recompute)
 *
 * НЕ трогаем cost-basis side (Krystal's `providedAmounts` менее точный для
 * cross-wallet/cross-protocol attribution чем UCB lots):
 *   - `startUsd`
 *   - `netStartUsd`
 *   - `openedAt`, `openHash`, `ageDays`
 *   - `supplyTokens[].startUsd`
 *   - `openedInTokens`
 *
 * Per-position PnL re-derived: `currentUsd - startUsd`.
 * `feeApr` / `feeAprLifetime` recomputed с новыми fees.
 */

import { describe, expect, it } from "vitest";

import { applyKrystalV3Override } from "./override";
import type { KrystalV3Summary } from "./adapter";
import type { OpenPosition } from "../portfolio/open_positions";

function basePos(args: {
  id: string;
  matchedV3TokenId?: string;
  startUsd: number;
  currentUsd: number;
  ageDays?: number;
  supply: { symbol: string; amount: number; currentUsd: number; startUsd: number }[];
  feesUsd?: number | null;
  feesClaimedUsd?: number;
  feesByToken?: { symbol: string; amount: number; usd: number; nativeApr: number | null }[];
  feesSource?: "v3_rewards" | "supply_yield" | null;
  feesClaimedHistory?: { time: number; hash: string; usd: number; positionUsdAtClaim?: number; daysSincePrev?: number; aprPeriod?: number; tokensReceived?: { symbol: string; amount: number; usd: number }[] }[];
}): OpenPosition {
  return {
    id: args.id,
    walletId: "wallet-1",
    walletName: "test wallet",
    walletChain: "evm",
    chain: "arb",
    protocol: { id: "uniswap3", name: "Uniswap V3" },
    kind: "lp",
    itemName: "Liquidity Pool",
    openedAt: 1770000000,
    openHash: "0xpos",
    ageDays: args.ageDays ?? 60,
    supplyTokens: args.supply.map((s) => ({
      symbol: s.symbol,
      amount: s.amount,
      startUsd: s.startUsd,
      currentUsd: s.currentUsd,
    })) as OpenPosition["supplyTokens"],
    debtTokens: [],
    openedInTokens: [],
    startUsd: args.startUsd,
    netStartUsd: args.startUsd,
    currentUsd: args.currentUsd,
    currentDebtUsd: 0,
    healthRate: null,
    feesUsd: args.feesUsd ?? null,
    feesSource: args.feesSource ?? "v3_rewards",
    feesClaimedUsd: args.feesClaimedUsd ?? 0,
    feesLifetimeUsd: (args.feesUsd ?? 0) + (args.feesClaimedUsd ?? 0),
    feeApr: null,
    feeAprLifetime: null,
    feesClaimedHistory: (args.feesClaimedHistory ?? []) as OpenPosition["feesClaimedHistory"],
    feesByToken: (args.feesByToken ?? []) as OpenPosition["feesByToken"],
    creditFundedUsd: 0,
    coverageIncomplete: false,
    ...(args.matchedV3TokenId && { matchedV3TokenId: args.matchedV3TokenId }),
  };
}

function summary(args: {
  tokenId: string;
  currentUsd: number;
  current: { symbol: string; amount: number; usd: number }[];
  pendingUsd: number;
  pending?: { symbol: string; amount: number; usd: number }[];
  claimedUsd: number;
  claimed?: { symbol: string; amount: number; usd: number }[];
}): KrystalV3Summary {
  return {
    tokenId: args.tokenId,
    chainCode: "arb",
    protocolKey: "uniswapv3",
    pair: ["WETH", "USDC"],
    status: "IN_RANGE",
    currentUsd: args.currentUsd,
    currentTokens: args.current.map((t) => ({ ...t, address: "0x" })),
    pendingFeeUsd: args.pendingUsd,
    pendingFeeTokens: (args.pending ?? []).map((t) => ({ ...t, address: "0x" })),
    claimedFeeUsd: args.claimedUsd,
    claimedFeeTokens: (args.claimed ?? []).map((t) => ({ ...t, address: "0x" })),
    providedTokens: [],
  };
}

describe("applyKrystalV3Override", () => {
  it("overrides current state + fees когда matchedV3TokenId есть в Krystal Map", () => {
    // lex POS-007 reproduction: capflow says claimed=$778.76 (баг #1 collect-vs-decrease),
    // Krystal says claimed=$32.80 (pool Collect events authoritative).
    const pos = basePos({
      id: "POS-007",
      matchedV3TokenId: "1197028",
      startUsd: 979.57,
      currentUsd: 984.32,
      ageDays: 118,
      supply: [
        { symbol: "WETH", amount: 0.367, currentUsd: 779.15, startUsd: 227.26 },
        { symbol: "USDT", amount: 205.46, currentUsd: 205.23, startUsd: 752.31 },
      ],
      feesUsd: 9.14,
      feesClaimedUsd: 778.76, // INFLATED — баг #1
    });
    const krystal = new Map<string, KrystalV3Summary>([
      [
        "1197028",
        summary({
          tokenId: "1197028",
          currentUsd: 985.10,
          current: [
            { symbol: "WETH", amount: 0.368, usd: 780.0 },
            { symbol: "USDT", amount: 205.10, usd: 205.10 },
          ],
          pendingUsd: 9.15,
          pending: [
            { symbol: "WETH", amount: 0.0022, usd: 4.7 },
            { symbol: "USDT", amount: 4.45, usd: 4.45 },
          ],
          claimedUsd: 32.80, // REAL — Krystal pool-level Collect events
          claimed: [{ symbol: "USDT", amount: 32.80, usd: 32.80 }],
        }),
      ],
    ]);

    const out = applyKrystalV3Override([pos], krystal);
    const p = out[0]!;

    // currentUsd from Krystal
    expect(p.currentUsd).toBeCloseTo(985.10, 1);
    // supplyTokens overridden
    expect(p.supplyTokens[0]!.amount).toBeCloseTo(0.368, 3);
    expect(p.supplyTokens[0]!.currentUsd).toBeCloseTo(780.0, 1);
    // pending fees from Krystal
    expect(p.feesUsd).toBeCloseTo(9.15, 2);
    expect(p.feesByToken).toHaveLength(2);
    // PR-K7 revert: claimed остаётся UCB (Krystal claimed unreliable —
    // POS-007 real $80, POS-006 real $271, Krystal врёт в 2.5×). PR-2 split
    // через DecreaseLiquidity events — авторитарный fix.
    expect(p.feesClaimedUsd).toBe(778.76);
    expect(p.feesLifetimeUsd).toBeCloseTo(9.15 + 778.76, 2);
    // cost-basis untouched (UCB authoritative)
    expect(p.startUsd).toBe(979.57);
    expect(p.openedAt).toBe(1770000000);
    expect(p.openHash).toBe("0xpos");
    expect(p.ageDays).toBe(118);
    expect(p.supplyTokens[0]!.startUsd).toBe(227.26);
    expect(p.supplyTokens[1]!.startUsd).toBe(752.31);
  });

  it("recomputes feeApr и feeAprLifetime с новыми fees", () => {
    const pos = basePos({
      id: "POS-A",
      matchedV3TokenId: "9991",
      startUsd: 1000,
      currentUsd: 1000,
      ageDays: 100,
      supply: [{ symbol: "WETH", amount: 0.5, currentUsd: 1000, startUsd: 1000 }],
      feesUsd: 50,
      feesClaimedUsd: 100,
    });
    const krystal = new Map<string, KrystalV3Summary>([
      [
        "9991",
        summary({
          tokenId: "9991",
          currentUsd: 1000,
          current: [{ symbol: "WETH", amount: 0.5, usd: 1000 }],
          pendingUsd: 30, // overrides 50
          pending: [{ symbol: "WETH", amount: 0.015, usd: 30 }],
          claimedUsd: 20, // overrides 100
          claimed: [{ symbol: "WETH", amount: 0.01, usd: 20 }],
        }),
      ],
    ]);

    const out = applyKrystalV3Override([pos], krystal);
    const p = out[0]!;

    expect(p.feesUsd).toBe(30);
    // PR-K7: claimed остаётся UCB, не Krystal.
    expect(p.feesClaimedUsd).toBe(100);
    expect(p.feesLifetimeUsd).toBe(130); // 30 pending + 100 claimed (UCB)
    // feeApr = (pending / start) × 365 / age × 100 = (30 / 1000) × 3.65 × 100 = 10.95
    expect(p.feeApr).toBeCloseTo(10.95, 1);
    // feeAprLifetime = (lifetime / start) × 365 / age × 100 = (130 / 1000) × 3.65 × 100 = 47.45
    expect(p.feeAprLifetime).toBeCloseTo(47.45, 1);
  });

  it("non-V3 (lending) positions — Krystal override no-op", () => {
    const pos: OpenPosition = {
      ...basePos({
        id: "POS-AAVE",
        startUsd: 10000,
        currentUsd: 10500,
        supply: [{ symbol: "WETH", amount: 5, currentUsd: 10500, startUsd: 10000 }],
        feesUsd: 500,
        feesSource: "supply_yield",
      }),
      protocol: { id: "aave3", name: "Aave V3" },
      kind: "lending",
    };
    const krystal = new Map<string, KrystalV3Summary>([
      ["9999", summary({
        tokenId: "9999", currentUsd: 1, current: [],
        pendingUsd: 0, claimedUsd: 0,
      })],
    ]);

    const out = applyKrystalV3Override([pos], krystal);
    // Untouched
    expect(out[0]!.currentUsd).toBe(10500);
    expect(out[0]!.feesUsd).toBe(500);
  });

  it("V3 position без matchedV3TokenId — no-op (нечем матчить)", () => {
    const pos = basePos({
      id: "POS-X",
      // matchedV3TokenId not set
      startUsd: 1000,
      currentUsd: 1000,
      supply: [{ symbol: "WETH", amount: 0.5, currentUsd: 1000, startUsd: 1000 }],
      feesUsd: 5,
    });
    const krystal = new Map<string, KrystalV3Summary>([
      [
        "1234",
        summary({
          tokenId: "1234", currentUsd: 2000, current: [{ symbol: "WETH", amount: 1, usd: 2000 }],
          pendingUsd: 50, claimedUsd: 10,
        }),
      ],
    ]);

    const out = applyKrystalV3Override([pos], krystal);
    expect(out[0]!.currentUsd).toBe(1000); // unchanged
    expect(out[0]!.feesUsd).toBe(5);       // unchanged
  });

  it("Krystal Map пустой — no-op (Krystal не загрузился / disabled)", () => {
    const pos = basePos({
      id: "POS-1",
      matchedV3TokenId: "1197028",
      startUsd: 1000,
      currentUsd: 1000,
      supply: [{ symbol: "WETH", amount: 0.5, currentUsd: 1000, startUsd: 1000 }],
      feesUsd: 5,
    });

    const out = applyKrystalV3Override([pos], new Map());
    expect(out[0]!.currentUsd).toBe(1000);
  });

  it("PR-K7 revert: feesClaimedHistory никогда не трогается Krystal'ом", () => {
    // После lex@ audit 2026-05-25: Krystal claimed выдал в 2.5× меньше
    // реальных Etherscan totals (POS-007 real $80 vs Krystal $32, POS-006
    // real $271 vs Krystal $107). Scaling history pro-rata Krystal'ом
    // ломал корректные UCB entries. PR-K7 убрал override claimed.
    const pos = basePos({
      id: "POS-007",
      matchedV3TokenId: "1197028",
      startUsd: 979.57,
      currentUsd: 984.32,
      ageDays: 118,
      supply: [
        { symbol: "WETH", amount: 0.367, currentUsd: 779.15, startUsd: 227.26 },
      ],
      feesUsd: 9.14,
      feesClaimedUsd: 80.38, // UCB+PR-2 split — authoritative real
      feesClaimedHistory: [
        {
          time: 1770543155,
          hash: "0xclaim1",
          usd: 34.35,
          positionUsdAtClaim: 910.57,
          daysSincePrev: 13.46,
          aprPeriod: 95.5,
          tokensReceived: [{ symbol: "ETH", amount: 0.00758, usd: 17.54 }],
        },
        {
          time: 1773839135,
          hash: "0xclaim2",
          usd: 46.03,
          positionUsdAtClaim: 910.57,
          daysSincePrev: 38.15,
          aprPeriod: 48.5,
          tokensReceived: [{ symbol: "USDT", amount: 22.46, usd: 22.46 }],
        },
      ],
    });
    const krystal = new Map<string, KrystalV3Summary>([
      [
        "1197028",
        summary({
          tokenId: "1197028",
          currentUsd: 985.10,
          current: [{ symbol: "WETH", amount: 0.368, usd: 780.0 }],
          pendingUsd: 9.15,
          claimedUsd: 32.80, // КРИВО (Krystal у lex@ оказался unreliable)
        }),
      ],
    ]);

    const out = applyKrystalV3Override([pos], krystal);
    const p = out[0]!;

    // claimed остаётся UCB (НЕ Krystal $32.80)
    expect(p.feesClaimedUsd).toBe(80.38);
    // history никак не scaled
    expect(p.feesClaimedHistory).toHaveLength(2);
    expect(p.feesClaimedHistory[0]!.usd).toBe(34.35);
    expect(p.feesClaimedHistory[1]!.usd).toBe(46.03);
    // tokensReceived не trogan
    expect(p.feesClaimedHistory[0]!.tokensReceived?.[0]?.amount).toBe(0.00758);

    // Krystal действует только на current state
    expect(p.currentUsd).toBeCloseTo(985.10, 1);
    expect(p.feesUsd).toBeCloseTo(9.15, 2);
    expect(p.feesLifetimeUsd).toBeCloseTo(9.15 + 80.38, 2);
  });

  it("recomputes netPnlUsd и netPnlPct из нового currentUsd", () => {
    const pos = basePos({
      id: "POS-PNL",
      matchedV3TokenId: "777",
      startUsd: 1000,
      currentUsd: 900, // Capflow underreports
      supply: [{ symbol: "WETH", amount: 0.4, currentUsd: 900, startUsd: 1000 }],
    });
    const krystal = new Map<string, KrystalV3Summary>([
      [
        "777",
        summary({
          tokenId: "777", currentUsd: 1100, // Krystal says higher
          current: [{ symbol: "WETH", amount: 0.5, usd: 1100 }],
          pendingUsd: 0, claimedUsd: 0,
        }),
      ],
    ]);

    const out = applyKrystalV3Override([pos], krystal);
    const p = out[0]!;
    expect(p.currentUsd).toBe(1100);
    expect(p.netPnlUsd).toBe(100); // 1100 − 1000
    expect(p.netPnlPct).toBeCloseTo(10, 1);
  });
});
