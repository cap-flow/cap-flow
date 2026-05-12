import { describe, expect, it } from "vitest";

import {
  cacheKeyFor,
  defillamaCoinKey,
  priceFromMap,
} from "./defillama_keys.js";

describe("defillamaCoinKey — native tokens", () => {
  it("tokenId === chain → NATIVE_COIN entry", () => {
    expect(defillamaCoinKey("eth", "eth")).toBe("coingecko:ethereum");
    expect(defillamaCoinKey("sol", "sol")).toBe("coingecko:solana");
    expect(defillamaCoinKey("arb", "arb")).toBe(
      "arbitrum:0x0000000000000000000000000000000000000000"
    );
    expect(defillamaCoinKey("base", "base")).toBe(
      "base:0x0000000000000000000000000000000000000000"
    );
  });

  it("legacy 'eth' tokenId on non-eth chain → eth native", () => {
    expect(defillamaCoinKey("arb", "eth")).toBe("coingecko:ethereum");
  });

  it("unknown native chain → null", () => {
    expect(defillamaCoinKey("zzz", "zzz")).toBeNull();
  });
});

describe("defillamaCoinKey — EUR stables", () => {
  it.each([
    ["EURC", "coingecko:euro-coin"],
    ["EUROC", "coingecko:euro-coin"],
    ["EURE", "coingecko:monerium-eur-money"],
    ["EURS", "coingecko:stasis-eurs"],
    ["EURT", "coingecko:tether-eurt"],
    ["AGEUR", "coingecko:ageur"],
    ["EURI", "coingecko:eurite"],
  ])("%s → %s", (sym, key) => {
    expect(defillamaCoinKey("eth", "0x" + "a".repeat(40), sym)).toBe(key);
  });

  it("EUR override beats EVM-address path", () => {
    expect(
      defillamaCoinKey("base", "0x" + "b".repeat(40), "EURC")
    ).toBe("coingecko:euro-coin");
  });
});

describe("defillamaCoinKey — EVM addresses", () => {
  it("known chain → '{llama}:{address-lowered}'", () => {
    const addr = "0xAbCdEfAbCdEfAbCdEfAbCdEfAbCdEfAbCdEfAbCd";
    expect(defillamaCoinKey("eth", addr)).toBe(
      `ethereum:${addr.toLowerCase()}`
    );
    expect(defillamaCoinKey("arb", addr)).toBe(
      `arbitrum:${addr.toLowerCase()}`
    );
    expect(defillamaCoinKey("base", addr)).toBe(`base:${addr.toLowerCase()}`);
  });

  it("unknown chain → null", () => {
    expect(
      defillamaCoinKey("zzz-chain", "0x" + "a".repeat(40))
    ).toBeNull();
  });
});

describe("defillamaCoinKey — Solana mint", () => {
  it("'sol' chain + base58 mint → 'solana:{mint}'", () => {
    const mint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
    expect(defillamaCoinKey("sol", mint)).toBe(`solana:${mint}`);
  });

  it("non-sol chain with base58-looking id → not Solana", () => {
    expect(
      defillamaCoinKey("eth", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")
    ).toBeNull();
  });
});

describe("defillamaCoinKey — symbol fallback", () => {
  it("ETH / WETH → coingecko:ethereum", () => {
    expect(defillamaCoinKey("arb", "weird", "ETH")).toBe(
      "coingecko:ethereum"
    );
    expect(defillamaCoinKey("arb", "weird", "WETH")).toBe(
      "coingecko:ethereum"
    );
  });

  it("SOL → coingecko:solana", () => {
    expect(defillamaCoinKey("arb", "weird", "SOL")).toBe("coingecko:solana");
  });

  it("BTC / WBTC → coingecko:bitcoin", () => {
    expect(defillamaCoinKey("eth", "weird", "BTC")).toBe(
      "coingecko:bitcoin"
    );
    expect(defillamaCoinKey("eth", "weird", "WBTC")).toBe(
      "coingecko:bitcoin"
    );
  });

  it("unknown tokenId without symbol fallback → null", () => {
    expect(defillamaCoinKey("eth", "weird-id")).toBeNull();
  });
});

describe("defillamaCoinKey — edge cases", () => {
  it("null/undefined/empty tokenId → null", () => {
    expect(defillamaCoinKey("eth", null)).toBeNull();
    expect(defillamaCoinKey("eth", undefined)).toBeNull();
    expect(defillamaCoinKey("eth", "")).toBeNull();
  });
});

describe("cacheKeyFor / priceFromMap", () => {
  it("cacheKeyFor buckets timestamp to hour", () => {
    expect(cacheKeyFor("coingecko:ethereum", 3600 + 1)).toBe(
      "coingecko:ethereum|3600"
    );
    expect(cacheKeyFor("coingecko:ethereum", 3600 + 3599)).toBe(
      "coingecko:ethereum|3600"
    );
    expect(cacheKeyFor("coingecko:ethereum", 7200)).toBe(
      "coingecko:ethereum|7200"
    );
  });

  it("priceFromMap retrieves by (coin, hour-bucketed timestamp)", () => {
    const map = new Map<string, number>();
    map.set("coingecko:ethereum|3600", 2000);
    expect(priceFromMap(map, "coingecko:ethereum", 3600 + 500)).toBe(2000);
    expect(priceFromMap(map, "coingecko:ethereum", 7200)).toBeNull();
    expect(priceFromMap(map, "coingecko:bitcoin", 3600)).toBeNull();
  });
});
