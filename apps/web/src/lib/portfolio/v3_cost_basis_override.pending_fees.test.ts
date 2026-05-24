/**
 * PR-1 tests: V3 LP `overrideCurrentFromOnChain` accuracy fixes.
 *
 * Bugs reproduced (all from lex@mail.ru audit 2026-05-24):
 *
 *  Bug #2 — USDC currentUsd lost when DeBank originally returned amount=0:
 *    POS-003 NFT #5404456 had DeBank lp.supply with WETH amount>0 + USDC
 *    amount=0 (DeBank swap bug between 2 NFTs in same pool). Phase J Phase J
 *    `overrideCurrentFromOnChain` correctly pulled USDC amount from on-chain
 *    NFT, but `priceBySymbol` map only had WETH price (USDC was skipped
 *    because original amount/currentUsd were both 0). Result:
 *    USDC.currentUsd = 376.85 × 0 = $0 → position.currentUsd = $1,508.70
 *    (missing $376 USDC). Real value $1,884.30.
 *
 *  Bug #3 — Pending fees from DeBank stale `lp.rewards` instead of on-chain:
 *    POS-003 showed pending fee $236.58 (0.0555 WETH + 118.74 USDC). User
 *    collected on May 5 → on-chain `tokensOwed0/1` reset. Real pending = $14.60
 *    (fresh accrual since last claim, computed via feeGrowthInside delta).
 *    DeBank didn't refresh `portfolio_item.detail.reward_token_list` → kept
 *    showing pre-claim values for 19+ days.
 *
 *  Bug #6 — supplyTokens[].startUsd not redistributed when amount changes:
 *    Phase J Phase J overrides supplyTokens[].amount from on-chain, but doesn't
 *    redistribute per-token startUsd → Σ supplyTokens.startUsd ≠ position.startUsd.
 *    POS-006 logged `Σ=3664.80 != position.startUsd 3618.52` (diff $46).
 *
 * Together these are the «PR-1» bundle from the lex audit. PR-1b (separate
 * follow-up) adds real-time fee accrual via pool feeGrowthGlobal + tickInfo
 * for positions where user hasn't interacted recently and `tokensOwed=0`.
 */

import { describe, expect, it } from "vitest";

import { applyV3CostBasisOverride } from "./v3_cost_basis_override";
import type { OpenPosition } from "./open_positions";
import type { V3CostBasisResult } from "@/lib/v3/liquidity_events";
import type { V3Position } from "@/lib/v3/positions";
import { v3PositionKey, type V3PositionMap } from "@/lib/v3/hook";

const WALLET_ID = "lex-2";
const CHAIN = "arb";
const DEPLOY_ID = "uniswap-v3-arb";

const WETH_ADDR = "0x82af49447d8a07e3bd95bd0d56f35241523fbab1" as `0x${string}`;
const USDC_ADDR = "0xaf88d065e77c8cc2239327c5edb3a432268e5831" as `0x${string}`;

/**
 * V3Position builder: `tokensOwed0/1` and `pendingFee0/1` default to 0
 * unless explicitly overridden. New fields added in PR-1.
 */
function nft(args: {
  tokenId: bigint;
  amounts: [number, number];
  symbols: [string, string];
  decimals?: [number, number];
  tokensOwed?: [number, number];
  pendingFee?: [number, number];
}): V3Position {
  const [s0, s1] = args.symbols;
  const [d0, d1] = args.decimals ?? [18, 6];
  const [a0, a1] = args.amounts;
  const [t0, t1] = args.tokensOwed ?? [0, 0];
  const [p0, p1] = args.pendingFee ?? [t0, t1]; // default = tokensOwed
  return {
    deploymentId: DEPLOY_ID,
    protocolLabel: "Uniswap V3",
    chain: CHAIN,
    tokenId: args.tokenId,
    poolAddress: "0x1111111111111111111111111111111111111111" as `0x${string}`,
    token0: { address: WETH_ADDR, symbol: s0, decimals: d0 },
    token1: { address: USDC_ADDR, symbol: s1, decimals: d1 },
    feeTier: 3000,
    tickLower: -887272,
    tickUpper: 887272,
    priceLower: 0,
    priceUpper: 1e18,
    currentPrice: 2120,
    currentTick: 0,
    liquidity: 1n,
    inRange: true,
    amount0Current: a0,
    amount1Current: a1,
    amount0AtPa: 0,
    amount1AtPa: 0,
    amount0AtPb: 0,
    amount1AtPb: 0,
    tokensOwed0: t0,
    tokensOwed1: t1,
    pendingFee0: p0,
    pendingFee1: p1,
  } as V3Position;
}

