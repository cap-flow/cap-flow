/**
 * Solana SPL-tokens registry — port of
 * `apps/web/src/lib/portfolio/spl_tokens.ts` (P5.4).
 *
 * Static mapping `mint → symbol/decimals/isStable/position`, plus
 * source-classifier `classifySolSource()` (Helius `source` → ProtocolInfo)
 * and CEX-address registry `isSolCexAddress()`. Pure functions only.
 */

import type { ProtocolCategory, ProtocolInfo } from "./types.js";

interface SplMeta {
  symbol: string;
  decimals: number;
  isStable?: boolean;
  stablePrice?: number;
  position?: {
    protocol: string;
    category: "staking" | "restaking" | "lp" | "lending" | "vault";
  };
}

export const SOL_NATIVE_MINT = "So11111111111111111111111111111111111111112";

export const SPL_TOKENS: Record<string, SplMeta> = {
  [SOL_NATIVE_MINT]: { symbol: "SOL", decimals: 9 },

  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: {
    symbol: "USDC",
    decimals: 6,
    isStable: true,
    stablePrice: 1,
  },
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: {
    symbol: "USDT",
    decimals: 6,
    isStable: true,
    stablePrice: 1,
  },
  "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo": {
    symbol: "PYUSD",
    decimals: 6,
    isStable: true,
    stablePrice: 1,
  },
  USDH1SM1ojwWUga67PGrgFWUHibbjqMvuMaDkRJTgkX: {
    symbol: "USDH",
    decimals: 6,
    isStable: true,
    stablePrice: 1,
  },

  mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So: {
    symbol: "mSOL",
    decimals: 9,
    position: { protocol: "Marinade", category: "staking" },
  },
  "7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj": {
    symbol: "stSOL",
    decimals: 9,
    position: { protocol: "Lido (Solana)", category: "staking" },
  },
  J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn: {
    symbol: "JitoSOL",
    decimals: 9,
    position: { protocol: "Jito", category: "staking" },
  },
  bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1: {
    symbol: "bSOL",
    decimals: 9,
    position: { protocol: "Blaze Stake", category: "staking" },
  },
  "27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4": {
    symbol: "JLP",
    decimals: 6,
    position: { protocol: "Jupiter LP", category: "lp" },
  },

  JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN: { symbol: "JUP", decimals: 6 },
  WENWENvqqNya429ubCdR81ZmD69brwQaaBYY6p3LCpk: { symbol: "WEN", decimals: 5 },
  EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm: { symbol: "WIF", decimals: 6 },
  DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263: { symbol: "BONK", decimals: 5 },
  HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3: { symbol: "PYTH", decimals: 6 },
  rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof: { symbol: "RNDR", decimals: 8 },
  "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs": {
    symbol: "ETH (W)",
    decimals: 8,
  },
  "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh": {
    symbol: "WBTC (W)",
    decimals: 8,
  },
};

export function symbolForMint(mint: string): string {
  return SPL_TOKENS[mint]?.symbol ?? `${mint.slice(0, 4)}…${mint.slice(-4)}`;
}

const SPAM_SYMBOL_BLACKLIST = new Set(["GM", "GN", "WL", "AIRDROP", "CLAIM"]);

