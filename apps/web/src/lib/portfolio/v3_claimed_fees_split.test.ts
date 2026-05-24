/**
 * PR-2 (2026-05-25): claim-vs-decrease split.
 *
 * Reproduces lex POS-007: первый "claim" $701 на самом деле
 * `multicall(decreaseLiquidity 0.30 ETH + collect 0.029 ETH+5 USDT)`.
 * После split: claimed entry $61 ($0.029 × $2090 ETH + $5 USDT),
 * principal $626 → не в claimed.
 */

import { describe, expect, it } from "vitest";

import { applyV3ClaimedFeesSplit } from "./v3_claimed_fees_split";
import type { OpenPosition } from "./open_positions";
import type { V3CostBasisResult } from "@/lib/v3/liquidity_events";
import type { V3Position } from "@/lib/v3/positions";
import { v3PositionKey, type V3PositionMap } from "@/lib/v3/hook";

const WALLET = "lex-1";
const CHAIN = "eth";
const DEPLOY = "uniswap-v3-eth";

function basePos(args: {
  id: string;
  matchedV3TokenId: string;
  feesClaimedUsd: number;
  feesUsd?: number;
  ageDays?: number;
  startUsd?: number;
  history: {
    hash: string;
    usd: number;
    tokensReceived: { symbol: string; amount: number; usd: number }[];
    positionUsdAtClaim?: number;
    daysSincePrev?: number;
    aprPeriod?: number;
  }[];
}): OpenPosition {
  return {
    id: args.id,
    walletId: WALLET,
    walletName: "lex 1",
    walletChain: "evm",
    chain: CHAIN,
    protocol: { id: "uniswap3", name: "Uniswap V3" },
    kind: "lp",
    itemName: "Liquidity Pool",
    openedAt: 1770000000,
    openHash: "0xmint",
    ageDays: args.ageDays ?? 100,
    matchedV3TokenId: args.matchedV3TokenId,
    supplyTokens: [
      { symbol: "WETH", amount: 0.5, currentUsd: 1000, startUsd: 500 },
      { symbol: "USDT", amount: 200, currentUsd: 200, startUsd: 200 },
    ] as OpenPosition["supplyTokens"],
    debtTokens: [],
    openedInTokens: [],
    startUsd: args.startUsd ?? 700,
    netStartUsd: args.startUsd ?? 700,
    currentUsd: 1200,
    currentDebtUsd: 0,
    healthRate: null,
    feesUsd: args.feesUsd ?? 5,
    feesSource: "v3_rewards",
    feesClaimedUsd: args.feesClaimedUsd,
    feesLifetimeUsd: (args.feesUsd ?? 5) + args.feesClaimedUsd,
    feeApr: null,
    feeAprLifetime: null,
    feesClaimedHistory: args.history.map((h) => ({
      time: 1770000000,
      hash: h.hash,
      usd: h.usd,
      tokensReceived: h.tokensReceived,
      positionUsdAtClaim: h.positionUsdAtClaim ?? 910,
      daysSincePrev: h.daysSincePrev ?? 13.5,
      aprPeriod: h.aprPeriod ?? 0,
    })) as OpenPosition["feesClaimedHistory"],
    feesByToken: [],
    creditFundedUsd: 0,
    coverageIncomplete: false,
  };
}

function makeNft(args: {
  tokenId: bigint;
  symbol0: string;
  symbol1: string;
}): V3Position {
  return {
    deploymentId: DEPLOY,
    protocolLabel: "Uniswap V3",
    chain: CHAIN,
    tokenId: args.tokenId,
    poolAddress: "0xpool",
    token0: { address: "0x0", symbol: args.symbol0, decimals: 18 },
    token1: { address: "0x1", symbol: args.symbol1, decimals: 6 },
    feeTier: 500,
    tickLower: -100, tickUpper: 100,
    priceLower: 1, priceUpper: 2000,
    currentPrice: 2000,
    currentTick: 0,
    liquidity: 1n,
    inRange: true,
    amount0Current: 0.5, amount1Current: 200,
    amount0AtPa: 0, amount1AtPa: 0,
    amount0AtPb: 0, amount1AtPb: 0,
    tokensOwed0: 0, tokensOwed1: 0,
    pendingFee0: 0, pendingFee1: 0,
  } as V3Position;
}