function basePos(args: {
  id: string;
  startUsd: number;
  currentUsd: number;
  supply: { symbol: string; amount: number; currentUsd: number; startUsd: number }[];
  feesUsd?: number | null;
  feesByToken?: { symbol: string; amount: number; usd: number; nativeApr: number | null }[];
  feesSource?: "v3_rewards" | "supply_yield" | null;
  openHash?: string;
}): OpenPosition {
  return {
    id: args.id,
    walletId: WALLET_ID,
    walletName: "lex 2",
    walletChain: "evm",
    chain: CHAIN,
    protocol: { id: "uniswap3", name: "Uniswap V3" },
    kind: "lp",
    itemName: "Liquidity Pool",
    openedAt: 1770000000,
    openHash: args.openHash ?? "0xabcdef",
    ageDays: 60,
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
    feesClaimedUsd: 0,
    feesLifetimeUsd: 0,
    feeApr: null,
    feeAprLifetime: null,
    feesClaimedHistory: [],
    feesByToken: (args.feesByToken ?? []) as OpenPosition["feesByToken"],
    creditFundedUsd: 0,
    coverageIncomplete: false,
  };
}

function cbFor(args: {
  tokenId: bigint;
  netCostBasisUsd: number;
  mintTxHash: string;
  totalDeposited0?: number;
  totalDeposited1?: number;
}): V3CostBasisResult {
  return {
    tokenId: args.tokenId,
    totalDeposited0: args.totalDeposited0 ?? 0,
    totalDeposited1: args.totalDeposited1 ?? 0,
    totalWithdrawn0: 0,
    totalWithdrawn1: 0,
    totalDepositUsd: args.netCostBasisUsd,
    totalWithdrawUsd: 0,
    netCostBasisUsd: args.netCostBasisUsd,
    eventCount: { increase: 1, decrease: 0 },
    hasHistPrices: true,
    mintTxHash: args.mintTxHash,
    mintBlockTime: 1770000000,
  };
}

