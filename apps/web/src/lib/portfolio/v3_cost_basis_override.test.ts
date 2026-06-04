/**
 * Focused integration test for Fix #1 (orphan openedAt backfill).
 *
 * Reproduces alexander@gmail.com POS-009 / POS-010 scenario:
 *   - 2 Uniswap V3 orphan NFTs (mint event не нашёлся в chain-ops истории
 *     → coverageIncomplete=true)
 *   - openHash отсутствует (orphan)
 *   - useV3LiquidityEvents через Etherscan-fallback нашёл IncreaseLiquidity
 *     events → cb.mintBlockTime + cb.mintTxHash + cb.netCostBasisUsd известны
 *
 * Goal: applyV3CostBasisOverride должен backfill'ить openedAt / openHash /
 *       ageDays / openedInTokens и снять coverageIncomplete flag.
 *
 * Pre-fix bug: backfill срабатывал только в одной из 4 веток (Phase 1.5
 * «override applied»). Для POS-009/010 newStartUsd ≈ oldStartUsd
 * (fallback startUsd = currentUsd близко к real cost basis), и они уходили
 * в Phase 1.5 SKIP-ветку → backfill пропускался → openedAt оставался null.
 */

import { describe, expect, it } from "vitest";

import { applyV3CostBasisOverride } from "./v3_cost_basis_override";
import type { OpenPosition } from "./open_positions";
import type { V3CostBasisResult } from "@/lib/v3/liquidity_events";
import type { V3Position } from "@/lib/v3/positions";
import { v3PositionKey, type V3PositionMap } from "@/lib/v3/hook";

const WALLET_ID = "alex-3";
const CHAIN = "eth";
const DEPLOY_ID = "uniswap-v3-eth";

const XAU_ADDR = "0x68749665ff8d2d112fa859aa293f07a622782f38" as `0x${string}`;
const USDT_ADDR = "0xdac17f958d2ee523a2206206994597c13d831ec7" as `0x${string}`;

function orphanPos(args: {
  id: string;
  startUsd: number;
  currentUsd: number;
  symbols: [string, string];
  amounts: [number, number];
}): OpenPosition {
  const [s0, s1] = args.symbols;
  const [a0, a1] = args.amounts;
  return {
    id: args.id,
    walletId: WALLET_ID,
    walletName: "Alex 3",
    walletChain: "evm",
    chain: CHAIN,
    protocol: { id: "uniswap3", name: "Uniswap V3" },
    kind: "lp",
    itemName: "Liquidity Pool",
    openedAt: null, // orphan
    openHash: null, // orphan — no mint tx in our chain-ops
    ageDays: null,
    supplyTokens: [
      { symbol: s0, amount: a0, startUsd: args.startUsd / 2, currentUsd: args.currentUsd / 2 },
      { symbol: s1, amount: a1, startUsd: args.startUsd / 2, currentUsd: args.currentUsd / 2 },
    ] as OpenPosition["supplyTokens"],
    debtTokens: [],
    openedInTokens: [],
    startUsd: args.startUsd,
    netStartUsd: args.startUsd,
    currentUsd: args.currentUsd,
    currentDebtUsd: 0,
    healthRate: null,
    feesUsd: null,
    feesSource: null,
    feesClaimedUsd: 0,
    feesLifetimeUsd: 0,
    feeApr: null,
    feeAprLifetime: null,
    feesClaimedHistory: [],
    feesByToken: [],
    creditFundedUsd: 0,
    coverageIncomplete: true, // КРИТИЧНО для теста
  };
}

function nft(args: {
  tokenId: bigint;
  amounts: [number, number];
  symbols: [string, string];
}): V3Position {
  return {
    deploymentId: DEPLOY_ID,
    protocolLabel: "Uniswap V3",
    chain: CHAIN,
    tokenId: args.tokenId,
    poolAddress: "0x1111111111111111111111111111111111111111" as `0x${string}`,
    token0: { address: XAU_ADDR, symbol: args.symbols[0], decimals: 8 },
    token1: { address: USDT_ADDR, symbol: args.symbols[1], decimals: 6 },
    feeTier: 3000,
    tickLower: -887272,
    tickUpper: 887272,
    priceLower: 0,
    priceUpper: 1e18,
    currentPrice: 3000,
    currentTick: 0,
    liquidity: 1n,
    inRange: true,
    amount0Current: args.amounts[0],
    amount1Current: args.amounts[1],
  } as V3Position;
}

function cbFor(args: {
  tokenId: bigint;
  netCostBasisUsd: number;
  mintBlockTime: number;
  mintTxHash: string;
  totalDeposited0: number;
  totalDeposited1: number;
}): V3CostBasisResult {
  return {
    tokenId: args.tokenId,
    totalDeposited0: args.totalDeposited0,
    totalDeposited1: args.totalDeposited1,
    totalWithdrawn0: 0,
    totalWithdrawn1: 0,
    totalDepositUsd: args.netCostBasisUsd,
    totalWithdrawUsd: 0,
    netCostBasisUsd: args.netCostBasisUsd,
    eventCount: { increase: 1, decrease: 0 },
    hasHistPrices: true,
    mintTxHash: args.mintTxHash,
    mintBlockTime: args.mintBlockTime,
  };
}

