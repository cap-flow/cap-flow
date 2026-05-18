/**
 * UCB D4: tests for tokenFamily — wrapped tokens & LSTs chain-aware
 * folding for asset rollup.
 */
import { describe, expect, it } from "vitest";

import { tokenFamily, isStableSymbol } from "./protocols";

describe("tokenFamily — UCB D4", () => {
  describe("base passthrough", () => {
    it("ETH → ETH", () => {
      expect(tokenFamily("ETH")).toBe("ETH");
    });
    it("BTC → BTC", () => {
      expect(tokenFamily("BTC")).toBe("BTC");
    });
    it("USDT → USDT", () => {
      expect(tokenFamily("USDT")).toBe("USDT");
    });
    it("пустой → ''", () => {
      expect(tokenFamily("")).toBe("");
    });
  });

  describe("variant suffixes", () => {
    it("USD₮0 (unicode) → USDT", () => {
      expect(tokenFamily("USD₮0")).toBe("USDT");
    });
    it("USDC.E (Avalanche bridge) → USDC", () => {
      expect(tokenFamily("USDC.E")).toBe("USDC");
    });
    it("USDT0 (Arbitrum) → USDT", () => {
      expect(tokenFamily("USDT0")).toBe("USDT");
    });
    it("WETH → ETH", () => {
      expect(tokenFamily("WETH")).toBe("ETH");
    });
  });

  describe("ETH liquid-staking derivatives", () => {
    const cases = [
      "stETH", "wstETH",
      "rETH",
      "cbETH",
      "frxETH", "sfrxETH",
      "eETH", "weETH",
      "ezETH",
      "wbETH",
      "oETH",
      "swETH",
      "ankrETH",
      "osETH",
      "mETH",
      "rswETH",
      "rsETH",
    ];
    for (const sym of cases) {
      it(`${sym} → ETH`, () => {
        expect(tokenFamily(sym)).toBe("ETH");
      });
    }
  });

  describe("BTC wrapped/LST variants", () => {
    const cases = [
      "WBTC", "TBTC", "CBBTC",
      "LBTC",
      "EBTC",
      "FBTC",
      "MBTC",
      "solvBTC", "solvBTCBBN",
      "stBTC",
      "pumpBTC",
      "uniBTC",
    ];
    for (const sym of cases) {
      it(`${sym} → BTC`, () => {
        expect(tokenFamily(sym)).toBe("BTC");
      });
    }
  });

  describe("savings stables", () => {
    it("sDAI → DAI", () => {
      expect(tokenFamily("sDAI")).toBe("DAI");
    });
    it("sUSDS → USDS", () => {
      expect(tokenFamily("sUSDS")).toBe("USDS");
    });
    it("sUSDe stays SUSDE (in STABLES, не folded further)", () => {
      // Note: SUSDE сам по себе стейбл, его не фолдим в USDe family
      // потому что SUSDE = $1 в нашей stable math. Если потребуется
      // отдельная аналитика «суммарный USDE exposure», добавим mapping.
      expect(tokenFamily("sUSDe")).toBe("SUSDE");
    });
  });

  describe("other simple wrappers", () => {
    it("WSOL → SOL", () => {
      expect(tokenFamily("WSOL")).toBe("SOL");
    });
    it("WBNB → BNB", () => {
      expect(tokenFamily("WBNB")).toBe("BNB");
    });
    it("WMATIC → MATIC", () => {
      expect(tokenFamily("WMATIC")).toBe("MATIC");
    });
    it("WAVAX → AVAX", () => {
      expect(tokenFamily("WAVAX")).toBe("AVAX");
    });
  });

  describe("case-insensitive", () => {
    it("WeTh → ETH", () => {
      expect(tokenFamily("WeTh")).toBe("ETH");
    });
    it("StEth → ETH", () => {
      expect(tokenFamily("StEth")).toBe("ETH");
    });
  });

  describe("unmatched tokens passthrough", () => {
    it("ARB → ARB", () => {
      expect(tokenFamily("ARB")).toBe("ARB");
    });
    it("OP → OP", () => {
      expect(tokenFamily("OP")).toBe("OP");
    });
    it("random SHITCOIN → SHITCOIN", () => {
      expect(tokenFamily("SHITCOIN")).toBe("SHITCOIN");
    });
  });
});

describe("isStableSymbol — unchanged by D4", () => {
  it("USDT is stable", () => {
    expect(isStableSymbol("USDT")).toBe(true);
  });
  it("sDAI is NOT in stable set (yield-bearing, not $1 peg)", () => {
    // sDAI价格 не равна $1 — растёт за счёт savings rate. tokenFamily
    // фолдит её в DAI для группировки, но isStableSymbol честно
    // возвращает false (cost basis math не treats её как $1).
    expect(isStableSymbol("sDAI")).toBe(false);
  });
  it("stETH NOT stable", () => {
    expect(isStableSymbol("stETH")).toBe(false);
  });
});
