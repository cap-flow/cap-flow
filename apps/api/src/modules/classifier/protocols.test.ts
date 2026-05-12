import { describe, expect, it } from "vitest";

import {
  classifyProtocol,
  isEurStableSymbol,
  isLendingReceipt,
  isProtocolToken,
  isStableSymbol,
  tokenFamily,
} from "./protocols.js";

describe("classifyProtocol", () => {
  it("returns null when both id and name are empty", () => {
    expect(classifyProtocol(null, null)).toBeNull();
    expect(classifyProtocol("", "")).toBeNull();
    expect(classifyProtocol(undefined, undefined)).toBeNull();
  });

  it.each([
    ["aave-v3", null, "lending", "Aave"],
    ["fluid-vault", null, "lending", "Fluid"],
    ["compound-v3", null, "lending", "Compound"],
    ["morpho-blue", null, "lending", "Morpho"],
    ["sky-protocol", null, "cdp", "MakerDAO/Sky"],
    ["makerdao", null, "cdp", "MakerDAO/Sky"],
    ["liquity-v2", null, "cdp", "Liquity"],
    ["uniswap-v3", null, "dex", "Uniswap"],
    ["sushiswap", null, "dex", "SushiSwap"],
    ["curve", null, "dex", "Curve"],
    ["aerodrome-slipstream", null, "dex", "Aerodrome"],
    ["velodrome", null, "dex", "Velodrome"],
    ["lido", null, "staking", "Lido"],
    ["rocketpool", null, "staking", "Rocket Pool"],
    ["etherfi", null, "restaking", "Ether.fi"],
    ["eigenlayer", null, "restaking", "EigenLayer"],
    ["pendle", null, "yield", "Pendle"],
    ["convex-finance", null, "yield", "Convex"],
    ["gmx", null, "yield", "GMX"],
    ["hyperliquid", null, "perp", "Hyperliquid"],
    ["dydx-v4", null, "perp", "dYdX"],
    ["stargate", null, "bridge", "Stargate"],
    ["layerzero", null, "bridge", "LayerZero"],
  ])("classifies %s → %s", (id, name, cat, expectedName) => {
    const r = classifyProtocol(id, name);
    expect(r).not.toBeNull();
    expect(r!.category).toBe(cat);
    expect(r!.name).toBe(expectedName);
    expect(r!.id).toBe(id);
  });

  it("matches against project name when id misses", () => {
    const r = classifyProtocol("custom-id", "Aave v3");
    expect(r?.category).toBe("lending");
    expect(r?.name).toBe("Aave v3");
    expect(r?.id).toBe("custom-id");
  });

  it("falls back to 'other' when no pattern matches", () => {
    const r = classifyProtocol("zzz-unknown-protocol", "Mystery DeFi");
    expect(r?.category).toBe("other");
    expect(r?.id).toBe("zzz-unknown-protocol");
    expect(r?.name).toBe("Mystery DeFi");
  });

  it("uses id as name when name is null", () => {
    const r = classifyProtocol("randomthing", null);
    expect(r?.category).toBe("other");
    expect(r?.id).toBe("randomthing");
    expect(r?.name).toBe("randomthing");
  });
});

describe("isEurStableSymbol", () => {
  it.each(["EURC", "EUROC", "EURE", "EURS", "EURT", "EURI", "AGEUR", "EUROE"])(
    "%s is EUR-stable",
    (s) => {
      expect(isEurStableSymbol(s)).toBe(true);
    }
  );

  it("is case-insensitive", () => {
    expect(isEurStableSymbol("eurc")).toBe(true);
    expect(isEurStableSymbol("EuRc")).toBe(true);
  });

  it("returns false for USD stables and non-stables", () => {
    expect(isEurStableSymbol("USDC")).toBe(false);
    expect(isEurStableSymbol("ETH")).toBe(false);
    expect(isEurStableSymbol("")).toBe(false);
  });
});

describe("tokenFamily", () => {
  it("returns empty for empty input", () => {
    expect(tokenFamily("")).toBe("");
  });

  it("uppercases and trims", () => {
    expect(tokenFamily("  usdc  ")).toBe("USDC");
  });

  it("normalizes unicode ₮ to ASCII T", () => {
    expect(tokenFamily("USD₮0")).toBe("USDT");
    expect(tokenFamily("USD₮")).toBe("USDT");
  });

  it("strips dot-suffixes", () => {
    expect(tokenFamily("USDC.e")).toBe("USDC");
    expect(tokenFamily("USDC.E")).toBe("USDC");
    expect(tokenFamily("USDT.0")).toBe("USDT");
  });

  it("strips trailing digits after letters", () => {
    expect(tokenFamily("USDT0")).toBe("USDT");
    expect(tokenFamily("USDT00")).toBe("USDT");
  });

  it.each([
    ["WETH", "ETH"],
    ["WBTC", "BTC"],
    ["TBTC", "BTC"],
    ["CBBTC", "BTC"],
    ["WSOL", "SOL"],
    ["WBNB", "BNB"],
    ["WMATIC", "MATIC"],
    ["WAVAX", "AVAX"],
  ])("wrapped %s → %s", (input, expected) => {
    expect(tokenFamily(input)).toBe(expected);
  });

  it("passes through non-wrapped, non-stable symbols", () => {
    expect(tokenFamily("ARB")).toBe("ARB");
    expect(tokenFamily("LINK")).toBe("LINK");
  });
});