describe("PR-1 Bug #2: USDC currentUsd fallback when DeBank had amount=0/currentUsd=0", () => {
  it("infers $1 for stable when no price in priceBySymbol", () => {
    // POS-003 reproduction: DeBank сначала отдал USDC с нулём, WETH с правильной
    // ценой. Phase J overrideCurrentFromOnChain потянул amounts с цепи, но
    // потерял USDC цену → showed currentUsd = $1,508 instead of $1,884.
    const pos = basePos({
      id: "POS-003",
      startUsd: 1837.59,
      currentUsd: 1508.70,
      openHash: "0xpos003mint",
      supply: [
        // WETH ok: amount=0.71, currentUsd=$1508.70 (price $2,124/WETH)
        { symbol: "WETH", amount: 0.7116, currentUsd: 1508.70, startUsd: 1837.59 },
        // USDC broken: amount=0, currentUsd=0 (DeBank swap bug)
        { symbol: "USDC", amount: 0, currentUsd: 0, startUsd: 0 },
      ],
    });
    const v3PositionMap: V3PositionMap = new Map([
      [
        v3PositionKey({
          walletId: WALLET_ID,
          chain: CHAIN,
          deploymentId: DEPLOY_ID,
          symbols: ["WETH", "USDC"],
        }),
        [
          nft({
            tokenId: 5404456n,
            amounts: [0.7116, 376.85], // on-chain: 0.71 WETH + 376.85 USDC
            symbols: ["WETH", "USDC"],
            decimals: [18, 6],
          }),
        ],
      ],
    ]);
    const v3CostBasis = new Map<string, V3CostBasisResult>([
      [
        "5404456",
        cbFor({
          tokenId: 5404456n,
          netCostBasisUsd: 1837.59,
          mintTxHash: "0xpos003mint",
          totalDeposited0: 0.71,
          totalDeposited1: 200,
        }),
      ],
    ]);

    const { positions } = applyV3CostBasisOverride([pos], v3PositionMap, v3CostBasis);
    const p = positions[0]!;

    // Expected: USDC stable $1 fallback → currentUsd ≈ $376.85
    const usdcSupply = p.supplyTokens.find((t) => t.symbol === "USDC")!;
    expect(usdcSupply.amount).toBeCloseTo(376.85, 1);
    expect(usdcSupply.currentUsd).toBeCloseTo(376.85, 1);

    const wethSupply = p.supplyTokens.find((t) => t.symbol === "WETH")!;
    expect(wethSupply.amount).toBeCloseTo(0.7116, 3);
    expect(wethSupply.currentUsd).toBeCloseTo(1508.70, 1);

    // Total ≈ Uniswap UI value $1,884.30
    expect(p.currentUsd).toBeCloseTo(1885.55, 1);
  });

  it("falls back to currentPrices map (other positions) для non-stable", () => {
    // POS-X имеет ETH в supply с amount=0/currentUsd=0 (broken DeBank).
    // POS-OTHER в том же портфеле имеет WETH с нормальной ценой —
    // applyV3CostBasisOverride должен переиспользовать эту цену для POS-X.
    const broken = basePos({
      id: "POS-X",
      startUsd: 2000,
      currentUsd: 1000,
      openHash: "0xx",
      supply: [
        { symbol: "WETH", amount: 0, currentUsd: 0, startUsd: 0 },
        { symbol: "USDC", amount: 500, currentUsd: 500, startUsd: 1000 },
      ],
    });
    const other = basePos({
      id: "POS-OTHER",
      startUsd: 5000,
      currentUsd: 5000,
      openHash: "0xother",
      supply: [
        { symbol: "WETH", amount: 1, currentUsd: 2200, startUsd: 2500 },
        { symbol: "USDT", amount: 2800, currentUsd: 2800, startUsd: 2500 },
      ],
    });
    const v3PositionMap: V3PositionMap = new Map([
      [
        v3PositionKey({
          walletId: WALLET_ID,
          chain: CHAIN,
          deploymentId: DEPLOY_ID,
          symbols: ["WETH", "USDC"],
        }),
        [
          nft({
            tokenId: 9991n,
            amounts: [0.5, 500],
            symbols: ["WETH", "USDC"],
          }),
        ],
      ],
    ]);
    const v3CostBasis = new Map<string, V3CostBasisResult>([
      ["9991", cbFor({ tokenId: 9991n, netCostBasisUsd: 2000, mintTxHash: "0xx" })],
    ]);

    const { positions } = applyV3CostBasisOverride(
      [broken, other],
      v3PositionMap,
      v3CostBasis,
    );
    const p = positions.find((x) => x.id === "POS-X")!;
    const weth = p.supplyTokens.find((t) => t.symbol === "WETH")!;

    // WETH price $2,200 cross-position lookup → 0.5 × $2200 = $1100
    expect(weth.amount).toBeCloseTo(0.5, 2);
    expect(weth.currentUsd).toBeCloseTo(1100, 1);
  });
});

