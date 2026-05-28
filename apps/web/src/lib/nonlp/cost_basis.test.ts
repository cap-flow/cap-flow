import { describe, expect, it } from "vitest";

import {
  isUsdStable,
  startUsdFromPricedOut,
  startUsdFromStableOut,
  type OpenedInToken,
} from "./cost_basis";

const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const WETH = "0x82af49447d8a07e3bd95bd0d56f35241523fbab1"; // arb WETH
const WAVAX = "0xb31f66aa3c1e785363f0875a1b74e27b85fd66c7"; // avax WAVAX

function t(address: string, symbol: string, amount: number): OpenedInToken {
  return { address, symbol, amount };
}

describe("isUsdStable", () => {
  it("распознаёт стейблы case-insensitive", () => {
    expect(isUsdStable("usdc")).toBe(true);
    expect(isUsdStable("USDT")).toBe(true);
    expect(isUsdStable(" DAI ")).toBe(true);
  });
  it("volatile → false", () => {
    expect(isUsdStable("WETH")).toBe(false);
    expect(isUsdStable("WBTC")).toBe(false);
    expect(isUsdStable("EURC")).toBe(false); // EUR-стейбл ≠ USD
  });
});

describe("startUsdFromStableOut (Stage 2a)", () => {
  it("все стейблы → Σ × $1", () => {
    expect(startUsdFromStableOut([t(USDC, "USDC", 100), t(USDC, "USDT", 50)])).toBe(150);
  });
  it("есть volatile → null (bail to Stage 2b)", () => {
    expect(startUsdFromStableOut([t(USDC, "USDC", 100), t(WETH, "WETH", 1)])).toBeNull();
  });
  it("пустой → null", () => {
    expect(startUsdFromStableOut([])).toBeNull();
  });
});

describe("startUsdFromPricedOut (Stage 2b)", () => {
  it("volatile оценивается по historical price", () => {
    const prices = new Map([[WETH, 2500]]);
    // 0.02 WETH × $2500 = $50
    expect(startUsdFromPricedOut([t(WETH, "WETH", 0.02)], prices)).toBe(50);
  });

  it("микс стейбл + volatile: стейбл=$1, volatile=price", () => {
    const prices = new Map([[WETH, 3000]]);
    // 100 USDC + 0.5 WETH×$3000 = 100 + 1500 = 1600
    expect(
      startUsdFromPricedOut([t(USDC, "USDC", 100), t(WETH, "WETH", 0.5)], prices),
    ).toBe(1600);
  });

  it("address lookup case-insensitive", () => {
    const prices = new Map([[WAVAX, 20]]);
    // priceByAddress ключ lowercase, token.address uppercase
    expect(
      startUsdFromPricedOut([t(WAVAX.toUpperCase(), "WAVAX", 3)], prices),
    ).toBe(60);
  });

  it("нет цены у volatile → null (не врём частичной оценкой)", () => {
    const prices = new Map<string, number>(); // WETH цены нет
    expect(
      startUsdFromPricedOut([t(USDC, "USDC", 100), t(WETH, "WETH", 1)], prices),
    ).toBeNull();
  });

  it("цена 0 → null", () => {
    const prices = new Map([[WETH, 0]]);
    expect(startUsdFromPricedOut([t(WETH, "WETH", 1)], prices)).toBeNull();
  });

  it("пустой OUT → null", () => {
    expect(startUsdFromPricedOut([], new Map())).toBeNull();
  });

  it("только стейблы (без цен) тоже работает", () => {
    expect(startUsdFromPricedOut([t(USDC, "USDC", 250)], new Map())).toBe(250);
  });
});