describe("applyV3CostBasisOverride — orphan openedAt backfill (Fix #1)", () => {
  it("Phase 1.5 skip-branch: backfill срабатывает когда newStartUsd ≈ oldStartUsd", () => {
    // POS-009/010 reproduction: startUsd ≈ netCostBasisUsd (fallback заранее
    // выставил startUsd = currentUsd, который оказался близко к real basis).
    const pos009 = orphanPos({
      id: "POS-009",
      startUsd: 228.41,
      currentUsd: 228.41,
      symbols: ["XAU", "USDT"],
      amounts: [0.013493, 716.10],
    });
    const pos010 = orphanPos({
      id: "POS-010",
      startUsd: 159.04,
      currentUsd: 158.96,
      symbols: ["XAU", "USDT"],
      amounts: [0.008755, 56.83],
    });

    const nft009 = nft({
      tokenId: 1159873n,
      amounts: [0.013493, 716.10],
      symbols: ["XAU", "USDT"],
    });
    const nft010 = nft({
      tokenId: 1159369n,
      amounts: [0.008755, 56.83],
      symbols: ["XAU", "USDT"],
    });

    const cb009 = cbFor({
      tokenId: 1159873n,
      netCostBasisUsd: 228.42, // < 1% diff from startUsd 228.41 → skip-branch
      mintBlockTime: 1766649719, // 2025-12-25
      mintTxHash: "0xabc009",
      totalDeposited0: 0.013493,
      totalDeposited1: 716.10,
    });
    const cb010 = cbFor({
      tokenId: 1159369n,
      netCostBasisUsd: 159.05, // < 1% diff from 159.04 → skip-branch
      mintBlockTime: 1766573951, // 2025-12-24
      mintTxHash: "0xabc010",
      totalDeposited0: 0.008755,
      totalDeposited1: 56.83,
    });

    const v3PositionMap: V3PositionMap = new Map([
      [
        v3PositionKey({
          walletId: WALLET_ID,
          chain: CHAIN,
          deploymentId: DEPLOY_ID,
          symbols: ["XAU", "USDT"],
        }),
        [nft009, nft010],
      ],
    ]);
    const v3CostBasis = new Map<string, V3CostBasisResult>([
      ["1159873", cb009],
      ["1159369", cb010],
    ]);

    const { positions } = applyV3CostBasisOverride(
      [pos009, pos010],
      v3PositionMap,
      v3CostBasis,
    );

    expect(positions).toHaveLength(2);
    for (const p of positions) {
      expect(p.coverageIncomplete, `${p.id} coverageIncomplete should be false`).toBe(false);
      expect(p.openedAt, `${p.id} openedAt should be set from mintBlockTime`).not.toBeNull();
      expect(p.openHash, `${p.id} openHash should be set from mintTxHash`).toBeTruthy();
      expect(p.ageDays, `${p.id} ageDays should be computed`).not.toBeNull();
      expect((p.ageDays ?? 0) >= 0, `${p.id} ageDays should be non-negative`).toBe(true);
      expect(p.openedInTokens.length, `${p.id} openedInTokens populated`).toBe(2);
      // Should match the cb's tokenId
      expect(p.matchedV3TokenId).toBeTruthy();
    }

    const byId = new Map(positions.map((p) => [p.id, p]));
    expect(byId.get("POS-009")!.openedAt).toBe(1766649719);
    expect(byId.get("POS-009")!.openHash).toBe("0xabc009");
    expect(byId.get("POS-010")!.openedAt).toBe(1766573951);
    expect(byId.get("POS-010")!.openHash).toBe("0xabc010");
  });

  it("Phase 1.5 override-branch: backfill срабатывает когда startUsd реально override'нулся", () => {
    // Случай: fallback startUsd сильно отличается от реального cost basis
    // → Phase 1.5 amount-match override'нет startUsd → backfill в override-ветке.
    const pos = orphanPos({
      id: "POS-X",
      startUsd: 1000, // fallback — далеко от real $228
      currentUsd: 228.41,
      symbols: ["XAU", "USDT"],
      amounts: [0.013493, 716.10],
    });
    const v3PositionMap: V3PositionMap = new Map([
      [
        v3PositionKey({
          walletId: WALLET_ID,
          chain: CHAIN,
          deploymentId: DEPLOY_ID,
          symbols: ["XAU", "USDT"],
        }),
        [
          nft({
            tokenId: 1159873n,
            amounts: [0.013493, 716.10],
            symbols: ["XAU", "USDT"],
          }),
        ],
      ],
    ]);
    const v3CostBasis = new Map<string, V3CostBasisResult>([
      [
        "1159873",
        cbFor({
          tokenId: 1159873n,
          netCostBasisUsd: 228.42, // 77% diff from 1000 → override applied
          mintBlockTime: 1766649719,
          mintTxHash: "0xdeadbeef",
          totalDeposited0: 0.013493,
          totalDeposited1: 716.10,
        }),
      ],
    ]);

    const { positions, overriddenCount } = applyV3CostBasisOverride(
      [pos],
      v3PositionMap,
      v3CostBasis,
    );

    expect(overriddenCount).toBe(1);
    const p = positions[0]!;
    expect(p.startUsd).toBeCloseTo(228.42, 2);
    expect(p.coverageIncomplete).toBe(false);
    expect(p.openedAt).toBe(1766649719);
    expect(p.openHash).toBe("0xdeadbeef");
    expect(p.ageDays).not.toBeNull();
    expect(p.matchedV3TokenId).toBe("1159873");
  });

  it("override raises startUsd → netStartUsd tracks it (POS-027 Velodrome gauge, zero debt)", () => {
    // mmaksimuk POS-027: gauge-staked Velodrome WETH/WBTC (OP). The base build
    // had no traceable ops → placeholder startUsd = netStartUsd = currentUsd
    // (~$102.87). The Etherscan/slot0 cost basis is $235.97. After the override
    // raises startUsd, netStartUsd (zero debt) MUST track it — otherwise the
    // position's net-based APR/ROI is computed off the stale placeholder base.
    const pos = orphanPos({
      id: "POS-027",
      startUsd: 102.87, // placeholder == currentUsd (no ops traced)
      currentUsd: 102.87,
      symbols: ["WETH", "WBTC"],
      amounts: [0.0557, 0.0001],
    });
    // orphanPos sets netStartUsd = startUsd and currentDebtUsd = 0 (no borrow).
    expect(pos.netStartUsd).toBeCloseTo(102.87, 2);
    expect(pos.currentDebtUsd).toBe(0);

    const v3PositionMap: V3PositionMap = new Map([
      [
        v3PositionKey({
          walletId: WALLET_ID,
          chain: CHAIN,
          deploymentId: DEPLOY_ID,
          symbols: ["WETH", "WBTC"],
        }),
        [nft({ tokenId: 3427934n, amounts: [0.0557, 0.0001], symbols: ["WETH", "WBTC"] })],
      ],
    ]);
    const v3CostBasis = new Map<string, V3CostBasisResult>([
      [
        "3427934",
        cbFor({
          tokenId: 3427934n,
          netCostBasisUsd: 235.97, // on-chain slot0 cost basis (≫ placeholder)
          mintBlockTime: 1754929207, // 2025-08-11
          mintTxHash: "0x0ae402fb",
          totalDeposited0: 0.026907,
          totalDeposited1: 0.001,
        }),
      ],
    ]);

    const { positions, overriddenCount } = applyV3CostBasisOverride(
      [pos],
      v3PositionMap,
      v3CostBasis,
    );

    expect(overriddenCount).toBe(1);
    const p = positions[0]!;
    expect(p.startUsd).toBeCloseTo(235.97, 2);
    // Regression guard: pre-fix netStartUsd stayed at the placeholder ($102.87).
    // With zero debt netStartUsd must equal the overridden startUsd.
    expect(
      p.netStartUsd,
      "netStartUsd must track overridden startUsd when there is no debt",
    ).toBeCloseTo(235.97, 2);
  });

  it("non-orphan position: backfill UPDATES openedAt из cb (VolnyySanya POS-002 fix)", () => {
    const pos: OpenPosition = {
      ...orphanPos({
        id: "POS-NORMAL",
        startUsd: 228.41,
        currentUsd: 228.41,
        symbols: ["XAU", "USDT"],
        amounts: [0.013493, 716.10],
      }),
      coverageIncomplete: false, // не orphan
      openedAt: 1700000000, // уже выставлен из chain-ops
      openHash: "0xoriginal",
      ageDays: 100,
    };
    const v3PositionMap: V3PositionMap = new Map([
      [
        v3PositionKey({
          walletId: WALLET_ID,
          chain: CHAIN,
          deploymentId: DEPLOY_ID,
          symbols: ["XAU", "USDT"],
        }),
        [
          nft({
            tokenId: 1159873n,
            amounts: [0.013493, 716.10],
            symbols: ["XAU", "USDT"],
          }),
        ],
      ],
    ]);
    const v3CostBasis = new Map<string, V3CostBasisResult>([
      [
        "1159873",
        cbFor({
          tokenId: 1159873n,
          netCostBasisUsd: 228.42,
          mintBlockTime: 1766649719,
          mintTxHash: "0xnew",
          totalDeposited0: 0.013493,
          totalDeposited1: 716.10,
        }),
      ],
    ]);

    const { positions } = applyV3CostBasisOverride([pos], v3PositionMap, v3CostBasis);
    const p = positions[0]!;
    // 2026-05-26 (VolnyySanya POS-002 fix): backfill теперь BREAKS noop для
    // non-orphan и overrides openedAt из cb.mintBlockTime. Раньше DeBank's
    // earliest lp_add op подбирался → дата на месяцы раньше реальной
    // (старая burned NFT в том же пуле). Etherscan IncreaseLiquidity — single
    // source of truth.
    expect(p.openedAt).toBe(1766649719);
    expect(p.openHash).toBe("0xnew");
    expect(p.coverageIncomplete).toBe(false);
  });
});