describe("PR-1 Bug #3: pending fees from on-chain tokensOwed", () => {
  it("overrides DeBank stale lp.rewards с on-chain pendingFee0/1", () => {
    // POS-003 reproduction: DeBank lp.rewards = 0.0555 WETH + 118.74 USDC
    // ($236.58 — stale pre-claim). On-chain tokensOwed = 0.006 WETH + 1.5 USDC
    // ($14.20 — real residue after May 5 claim).
    const pos = basePos({
      id: "POS-003",
      startUsd: 1837.59,
      currentUsd: 1508.70,
      openHash: "0xpos003mint",
      feesUsd: 236.58, // STALE from DeBank
      feesByToken: [
        { symbol: "WETH", amount: 0.0555, usd: 117.71, nativeApr: null },
        { symbol: "USDC", amount: 118.74, usd: 118.87, nativeApr: null },
      ],
      supply: [
        { symbol: "WETH", amount: 0.71, currentUsd: 1508.70, startUsd: 1837.59 },
        { symbol: "USDC", amount: 0, currentUsd: 0, startUsd: 0 },
      ],
    });
    const v3PositionMap: V3PositionMap = new Map([
      [
        v3PositionKey({
          walletId: WALLET_ID,
          chain: CHAIN,
          deploymentId: DEPLOY_ID,
          symbols: ["WETH", "USDC"],
        }),
        [
          nft({
            tokenId: 5404456n,
            amounts: [0.71, 376.85],
            symbols: ["WETH", "USDC"],
            tokensOwed: [0.006, 1.5], // on-chain real pending fees
          }),
        ],
      ],
    ]);
    const v3CostBasis = new Map<string, V3CostBasisResult>([
      [
        "5404456",
        cbFor({
          tokenId: 5404456n,
          netCostBasisUsd: 1837.59,
          mintTxHash: "0xpos003mint",
        }),
      ],
    ]);

    const { positions } = applyV3CostBasisOverride([pos], v3PositionMap, v3CostBasis);
    const p = positions[0]!;

    // feesUsd: 0.006 × $2120 + 1.5 × $1 = $12.72 + $1.50 = $14.22
    expect(p.feesUsd).toBeCloseTo(14.22, 1);

    // feesByToken: replaced from on-chain
    expect(p.feesByToken).toHaveLength(2);
    const wethFee = p.feesByToken.find((f) => f.symbol === "WETH")!;
    const usdcFee = p.feesByToken.find((f) => f.symbol === "USDC")!;
    expect(wethFee.amount).toBeCloseTo(0.006, 4);
    expect(wethFee.usd).toBeCloseTo(12.72, 1);
    expect(usdcFee.amount).toBeCloseTo(1.5, 2);
    expect(usdcFee.usd).toBeCloseTo(1.5, 1);
  });

  it("если tokensOwed=0 на обоих токенах — feesUsd → 0 (не оставляем stale)", () => {
    // Если юзер только что claim'нул, tokensOwed reset — система должна
    // отразить $0 pending (более правда чем DeBank stale $200).
    // Реальная аккумуляция since last claim требует feeGrowth math (PR-1b).
    const pos = basePos({
      id: "POS-Y",
      startUsd: 1000,
      currentUsd: 1000,
      openHash: "0xy",
      feesUsd: 200, // STALE
      feesByToken: [{ symbol: "USDC", amount: 200, usd: 200, nativeApr: null }],
      supply: [
        { symbol: "WETH", amount: 0.5, currentUsd: 1000, startUsd: 1000 },
        { symbol: "USDC", amount: 0, currentUsd: 0, startUsd: 0 },
      ],
    });
    const v3PositionMap: V3PositionMap = new Map([
      [
        v3PositionKey({
          walletId: WALLET_ID,
          chain: CHAIN,
          deploymentId: DEPLOY_ID,
          symbols: ["WETH", "USDC"],
        }),
        [
          nft({
            tokenId: 7777n,
            amounts: [0.5, 0],
            symbols: ["WETH", "USDC"],
            tokensOwed: [0, 0], // freshly claimed
          }),
        ],
      ],
    ]);
    const v3CostBasis = new Map<string, V3CostBasisResult>([
      ["7777", cbFor({ tokenId: 7777n, netCostBasisUsd: 1000, mintTxHash: "0xy" })],
    ]);

    const { positions } = applyV3CostBasisOverride([pos], v3PositionMap, v3CostBasis);
    const p = positions[0]!;
    expect(p.feesUsd).toBe(0);
    expect(p.feesByToken).toEqual([]);
  });

  it("non-V3 (supply_yield) — feesUsd НЕ затрагивается override'ом", () => {
    // Override применяется только к V3 NFT positions, не к lending.
    // Для Aave/Compound feesUsd идёт через computeFees (supply_yield path).
    const pos: OpenPosition = {
      ...basePos({
        id: "POS-AAVE",
        startUsd: 1000,
        currentUsd: 1100,
        openHash: "0xaave",
        feesUsd: 100,
        feesSource: "supply_yield",
        feesByToken: [{ symbol: "WETH", amount: 0.05, usd: 100, nativeApr: 5 }],
        supply: [{ symbol: "WETH", amount: 0.52, currentUsd: 1100, startUsd: 1000 }],
      }),
      protocol: { id: "aave3", name: "Aave V3" },
      kind: "lending",
    };
    // Нет V3 position map / cost basis для этой позиции → override no-op.
    const { positions } = applyV3CostBasisOverride([pos], new Map(), new Map());
    expect(positions[0]!.feesUsd).toBe(100);
    expect(positions[0]!.feesByToken[0]!.usd).toBe(100);
  });
});

