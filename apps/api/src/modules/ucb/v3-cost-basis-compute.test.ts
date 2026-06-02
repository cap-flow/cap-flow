/**
 * B3-full L2a — pure V3 cost-basis aggregation + tick/price math.
 */
import { describe, expect, it } from "vitest";

import {
  computeV3CostBasis,
  type PriceForEvent,
} from "@cap-flow/ucb/v3_cost_basis_compute";
import type { V3LiquidityEvent } from "@cap-flow/ucb/v3_types";
import { sqrtPriceX96ToPrice, tickToPrice, v3RawAmountsAt } from "@cap-flow/ucb/v3_math";

const ev = (p: Partial<V3LiquidityEvent>): V3LiquidityEvent => ({
  type: "increase",
  tokenId: 1n,
  blockNumber: 100n,
  blockTime: 1700000000,
  txHash: "0xa",
  liquidity: 0n,
  amount0Raw: 0n,
  amount1Raw: 0n,
  ...p,
});

const pos = (dec0 = 18, dec1 = 6, tokenId = 1n) => ({
  tokenId,
  token0: { decimals: dec0 },
  token1: { decimals: dec1 },
});

describe("computeV3CostBasis", () => {
  it("PAXG/USDC-shaped single deposit → Σ amount × price (POS-010 formula)", () => {
    // 0.10148791 PAXG (18 dec) + 660.480034 USDC (6 dec); PAXG=$5128, USDC=$1.
    const inc = ev({
      amount0Raw: 101_487_910_000_000_000n, // 0.10148791e18
      amount1Raw: 660_480_034n, // 660.480034e6
    });
    const price: PriceForEvent = () => ({ p0: 5128, p1: 1 });
    const r = computeV3CostBasis(pos(18, 6), [inc], [], price);
    const expected = 0.10148791 * 5128 + 660.480034 * 1;
    expect(r.totalDeposited0).toBeCloseTo(0.10148791, 8);
    expect(r.totalDeposited1).toBeCloseTo(660.480034, 6);
    expect(r.netCostBasisUsd).toBeCloseTo(expected, 4);
    expect(r.hasHistPrices).toBe(true);
    expect(r.mintTxHash).toBe("0xa");
    expect(r.mintBlockTime).toBe(1700000000);
  });

  it("net = deposits − withdrawals, clamped ≥ 0", () => {
    const inc = ev({ txHash: "0xdep", amount1Raw: 200_000_000n }); // 200 USDC
    const dec = ev({ type: "decrease", txHash: "0xwd", blockNumber: 200n, amount1Raw: 50_000_000n }); // 50 USDC
    const price: PriceForEvent = () => ({ p0: 0, p1: 1 });
    const r = computeV3CostBasis(pos(18, 6), [inc], [dec], price);
    expect(r.totalWithdrawn1).toBeCloseTo(50, 6);
    expect(r.netCostBasisUsd).toBeCloseTo(150, 6);
    expect(r.eventCount).toEqual({ increase: 1, decrease: 1 });
    expect(r.withdrawalsByTxHash?.get("0xwd")).toEqual({ amount0: 0, amount1: 50 });
  });

  it("unpriceable event → hasHistPrices false, 0 USD (amounts still tracked)", () => {
    const inc = ev({ amount0Raw: 1_000_000_000_000_000_000n }); // 1 token0
    const r = computeV3CostBasis(pos(18, 6), [inc], [], () => null);
    expect(r.totalDeposited0).toBeCloseTo(1, 9);
    expect(r.totalDepositUsd).toBe(0);
    expect(r.hasHistPrices).toBe(false);
    expect(r.netCostBasisUsd).toBe(0);
  });

  it("mint tx = earliest IncreaseLiquidity by blockNumber", () => {
    const a = ev({ txHash: "0xlate", blockNumber: 300n });
    const b = ev({ txHash: "0xearly", blockNumber: 100n });
    const c = ev({ txHash: "0xmid", blockNumber: 200n });
    const r = computeV3CostBasis(pos(), [a, b, c], [], () => ({ p0: 0, p1: 0 }));
    expect(r.mintTxHash).toBe("0xearly");
  });

  it("multiple decreases in one tx aggregate by hash (lowercased)", () => {
    const d1 = ev({ type: "decrease", txHash: "0xWD", amount1Raw: 10_000_000n });
    const d2 = ev({ type: "decrease", txHash: "0xwd", amount1Raw: 5_000_000n });
    const r = computeV3CostBasis(pos(18, 6), [], [d1, d2], () => ({ p0: 0, p1: 1 }));
    expect(r.withdrawalsByTxHash?.get("0xwd")).toEqual({ amount0: 0, amount1: 15 });
  });
});

describe("v3_math", () => {
  it("tickToPrice applies decimal shift", () => {
    // tick 0 → 1.0001^0 = 1, × 10^(18-6) for WETH/USDC = 1e12 raw ratio
    expect(tickToPrice(0, 18, 6)).toBeCloseTo(1e12, 0);
  });

  it("sqrtPriceX96ToPrice round-trips a known ratio", () => {
    // sqrtPriceX96 for price_raw=1 (decimals equal) → 2^96
    const Q96 = 2n ** 96n;
    expect(sqrtPriceX96ToPrice(Q96, 6, 6)).toBeCloseTo(1, 6);
  });

  it("v3RawAmountsAt: below range → all token0", () => {
    const r = v3RawAmountsAt({ liquidityRaw: 1000, sqrtPa: 2, sqrtPb: 4, sqrtP: 1 });
    expect(r.amount1).toBe(0); // clamped to sqrtPa → token1 side zero
    expect(r.amount0).toBeGreaterThan(0);
  });
});
