import { describe, expect, it } from "vitest";

import {
  SOL_CEX_ADDRESSES,
  SOL_NATIVE_MINT,
  classifySolSource,
  isSolCexAddress,
  isStableMint,
  looksLikeSpam,
  positionForMint,
  priceForMint,
  symbolForMint,
} from "./spl_tokens.js";

describe("symbolForMint", () => {
  it("returns known symbol for native SOL", () => {
    expect(symbolForMint(SOL_NATIVE_MINT)).toBe("SOL");
  });

  it("returns known SPL symbols", () => {
    expect(symbolForMint("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")).toBe(
      "USDC"
    );
    expect(symbolForMint("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB")).toBe(
      "USDT"
    );
    expect(symbolForMint("J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn")).toBe(
      "JitoSOL"
    );
  });

  it("returns truncated mint for unknown", () => {
    expect(symbolForMint("AbcdefghijklmnopqrstuvwxyzZYXWvu")).toBe("Abcd…XWvu");
  });
});

describe("isStableMint", () => {
  it("is true for USDC/USDT/PYUSD/USDH", () => {
    expect(isStableMint("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")).toBe(
      true
    );
    expect(isStableMint("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB")).toBe(
      true
    );
    expect(isStableMint("2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo")).toBe(
      true
    );
  });

  it("is false for SOL / unknown", () => {
    expect(isStableMint(SOL_NATIVE_MINT)).toBe(false);
    expect(isStableMint("zzzz-unknown")).toBe(false);
  });
});

describe("priceForMint", () => {
  it("returns amount × 1 for stables", () => {
    expect(
      priceForMint("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", 100)
    ).toBe(100);
    expect(
      priceForMint("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", 250)
    ).toBe(250);
  });

  it("returns null for non-stable known mints", () => {
    expect(priceForMint(SOL_NATIVE_MINT, 1)).toBeNull();
    expect(
      priceForMint("JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN", 100)
    ).toBeNull();
  });

  it("returns null for unknown mints", () => {
    expect(priceForMint("zzzz-unknown", 100)).toBeNull();
  });
});

describe("classifySolSource", () => {
  it.each([
    ["JUPITER", "Jupiter", "dex"],
    ["RAYDIUM", "Raydium", "dex"],
    ["ORCA", "Orca", "dex"],
    ["SOLEND", "Solend", "lending"],
    ["KAMINO", "Kamino", "lending"],
    ["MARGINFI", "MarginFi", "lending"],
    ["MARINADE_FINANCE", "Marinade", "staking"],
    ["JITO", "Jito", "staking"],
    ["DRIFT", "Drift", "perp"],
    ["WORMHOLE", "Wormhole", "bridge"],
    ["FLASH_TRADE", "Flash Trade", "yield"],
    ["FLASHTRADE", "Flash Trade", "yield"],
  ])("%s → %s/%s", (src, name, cat) => {
    const r = classifySolSource(src);
    expect(r?.name).toBe(name);
    expect(r?.category).toBe(cat);
    expect(r?.id).toBe(src);
  });

  it("is case-insensitive on input", () => {
    const r = classifySolSource("jupiter");
    expect(r?.category).toBe("dex");
    expect(r?.id).toBe("jupiter");
  });

  it("returns 'other' for unknown sources", () => {
    const r = classifySolSource("MYSTERY_PROGRAM");
    expect(r?.category).toBe("other");
    expect(r?.id).toBe("MYSTERY_PROGRAM");
  });

  it("returns null for null/empty", () => {
    expect(classifySolSource(null)).toBeNull();
    expect(classifySolSource(undefined)).toBeNull();
    expect(classifySolSource("")).toBeNull();
  });
});

describe("isSolCexAddress", () => {
  it("identifies Binance Solana addresses", () => {
    const r = isSolCexAddress("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM");
    expect(r?.name).toBe("Binance");
  });

  it("identifies OKX / Coinbase / Kraken / Bybit / MEXC / Gate.io", () => {
    expect(
      isSolCexAddress("5VCwKtCXgCJ6kit5FybXjvriW3xELsFDhYrPSqtJNmcD")?.name
    ).toBe("OKX");
    expect(
      isSolCexAddress("H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS")?.name
    ).toBe("Coinbase");
    expect(
      isSolCexAddress("FWznbcNXWQuHTawe9RxvQ2LdCENssh12dsznf4RiouN5")?.name
    ).toBe("Kraken");
    expect(
      isSolCexAddress("AC5RDfQFmDS1deWZos921JfqscXdByf8BKHs5ACWjtW2")?.name
    ).toBe("Bybit");
  });

  it("returns null for non-CEX addresses", () => {
    expect(isSolCexAddress("random-address")).toBeNull();
  });

  it("exports the full registry for inspection", () => {
    expect(Object.keys(SOL_CEX_ADDRESSES).length).toBeGreaterThan(5);
  });
});

describe("positionForMint", () => {
  it("returns staking position for mSOL/JitoSOL/bSOL", () => {
    expect(
      positionForMint("mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So")?.category
    ).toBe("staking");
    expect(
      positionForMint("J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn")?.category
    ).toBe("staking");
  });

  it("returns LP for JLP", () => {
    expect(
      positionForMint("27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4")?.category
    ).toBe("lp");
  });

  it("Kamino kTokens detected by symbol heuristic", () => {
    const r = positionForMint("unknown-mint", "kSOL");
    expect(r?.protocol).toBe("Kamino");
    expect(r?.category).toBe("lending");
  });

  it("MarginFi MFI tokens", () => {
    const r = positionForMint("unknown-mint", "MFI");
    expect(r?.protocol).toBe("MarginFi");
  });

  it("returns null for unknown without symbol heuristic", () => {
    expect(positionForMint("unknown-mint")).toBeNull();
    expect(positionForMint("unknown-mint", "USDC")).toBeNull();
  });
});

describe("looksLikeSpam", () => {
  it("blacklist symbols GM / GN / AIRDROP / CLAIM", () => {
    expect(looksLikeSpam("GM")).toBe(true);
    expect(looksLikeSpam("GN")).toBe(true);
    expect(looksLikeSpam("AIRDROP")).toBe(true);
    expect(looksLikeSpam("CLAIM")).toBe(true);
  });

  it("1-2 letter symbols are spam", () => {
    expect(looksLikeSpam("X")).toBe(true);
    expect(looksLikeSpam("AB")).toBe(true);
  });

  it("keywords in symbol", () => {
    expect(looksLikeSpam("FREE-CLAIM")).toBe(true);
    expect(looksLikeSpam("AIRDROP-2024")).toBe(true);
    expect(looksLikeSpam("VISIT-NOW")).toBe(true);
  });

  it("URL-like symbols", () => {
    expect(looksLikeSpam("www.4base.cfd")).toBe(true);
    expect(looksLikeSpam("foo.io")).toBe(true);
    expect(looksLikeSpam("t.me/SOL_POOL")).toBe(true);
    expect(looksLikeSpam("https://scam.com")).toBe(true);
  });

  it("URL/keywords in name field", () => {
    expect(looksLikeSpam("TOKEN", "Visit foo.com to claim")).toBe(true);
    expect(looksLikeSpam("TOKEN", "Free claim airdrop")).toBe(true);
  });

  it("legit symbols pass through", () => {
    expect(looksLikeSpam("USDC")).toBe(false);
    expect(looksLikeSpam("JUP")).toBe(false);
    expect(looksLikeSpam("BONK")).toBe(false);
    expect(looksLikeSpam("JitoSOL")).toBe(false);
  });

  it("empty symbol is not spam", () => {
    expect(looksLikeSpam("")).toBe(false);
  });
});