describe("PR-1 Bug #6: supplyTokens[].startUsd redistribute after amount change", () => {
  it("когда on-chain amounts отличаются от DeBank — startUsd per token redistribute pro-rata", () => {
    // POS-006 reproduction: DeBank gave WETH amount=A, USDC amount=B,
    // but on-chain has different ratio (oracle correctly tracks). After
    // Phase J amount override, Σ supplyTokens.startUsd no longer equals
    // position.startUsd unless we recompute per-token startUsd под новое
    // распределение currentUsd.
    const pos = basePos({
      id: "POS-006",
      startUsd: 3664.80,
      currentUsd: 3705.55,
      openHash: "0xpos006mint",
      supply: [
        // DeBank stale: WETH=$328 / USDT=$3383 (но pool ratio изменился)
        { symbol: "WETH", amount: 0.155, currentUsd: 328.25, startUsd: 328.25 },
        { symbol: "USDC", amount: 3383, currentUsd: 3383.42, startUsd: 3383.42 },
      ],
    });
    const v3PositionMap: V3PositionMap = new Map([
      [
        v3PositionKey({
          walletId: WALLET_ID,
          chain: CHAIN,
          deploymentId: DEPLOY_ID,
          symbols: ["WETH", "USDC"],
        }),
        [
          // On-chain: pool moved — WETH side $2951, USDC side $753
          nft({
            tokenId: 5293495n,
            amounts: [1.392, 754],
            symbols: ["WETH", "USDC"],
            decimals: [18, 6],
          }),
        ],
      ],
    ]);
    const v3CostBasis = new Map<string, V3CostBasisResult>([
      [
        "5293495",
        cbFor({
          tokenId: 5293495n,
          netCostBasisUsd: 3664.80, // same as startUsd → skip-branch
          mintTxHash: "0xpos006mint",
        }),
      ],
    ]);

    const { positions } = applyV3CostBasisOverride([pos], v3PositionMap, v3CostBasis);
    const p = positions[0]!;
    const sumStartUsd = p.supplyTokens.reduce((s, t) => s + t.startUsd, 0);

    // Invariant: |Σ supplyTokens.startUsd - position.startUsd| < $1
    expect(Math.abs(sumStartUsd - p.startUsd)).toBeLessThan(1);
  });
});
