/**
 * B3-full L2 — pure V3 per-event USD pricing (slot0 ratio / anchor / DefiLlama).
 */
import { describe, expect, it } from "vitest";

import { deriveUsdPrices } from "@cap-flow/ucb/v3_pricing";

const WETH = { symbol: "WETH", address: "0xWeth" };
const USDC = { symbol: "USDC", address: "0xUsdc" };
const WBTC = { symbol: "WBTC", address: "0xWbtc" };
const noLlama = () => null;

describe("deriveUsdPrices", () => {
  it("stable1: token1 USDC → p0 = price1Per0, p1 = $1", () => {
    const r = deriveUsdPrices(WETH, USDC, { price1Per0: 2500 }, 0, noLlama);
    expect(r).toEqual({ p0: 2500, p1: 1 });
  });

  it("stable0: token0 USDC → p0 = $1, p1 = 1/price1Per0", () => {
    const r = deriveUsdPrices(USDC, WETH, { price1Per0: 0.0004 }, 0, noLlama);
    expect(r!.p0).toBe(1);
    expect(r!.p1).toBeCloseTo(2500, 6);
  });

  it("anchor token0: WETH=token0, anchor=WETH → p0 = anchorUsd, p1 = anchorUsd/price1Per0", () => {
    // WETH/WBTC pool, price1Per0 = WBTC per WETH = 0.04; WETH $2500 → WBTC $62500.
    const r = deriveUsdPrices(
      WETH,
      WBTC,
      { price1Per0: 0.04, anchorTokenAddress: "0xweth", anchorTokenUsd: 2500 },
      0,
      noLlama,
    );
    expect(r!.p0).toBe(2500);
    expect(r!.p1).toBeCloseTo(62500, 4);
  });

  it("anchor token1: WETH=token1 → p1 = anchorUsd, p0 = anchorUsd*price1Per0", () => {
    const r = deriveUsdPrices(
      WBTC,
      WETH,
      { price1Per0: 25, anchorTokenAddress: "0xweth", anchorTokenUsd: 2500 },
      0,
      noLlama,
    );
    expect(r!.p1).toBe(2500);
    expect(r!.p0).toBeCloseTo(62500, 4);
  });

  it("DefiLlama fallback when slot0 (pp) is undefined (Velodrome Slipstream)", () => {
    const llama = (addr: string) => (addr === "0xweth" ? 2500 : 60000);
    const r = deriveUsdPrices(WETH, WBTC, undefined, 1700000000, llama);
    expect(r).toEqual({ p0: 2500, p1: 60000 });
  });

  it("unpriceable: no pp + no llama → null", () => {
    expect(deriveUsdPrices(WETH, WBTC, undefined, 1700000000, noLlama)).toBeNull();
  });

  it("volatile/volatile with pp but no anchor + no llama → null", () => {
    const r = deriveUsdPrices(WETH, WBTC, { price1Per0: 0.04 }, undefined, noLlama);
    expect(r).toBeNull();
  });
});
