import { afterEach, describe, expect, it } from "vitest";

import {
  classifyTokenRole,
  isDebtReceiptOfProtocol,
  isReceiptLessProtocol,
  isReceiptOfProtocol,
  registerReceiptLessOracle,
} from "./token_roles.js";

afterEach(() => {
  // Reset module-level oracle between tests so they don't leak.
  registerReceiptLessOracle(() => null);
});

describe("isReceiptLessProtocol — hardcoded list", () => {
  it.each([
    ["morphoblue"],
    ["arb_morphoblue"],
    ["eth_morphoblue"],
    ["drift"],
    ["adrena"],
    ["sol_adrena"],
  ])("%s is receipt-less", (id) => {
    expect(isReceiptLessProtocol(id)).toBe(true);
  });

  it("returns false for unknown protocol", () => {
    expect(isReceiptLessProtocol("aave-v3")).toBe(false);
    expect(isReceiptLessProtocol("gmx-v2")).toBe(false);
  });

  it("returns false for null/undefined/empty", () => {
    expect(isReceiptLessProtocol(null)).toBe(false);
    expect(isReceiptLessProtocol(undefined)).toBe(false);
    expect(isReceiptLessProtocol("")).toBe(false);
  });
});

describe("isReceiptLessProtocol — external oracle", () => {
  it("consults oracle for unknown protocols", () => {
    registerReceiptLessOracle((pid) =>
      pid === "newproto-vault" ? true : null
    );
    expect(isReceiptLessProtocol("newproto-vault")).toBe(true);
    expect(isReceiptLessProtocol("totally-unknown")).toBe(false);
  });

  it("hardcoded list takes precedence over oracle", () => {
    registerReceiptLessOracle(() => false);
    // morphoblue stays receipt-less even if oracle says otherwise.
    expect(isReceiptLessProtocol("morphoblue")).toBe(true);
  });

  it("oracle returning null falls through to default false", () => {
    registerReceiptLessOracle(() => null);
    expect(isReceiptLessProtocol("unknown-x")).toBe(false);
  });
});

describe("isReceiptOfProtocol — contract whitelist", () => {
  it("recognizes GMX V2 GM market contracts (whitelisted)", () => {
    // GM [ETH/USD] WETH-USDC
    expect(
      isReceiptOfProtocol(
        "GM [ETH/USD]",
        "arb_gmx2",
        "0x70d95587d40a2caf56bd97485ab3eec10bee6336"
      )
    ).toBe(true);
  });

  it("recognizes GLV vault by contract (whitelisted)", () => {
    expect(
      isReceiptOfProtocol(
        "GLV [WETH-USDC]",
        "arb_gmx2",
        "0x528a5bac7e746c9a509a1aa3cd71b8b07aad8b0d"
      )
    ).toBe(true);
  });

  it("recognizes Aave V3 aToken by contract (whitelisted)", () => {
    // aArbWETH
    expect(
      isReceiptOfProtocol(
        "aArbWETH",
        "arb_aave3",
        "0xe50fa9b3c56ffb159cb0fca61f5c9d750e8128c8"
      )
    ).toBe(true);
  });

  it("strips chain-prefix from tokenId before whitelist lookup", () => {
    expect(
      isReceiptOfProtocol(
        "GM",
        "arb_gmx2",
        "arb:0x70d95587d40a2caf56bd97485ab3eec10bee6336"
      )
    ).toBe(true);
  });
});

describe("isReceiptOfProtocol — Aave patterns", () => {
  it.each(["aUSDC", "aWETH", "aArbUSDC", "aEthWETH", "aPolUSDC"])(
    "%s is receipt in aave-v3",
    (sym) => {
      expect(isReceiptOfProtocol(sym, "aave-v3")).toBe(true);
    }
  );

  it("variable/stable debt symbols are receipts in aave", () => {
    expect(isReceiptOfProtocol("variableDebtArbUSDC", "aave-v3")).toBe(true);
    expect(isReceiptOfProtocol("stableDebtUSDC", "aave-v3")).toBe(true);
  });

  it("USDC / ETH are NOT receipts in aave (underlying)", () => {
    expect(isReceiptOfProtocol("USDC", "aave-v3")).toBe(false);
    expect(isReceiptOfProtocol("WETH", "aave-v3")).toBe(false);
  });
});

