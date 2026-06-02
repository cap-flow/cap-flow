/**
 * B3-full L2d — V3EnrichmentSource: positions → v3PositionMap + v3CostBasis.
 */
import { describe, expect, it, vi } from "vitest";

import {
  V3EnrichmentSource,
  type V3EnrichmentDeps,
  type V3TargetPosition,
} from "./v3-enrichment.source.js";
import { v3PositionKey } from "@cap-flow/ucb/v3_types";
import type { V3LiquidityEvent, V3Position } from "@cap-flow/ucb/v3_types";

const WALLET = "0x10b850c3abfca78d693c9cd6fce809c129109d1c";
const WETH_ARB = "0x82af49447d8a07e3bd95bd0d56f35241523fbab1";
const USDC_ARB = "0xaf88d065e77c8cc2239327c5edb3a432268e5831";
const WBTC_ARB = "0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f";

const v3pos = (p: Partial<V3Position>): V3Position => ({
  deploymentId: "uniswap-v3-arb",
  protocolLabel: "Uniswap V3",
  chain: "arb",
  tokenId: 5417064n,
  poolAddress: "0xpool",
  token0: { address: WETH_ARB, symbol: "WETH", decimals: 18 },
  token1: { address: USDC_ARB, symbol: "USDC", decimals: 6 },
  feeTier: 500,
  tickLower: -1,
  tickUpper: 1,
  priceLower: 0,
  priceUpper: 0,
  currentPrice: 0,
  currentTick: 0,
  liquidity: 1n,
  inRange: true,
  amount0Current: 0,
  amount1Current: 0,
  amount0AtPa: 0,
  amount1AtPa: 0,
  amount0AtPb: 0,
  amount1AtPb: 0,
  tokensOwed0: 0,
  tokensOwed1: 0,
  pendingFee0: 0,
  pendingFee1: 0,
  ...p,
});

const inc = (p: Partial<V3LiquidityEvent>): V3LiquidityEvent => ({
  type: "increase",
  tokenId: 5417064n,
  blockNumber: 100n,
  blockTime: 1700000000,
  txHash: "0xmint",
  liquidity: 1n,
  amount0Raw: 0n,
  amount1Raw: 0n,
  ...p,
});

const target = (p: Partial<V3TargetPosition> = {}): V3TargetPosition => ({
  protocol: { name: "Uniswap V3" },
  chain: "arb",
  walletId: "w1",
  ...p,
});

const byId = new Map([["w1", WALLET]]);

function deps(over: Partial<V3EnrichmentDeps> = {}): V3EnrichmentDeps {
  return {
    etherscan: {
      fetchV3LiquidityEvents: vi.fn(async () => ({ increases: [], decreases: [] })),
    },
    alchemyKey: "KEY",
    fetchHistoricalPrices: vi.fn(async () => new Map<string, number>()),
    makeClient: vi.fn(() => ({}) as never),
    fetchPositions: vi.fn(async () => []),
    fetchPoolPrice: vi.fn(async () => null),
    ...over,
  };
}

describe("V3EnrichmentSource.forPositions", () => {
  it("no alchemy key → empty maps", async () => {
    const src = new V3EnrichmentSource(deps({ alchemyKey: undefined }));
    const r = await src.forPositions([target()], byId);
    expect(r.v3PositionMap.size).toBe(0);
    expect(r.v3CostBasis.size).toBe(0);
  });

  it("WETH/USDC: slot0 price → cost basis (stable side)", async () => {
    const pos = v3pos({});
    const src = new V3EnrichmentSource(
      deps({
        fetchPositions: vi.fn(async () => [pos]),
        etherscan: {
          fetchV3LiquidityEvents: vi.fn(async () => ({
            increases: [inc({ amount0Raw: 50_000_000_000_000_000n, amount1Raw: 100_000_000n })], // 0.05 WETH + 100 USDC
            decreases: [],
          })),
        },
        fetchPoolPrice: vi.fn(async () => ({ price1Per0: 2500 })), // USDC=token1 stable → WETH $2500
      }),
    );
    const r = await src.forPositions([target()], byId);
    // map keyed exactly as the client (canon WETH→ETH, sorted)
    const key = v3PositionKey({ walletId: "w1", chain: "arb", deploymentId: "uniswap-v3-arb", symbols: ["WETH", "USDC"] });
    expect(r.v3PositionMap.get(key)).toHaveLength(1);
    const cb = r.v3CostBasis.get("5417064")!;
    expect(cb.netCostBasisUsd).toBeCloseTo(0.05 * 2500 + 100, 4); // = 225
    expect(cb.mintTxHash).toBe("0xmint");
    expect(cb.hasHistPrices).toBe(true);
  });

  it("volatile/volatile (WETH/WBTC): slot0 null → DefiLlama fallback", async () => {
    const pos = v3pos({
      tokenId: 999n,
      token1: { address: WBTC_ARB, symbol: "WBTC", decimals: 8 },
    });
    const bucket = Math.floor(1700000000 / 3600) * 3600;
    const src = new V3EnrichmentSource(
      deps({
        fetchPositions: vi.fn(async () => [pos]),
        etherscan: {
          fetchV3LiquidityEvents: vi.fn(async () => ({
            increases: [inc({ tokenId: 999n, amount0Raw: 1_000_000_000_000_000_000n, amount1Raw: 100_000_000n })], // 1 WETH + 1 WBTC
            decreases: [],
          })),
        },
        fetchPoolPrice: vi.fn(async () => null), // no slot0 → DefiLlama
        fetchHistoricalPrices: vi.fn(async () =>
          new Map([
            [`arbitrum:${WETH_ARB}|${bucket}`, 2500],
            [`arbitrum:${WBTC_ARB}|${bucket}`, 60000],
          ]),
        ),
      }),
    );
    const r = await src.forPositions([target()], byId);
    const cb = r.v3CostBasis.get("999")!;
    expect(cb.netCostBasisUsd).toBeCloseTo(1 * 2500 + 1 * 60000, 2); // = 62500
  });

  it("skips positions with no matching deployment / no wallet address", async () => {
    const fetchPositions = vi.fn(async () => []);
    const src = new V3EnrichmentSource(deps({ fetchPositions }));
    await src.forPositions(
      [target({ protocol: { name: "Aave V3" } }), target({ walletId: "unknown" })],
      byId,
    );
    expect(fetchPositions).not.toHaveBeenCalled();
  });
});