export function looksLikeSpam(symbol: string, name?: string): boolean {
  if (!symbol) return false;
  const s = symbol.trim();
  const su = s.toUpperCase();

  if (SPAM_SYMBOL_BLACKLIST.has(su)) return true;
  if (/^[A-Z]{1,2}$/.test(su)) return true;
  if (/CLAIM|AIRDROP|DISTRIBUTE|REWARD\s*FREE|VISIT|CHECK/i.test(s))
    return true;
  if (
    /\.(com|ai|xyz|net|org|io|cfd|app|click|site|info|me|live|fun)\b/i.test(s)
  )
    return true;
  if (/^https?:\/\/|^www\./i.test(s)) return true;
  if (/t\.me\//i.test(s)) return true;

  const n = (name ?? "").toLowerCase();
  if (
    /\.(com|ai|xyz|net|org|io|cfd|app|click|site|info|me|live|fun)\b/.test(n)
  )
    return true;
  if (/visit|claim|airdrop|free \$|reward/i.test(n)) return true;
  return false;
}

export function positionForMint(
  mint: string,
  symbol?: string
):
  | {
      protocol: string;
      category: "staking" | "restaking" | "lp" | "lending" | "vault";
    }
  | null {
  const meta = SPL_TOKENS[mint];
  if (meta?.position) return meta.position;

  const s = (symbol ?? "").toUpperCase();
  if (/^K[A-Z]/.test(s)) return { protocol: "Kamino", category: "lending" };
  if (/^C[A-Z]/.test(s) && s.length <= 6)
    return { protocol: "Solend", category: "lending" };
  if (/^MFI/.test(s)) return { protocol: "MarginFi", category: "lending" };
  if (/SOL$/.test(s) && /^[ESJBR]/.test(s) && s !== "SOL")
    return { protocol: s.replace(/SOL$/, ""), category: "staking" };
  return null;
}

export function isStableMint(mint: string): boolean {
  return Boolean(SPL_TOKENS[mint]?.isStable);
}

export function priceForMint(mint: string, amount: number): number | null {
  const meta = SPL_TOKENS[mint];
  if (!meta) return null;
  if (meta.stablePrice) return meta.stablePrice * amount;
  return null;
}

const SOL_SOURCES: Record<
  string,
  { name: string; category: ProtocolCategory }
> = {
  JUPITER: { name: "Jupiter", category: "dex" },
  RAYDIUM: { name: "Raydium", category: "dex" },
  ORCA: { name: "Orca", category: "dex" },
  METEORA: { name: "Meteora", category: "dex" },
  PHOENIX: { name: "Phoenix", category: "dex" },
  LIFINITY: { name: "Lifinity", category: "dex" },
  ALDRIN: { name: "Aldrin", category: "dex" },
  DFLOW: { name: "DFlow", category: "dex" },
  STEPN: { name: "STEPN", category: "other" },

  FLASH_TRADE: { name: "Flash Trade", category: "yield" },
  FLASHTRADE: { name: "Flash Trade", category: "yield" },
  PARCL: { name: "Parcl", category: "perp" },

  SOLEND: { name: "Solend", category: "lending" },
  KAMINO: { name: "Kamino", category: "lending" },
  MANGO: { name: "Mango", category: "lending" },
  MARGINFI: { name: "MarginFi", category: "lending" },
  PORT_FINANCE: { name: "Port Finance", category: "lending" },
  FRANCIUM: { name: "Francium", category: "lending" },
  LARIX: { name: "Larix", category: "lending" },

  MARINADE_FINANCE: { name: "Marinade", category: "staking" },
  JITO: { name: "Jito", category: "staking" },
  LIDO: { name: "Lido (Solana)", category: "staking" },
  BLAZESTAKE: { name: "Blaze Stake", category: "staking" },

  DRIFT: { name: "Drift", category: "perp" },
  ZETA: { name: "Zeta", category: "perp" },
  MANGO_PERP: { name: "Mango Perp", category: "perp" },

  WORMHOLE: { name: "Wormhole", category: "bridge" },
  ALLBRIDGE: { name: "Allbridge", category: "bridge" },
  DEBRIDGE: { name: "deBridge", category: "bridge" },

  MAGIC_EDEN: { name: "Magic Eden", category: "other" },
  TENSOR: { name: "Tensor", category: "other" },

  SYSTEM_PROGRAM: { name: "System", category: "other" },
};

export function classifySolSource(
  source: string | null | undefined
): ProtocolInfo | null {
  if (!source) return null;
  const meta = SOL_SOURCES[source.toUpperCase()];
  if (!meta) return { id: source, name: source, category: "other" };
  return { id: source, name: meta.name, category: meta.category };
}

export const SOL_CEX_ADDRESSES: Record<string, string> = {
  "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM": "Binance",
  "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9": "Binance",
  FxteHmLwG9nk1eL4pjNve3Eub2goGkkz6g6TbvdmW46a: "Binance",
  "5VCwKtCXgCJ6kit5FybXjvriW3xELsFDhYrPSqtJNmcD": "OKX",
  H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS: "Coinbase",
  FWznbcNXWQuHTawe9RxvQ2LdCENssh12dsznf4RiouN5: "Kraken",
  AC5RDfQFmDS1deWZos921JfqscXdByf8BKHs5ACWjtW2: "Bybit",
  ASTyfSima4LLAdDgoFGkgqoKowG1LZFDr9fAQrg7iaJZ: "MEXC",
  GJRs4FwHtemZ5ZE9x3FNvJ8TMwitKTh21yxdRPqn7npE: "Gate.io",
};

export function isSolCexAddress(
  addr: string
): { id: string; name: string } | null {
  const name = SOL_CEX_ADDRESSES[addr];
  if (!name) return null;
  return { id: addr, name };
}