describe("isReceiptOfProtocol — Morpho Blue is receipt-less", () => {
  it("GLV is NOT a receipt in morpho-blue (used as collateral)", () => {
    expect(isReceiptOfProtocol("GLV [WETH-USDC]", "morpho-blue")).toBe(false);
  });

  it("aUSDC is NOT a receipt in morpho-blue", () => {
    expect(isReceiptOfProtocol("aUSDC", "morpho-blue")).toBe(false);
  });

  it("Any token (even ones that look like receipts) is underlying in morpho", () => {
    expect(isReceiptOfProtocol("stETH", "arb_morpho-blue")).toBe(false);
    expect(isReceiptOfProtocol("UNI-V2", "morpho")).toBe(false);
  });
});

describe("isReceiptOfProtocol — Compound", () => {
  it.each(["cUSDC", "cETH", "cDAI", "cWBTC"])(
    "%s is receipt in compound",
    (sym) => {
      expect(isReceiptOfProtocol(sym, "compound-v3")).toBe(true);
    }
  );

  it("USDC is NOT receipt in compound", () => {
    expect(isReceiptOfProtocol("USDC", "compound-v3")).toBe(false);
  });
});

describe("isReceiptOfProtocol — Fluid fVLT", () => {
  it("FVLT is receipt", () => {
    expect(isReceiptOfProtocol("FVLT", "arb_fluid")).toBe(true);
    expect(isReceiptOfProtocol("fVLT-1", "arb_fluid")).toBe(true);
  });

  it("USDC is NOT receipt in fluid", () => {
    expect(isReceiptOfProtocol("USDC", "arb_fluid")).toBe(false);
  });
});

describe("isReceiptOfProtocol — GMX / GMSOL", () => {
  it.each(["GM", "GM [BTC]", "GM:ETH/USD", "GLV", "GLV(Forex)", "GLP"])(
    "%s is receipt in gmx",
    (sym) => {
      expect(isReceiptOfProtocol(sym, "arb_gmx2")).toBe(true);
    }
  );

  it("works for gmsol prefix too", () => {
    expect(isReceiptOfProtocol("GM [SOL]", "sol_gmsol")).toBe(true);
  });

  it("USDC is NOT receipt in gmx", () => {
    expect(isReceiptOfProtocol("USDC", "arb_gmx2")).toBe(false);
  });
});

describe("isReceiptOfProtocol — Flash Trade FLP", () => {
  it("FLP is receipt", () => {
    expect(isReceiptOfProtocol("FLP", "flash-trade")).toBe(true);
  });

  it("USDC is NOT receipt in flash trade", () => {
    expect(isReceiptOfProtocol("USDC", "flash-trade")).toBe(false);
  });
});

describe("isReceiptOfProtocol — Liquid staking", () => {
  it.each([
    ["STETH", "lido"],
    ["WSTETH", "lido"],
    ["RETH", "rocket-pool"],
    ["EETH", "etherfi"],
    ["WEETH", "etherfi"],
    ["EZETH", "renzo"],
    ["RSETH", "kelp"],
    ["SWETH", "eigenlayer"],
  ])("%s is receipt in %s", (sym, pid) => {
    expect(isReceiptOfProtocol(sym, pid)).toBe(true);
  });

  it("ETH is NOT receipt in lido (underlying)", () => {
    expect(isReceiptOfProtocol("ETH", "lido")).toBe(false);
  });
});