function makeCb(args: {
  tokenId: bigint;
  withdrawalsByTxHash?: Map<string, { amount0: number; amount1: number }>;
}): V3CostBasisResult {
  return {
    tokenId: args.tokenId,
    totalDeposited0: 0.5, totalDeposited1: 200,
    totalWithdrawn0: 0, totalWithdrawn1: 0,
    totalDepositUsd: 700, totalWithdrawUsd: 0,
    netCostBasisUsd: 700,
    eventCount: { increase: 1, decrease: 0 },
    hasHistPrices: true,
    mintTxHash: "0xmint",
    ...(args.withdrawalsByTxHash && { withdrawalsByTxHash: args.withdrawalsByTxHash }),
  };
}

const mapFor = (nft: V3Position): V3PositionMap => {
  return new Map([
    [
      v3PositionKey({
        walletId: WALLET,
        chain: CHAIN,
        deploymentId: DEPLOY,
        symbols: ["WETH", "USDT"],
      }),
      [nft],
    ],
  ]);
};

describe("applyV3ClaimedFeesSplit", () => {
  it("subtracts principal from claim_rewards entry when DecreaseLiquidity matches tx hash", () => {
    // POS-007 reproduction: первый claim $701 = 0.329 ETH + $5 USDT.
    // DecreaseLiquidity на том же tx удалила 0.30 ETH principal.
    // Real fee = 0.029 ETH × $2090 + $5 USDT = $60.61 + $5 = $65.61.
    const pos = basePos({
      id: "POS-007",
      matchedV3TokenId: "1197028",
      feesClaimedUsd: 701.18,
      ageDays: 100,
      startUsd: 910,
      history: [
        {
          hash: "0xdecreasetx",
          usd: 701.18,
          tokensReceived: [
            { symbol: "USDT", amount: 5, usd: 5 },
            { symbol: "ETH", amount: 0.329, usd: 696.18 },
          ],
          positionUsdAtClaim: 910,
          daysSincePrev: 13.5,
          aprPeriod: 2088,
        },
      ],
    });
    const nft = makeNft({ tokenId: 1197028n, symbol0: "WETH", symbol1: "USDT" });
    const cb = makeCb({
      tokenId: 1197028n,
      withdrawalsByTxHash: new Map([
        ["0xdecreasetx", { amount0: 0.30, amount1: 0 }], // 0.30 ETH principal
      ]),
    });

    const out = applyV3ClaimedFeesSplit([pos], mapFor(nft), new Map([["1197028", cb]]));
    const p = out[0]!;

    // ETH amount in entry: 0.329 - 0.30 = 0.029
    const ethEntry = p.feesClaimedHistory[0]!.tokensReceived?.find(
      (t) => t.symbol === "ETH",
    );
    expect(ethEntry?.amount).toBeCloseTo(0.029, 3);
    // ETH price was $696.18 / 0.329 = $2116/ETH. 0.029 × $2116 = $61.36
    expect(ethEntry?.usd).toBeCloseTo(61.36, 1);

    // USDT entry untouched (no withdrawal in USDT)
    const usdtEntry = p.feesClaimedHistory[0]!.tokensReceived?.find(
      (t) => t.symbol === "USDT",
    );
    expect(usdtEntry?.amount).toBe(5);
    expect(usdtEntry?.usd).toBe(5);

    // Entry total: ~$66.36 (vs original $701.18)
    expect(p.feesClaimedHistory[0]!.usd).toBeCloseTo(66.36, 1);
    expect(p.feesClaimedUsd).toBeCloseTo(66.36, 1);

    // aprPeriod recompute: ($66 / $910) × (365 / 13.5) × 100 ≈ 197% (vs 2088%)
    expect(p.feesClaimedHistory[0]!.aprPeriod).toBeLessThan(250);
    expect(p.feesClaimedHistory[0]!.aprPeriod).toBeGreaterThan(150);
  });

  it("no-op когда withdrawalsByTxHash empty (всё было pure collect)", () => {
    const pos = basePos({
      id: "POS-A",
      matchedV3TokenId: "999",
      feesClaimedUsd: 50,
      history: [
        {
          hash: "0xcollectonly",
          usd: 50,
          tokensReceived: [{ symbol: "USDT", amount: 50, usd: 50 }],
        },
      ],
    });
    const nft = makeNft({ tokenId: 999n, symbol0: "WETH", symbol1: "USDT" });
    const cb = makeCb({ tokenId: 999n }); // no withdrawals

    const out = applyV3ClaimedFeesSplit([pos], mapFor(nft), new Map([["999", cb]]));
    expect(out[0]!.feesClaimedUsd).toBe(50);
    expect(out[0]!.feesClaimedHistory[0]!.usd).toBe(50);
  });

  it("preserves entries без tx match даже когда withdrawals есть для других tx'ов", () => {
    const pos = basePos({
      id: "POS-B",
      matchedV3TokenId: "888",
      feesClaimedUsd: 100,
      history: [
        {
          hash: "0xdecreaseA",
          usd: 50,
          tokensReceived: [{ symbol: "USDT", amount: 50, usd: 50 }],
        },
        {
          hash: "0xpureclaim",
          usd: 50,
          tokensReceived: [{ symbol: "USDT", amount: 50, usd: 50 }],
        },
      ],
    });
    const nft = makeNft({ tokenId: 888n, symbol0: "WETH", symbol1: "USDT" });
    const cb = makeCb({
      tokenId: 888n,
      withdrawalsByTxHash: new Map([
        ["0xdecreasea", { amount0: 0, amount1: 30 }], // 30 USDT principal
      ]),
    });

    const out = applyV3ClaimedFeesSplit([pos], mapFor(nft), new Map([["888", cb]]));
    const p = out[0]!;
    // First entry: 50 - 30 = 20
    expect(p.feesClaimedHistory[0]!.usd).toBeCloseTo(20, 1);
    // Second entry: untouched
    expect(p.feesClaimedHistory[1]!.usd).toBe(50);
    expect(p.feesClaimedUsd).toBeCloseTo(70, 1);
  });

  it("WETH/ETH canonicalization работает (NFT token0=WETH, claim movement symbol=ETH)", () => {
    const pos = basePos({
      id: "POS-C",
      matchedV3TokenId: "777",
      feesClaimedUsd: 100,
      history: [
        {
          hash: "0xtx",
          usd: 100,
          tokensReceived: [{ symbol: "ETH", amount: 0.05, usd: 100 }],
        },
      ],
    });
    const nft = makeNft({ tokenId: 777n, symbol0: "WETH", symbol1: "USDT" });
    const cb = makeCb({
      tokenId: 777n,
      withdrawalsByTxHash: new Map([
        ["0xtx", { amount0: 0.03, amount1: 0 }], // 0.03 WETH principal
      ]),
    });

    const out = applyV3ClaimedFeesSplit([pos], mapFor(nft), new Map([["777", cb]]));
    const p = out[0]!;
    // 0.05 ETH - 0.03 WETH (matched canon ETH==WETH) = 0.02 ETH × $2000 = $40
    expect(p.feesClaimedHistory[0]!.tokensReceived?.[0]?.amount).toBeCloseTo(0.02, 3);
    expect(p.feesClaimedHistory[0]!.usd).toBeCloseTo(40, 1);
  });

  it("non-V3 (lending) positions — no-op", () => {
    const pos: OpenPosition = {
      ...basePos({
        id: "POS-AAVE",
        matchedV3TokenId: "999",
        feesClaimedUsd: 50,
        history: [{ hash: "0xanytx", usd: 50, tokensReceived: [] }],
      }),
      protocol: { id: "aave3", name: "Aave V3" },
      kind: "lending",
    };
    const out = applyV3ClaimedFeesSplit([pos], new Map(), new Map());
    expect(out[0]!.feesClaimedUsd).toBe(50);
  });
});