describe("isStableSymbol", () => {
  it.each([
    "USDT",
    "USDC",
    "USDC.E",
    "DAI",
    "TUSD",
    "USDP",
    "LUSD",
    "BUSD",
    "FDUSD",
    "PYUSD",
    "USDE",
    "FRAX",
    "CRVUSD",
    "MIM",
    "USDS",
    "USDT0",
    "USD₮0",
    "USD0",
    "AUSD",
    "GHO",
    "SUSDS",
    "USDM",
    "DOLA",
    "FXUSD",
  ])("%s is stable", (s) => {
    expect(isStableSymbol(s)).toBe(true);
  });

  it("is case-insensitive (lowercase USD stables)", () => {
    expect(isStableSymbol("usdc")).toBe(true);
    expect(isStableSymbol("dai")).toBe(true);
  });

  it("recognizes USDT/USDC/DAI/USDE family suffixes", () => {
    expect(isStableSymbol("USDT0")).toBe(true);
    expect(isStableSymbol("USDC.X")).toBe(true);
    expect(isStableSymbol("USDC2")).toBe(true);
  });

  it("returns false for non-stables", () => {
    expect(isStableSymbol("")).toBe(false);
    expect(isStableSymbol("ETH")).toBe(false);
    expect(isStableSymbol("WBTC")).toBe(false);
    expect(isStableSymbol("ARB")).toBe(false);
  });

  it("does NOT consider EUR-stables as USD-stables", () => {
    expect(isStableSymbol("EURC")).toBe(false);
    expect(isStableSymbol("EURS")).toBe(false);
  });
});

describe("isProtocolToken", () => {
  it.each([
    "aUSDC",
    "aWETH",
    "aDAI",
    "aWBTC",
    "aArbWETH",
    "aEthUSDC",
    "aPolWETH",
    "aOptETH",
    "aBaseUSDC",
    "variableDebtArbUSDC",
    "stableDebtUSDC",
    "cUSDC",
    "cETH",
    "cDAI",
    "cWBTC",
    "cWETHv3",
    "cUSDCv3",
  ])("%s is a protocol token (case-sensitive)", (s) => {
    expect(isProtocolToken(s)).toBe(true);
  });

  it.each([
    "mooBifiUSDC",
    "yvUSDC",
    "stETH",
    "wstETH",
    "rETH",
    "weETH",
    "ezETH",
    "rsETH",
    "swETH",
    "osETH",
    "sfrxETH",
    "SLP",
    "UNI-V2",
    "UNI-V3",
    "BPT-Aave",
    "CAKE-LP",
    "GM",
    "GM [BTC]",
    "GLV(Forex)[USDC]",
    "GLP",
    "FLP",
    "fVLT-1",
    "LBT",
    "PT-eETH",
    "YT-sUSDE",
  ])("%s is a protocol token (case-insensitive)", (s) => {
    expect(isProtocolToken(s)).toBe(true);
  });

  it("does NOT mark regular tokens as protocol tokens (false positives)", () => {
    expect(isProtocolToken("ARB")).toBe(false);
    expect(isProtocolToken("AAVE")).toBe(false);
    expect(isProtocolToken("AVAX")).toBe(false);
    expect(isProtocolToken("ATOM")).toBe(false);
    expect(isProtocolToken("ANKR")).toBe(false);
    expect(isProtocolToken("CRV")).toBe(false);
    expect(isProtocolToken("CVX")).toBe(false);
    expect(isProtocolToken("COMP")).toBe(false);
    expect(isProtocolToken("CAKE")).toBe(false);
    expect(isProtocolToken("ETH")).toBe(false);
    expect(isProtocolToken("USDC")).toBe(false);
    expect(isProtocolToken("")).toBe(false);
  });
});

describe("isLendingReceipt", () => {
  it.each([
    "aUSDC",
    "aWETH",
    "aArbWETH",
    "aEthUSDC",
    "cUSDC",
    "cWETHv3",
    "variableDebtArbUSDC",
    "stableDebtUSDC",
  ])("%s is a strict lending receipt", (s) => {
    expect(isLendingReceipt(s)).toBe(true);
  });

  it("does NOT include LP / vault / LST tokens (those are positions, not receipts)", () => {
    expect(isLendingReceipt("stETH")).toBe(false);
    expect(isLendingReceipt("rETH")).toBe(false);
    expect(isLendingReceipt("UNI-V2")).toBe(false);
    expect(isLendingReceipt("GM [BTC]")).toBe(false);
    expect(isLendingReceipt("GLP")).toBe(false);
    expect(isLendingReceipt("yvUSDC")).toBe(false);
    expect(isLendingReceipt("mooBifiUSDC")).toBe(false);
  });

  it("does NOT match regular tokens", () => {
    expect(isLendingReceipt("ARB")).toBe(false);
    expect(isLendingReceipt("AAVE")).toBe(false);
    expect(isLendingReceipt("")).toBe(false);
  });
});