describe("isReceiptOfProtocol — LBT / Pendle / Uniswap-family", () => {
  it("LBT (Trader Joe Liquidity Book) is receipt", () => {
    expect(isReceiptOfProtocol("LBT", "traderjoe")).toBe(true);
    expect(isReceiptOfProtocol("LBT-foo", "lfj")).toBe(true);
  });

  it("Pendle PT/YT are receipts", () => {
    expect(isReceiptOfProtocol("PT-eETH", "pendle")).toBe(true);
    expect(isReceiptOfProtocol("YT-sUSDE", "pendle")).toBe(true);
  });

  it("Pendle USDC is NOT receipt", () => {
    expect(isReceiptOfProtocol("USDC", "pendle")).toBe(false);
  });

  it("UNI-V2 / SLP / CRV-LP / BPT / CAKE-LP are receipts in their dex", () => {
    expect(isReceiptOfProtocol("UNI-V2", "uniswap")).toBe(true);
    expect(isReceiptOfProtocol("SLP", "sushiswap")).toBe(true);
    expect(isReceiptOfProtocol("CRV-LP", "curve")).toBe(true);
    expect(isReceiptOfProtocol("BPT-Aave", "balancer")).toBe(true);
    expect(isReceiptOfProtocol("CAKE-LP", "pancakeswap")).toBe(true);
  });
});

describe("isReceiptOfProtocol — unknown protocol", () => {
  it("returns false for unknown protocols (safe default)", () => {
    expect(isReceiptOfProtocol("WeirdToken", "totally-unknown-proto")).toBe(
      false
    );
    expect(isReceiptOfProtocol("stETH", "totally-unknown-proto")).toBe(false);
  });

  it("returns false for empty symbol or protocol", () => {
    expect(isReceiptOfProtocol("", "aave-v3")).toBe(false);
    expect(isReceiptOfProtocol("aUSDC", "")).toBe(false);
  });
});

describe("isDebtReceiptOfProtocol", () => {
  it("Aave variableDebt / stableDebt are debt-receipts", () => {
    expect(isDebtReceiptOfProtocol("variableDebtArbUSDC", "aave-v3")).toBe(
      true
    );
    expect(isDebtReceiptOfProtocol("stableDebtUSDC", "aave-v3")).toBe(true);
  });

  it("aTokens are NOT debt-receipts (supply, not debt)", () => {
    expect(isDebtReceiptOfProtocol("aUSDC", "aave-v3")).toBe(false);
    expect(isDebtReceiptOfProtocol("aArbWETH", "aave-v3")).toBe(false);
  });

  it("Compound has no debt-receipts", () => {
    expect(isDebtReceiptOfProtocol("cUSDC", "compound-v3")).toBe(false);
  });

  it("returns false for empty input", () => {
    expect(isDebtReceiptOfProtocol("", "aave-v3")).toBe(false);
    expect(isDebtReceiptOfProtocol("variableDebtUSDC", "")).toBe(false);
  });
});

describe("classifyTokenRole — dispatcher", () => {
  it("returns 'receipt' for known receipt symbols", () => {
    expect(
      classifyTokenRole(
        { symbol: "aUSDC", isProtocolToken: true },
        "aave-v3"
      )
    ).toBe("receipt");
  });

  it("returns 'underlying' for known underlying in same protocol", () => {
    expect(
      classifyTokenRole(
        { symbol: "USDC", isProtocolToken: false },
        "aave-v3"
      )
    ).toBe("underlying");
  });

  it("returns 'underlying' for GLV-in-morpho (NOT receipt of morpho)", () => {
    // The whole reason this module exists: GLV is a protocol-token globally,
    // but it's collateral in morpho-blue, not a morpho receipt.
    expect(
      classifyTokenRole(
        { symbol: "GLV [WETH-USDC]", isProtocolToken: true },
        "morpho-blue"
      )
    ).toBe("underlying");
  });

  it("with no protocolId, falls back to global isProtocolToken flag", () => {
    expect(
      classifyTokenRole({ symbol: "aUSDC", isProtocolToken: true }, null)
    ).toBe("receipt");
    expect(
      classifyTokenRole({ symbol: "USDC", isProtocolToken: false }, undefined)
    ).toBe("underlying");
  });
});
