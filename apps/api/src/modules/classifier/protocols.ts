/**
 * Protocol & token-symbol heuristics — server port of
 * `apps/web/src/lib/portfolio/protocols.ts` (P5.1).
 *
 * Pure functions, no I/O. Drives the chain classifier (P5.3 EVM, P5.4
 * Solana) — it asks `classifyProtocol(projectId, projectName)` to decide
 * whether a tx hit a lending pool, DEX, perp protocol etc., and
 * `isStableSymbol` / `isProtocolToken` / `isLendingReceipt` to label
 * individual token movements.
 */

import type { ProtocolCategory, ProtocolInfo } from "./types.js";

const PATTERNS: { match: RegExp; category: ProtocolCategory; name?: string }[] =
  [
    // Lending
    { match: /aave/i, category: "lending", name: "Aave" },
    { match: /\bfluid\b/i, category: "lending", name: "Fluid" },
    { match: /compound/i, category: "lending", name: "Compound" },
    { match: /morpho/i, category: "lending", name: "Morpho" },
    { match: /spark/i, category: "lending", name: "Spark" },
    { match: /radiant/i, category: "lending", name: "Radiant" },
    { match: /benqi/i, category: "lending", name: "Benqi" },
    { match: /silo/i, category: "lending", name: "Silo" },
    { match: /euler/i, category: "lending", name: "Euler" },
    { match: /venus/i, category: "lending", name: "Venus" },

    // CDP
    { match: /makerdao|sky\b/i, category: "cdp", name: "MakerDAO/Sky" },
    { match: /liquity/i, category: "cdp", name: "Liquity" },

    // DEX / LP
    { match: /uniswap/i, category: "dex", name: "Uniswap" },
    { match: /sushi/i, category: "dex", name: "SushiSwap" },
    { match: /pancake/i, category: "dex", name: "PancakeSwap" },
    { match: /curve/i, category: "dex", name: "Curve" },
    { match: /balancer/i, category: "dex", name: "Balancer" },
    { match: /1inch/i, category: "dex", name: "1inch" },
    { match: /kyber/i, category: "dex", name: "Kyberswap" },
    { match: /paraswap/i, category: "dex", name: "ParaSwap" },
    { match: /odos/i, category: "dex", name: "Odos" },
    { match: /matcha|0x\b/i, category: "dex", name: "0x / Matcha" },
    { match: /camelot/i, category: "dex", name: "Camelot" },
    { match: /trader.?joe/i, category: "dex", name: "Trader Joe" },
    { match: /velodrome/i, category: "dex", name: "Velodrome" },
    { match: /aerodrome/i, category: "dex", name: "Aerodrome" },

    // Staking / LST / LRT
    { match: /lido/i, category: "staking", name: "Lido" },
    { match: /rocket.?pool/i, category: "staking", name: "Rocket Pool" },
    { match: /frax.?eth|sfrxeth/i, category: "staking", name: "Frax ETH" },
    { match: /ether\.?fi|etherfi/i, category: "restaking", name: "Ether.fi" },
    { match: /eigen/i, category: "restaking", name: "EigenLayer" },
    { match: /kelp/i, category: "restaking", name: "Kelp" },
    { match: /renzo/i, category: "restaking", name: "Renzo" },
    { match: /swell/i, category: "restaking", name: "Swell" },

    // Yield / pool deposits
    { match: /pendle/i, category: "yield", name: "Pendle" },
    { match: /convex/i, category: "yield", name: "Convex" },
    { match: /aura/i, category: "yield", name: "Aura" },
    { match: /yearn/i, category: "yield", name: "Yearn" },
    { match: /beefy/i, category: "yield", name: "Beefy" },
    { match: /\bgmx\b/i, category: "yield", name: "GMX" },
    { match: /flash.?trade/i, category: "yield", name: "Flash Trade" },
    {
      match: /\bjlp\b|jupiter.?lp|jupiter perpetual/i,
      category: "yield",
      name: "Jupiter LP",
    },

    // Perps / derivatives
    { match: /hyperliquid/i, category: "perp", name: "Hyperliquid" },
    { match: /dydx/i, category: "perp", name: "dYdX" },
    { match: /gains/i, category: "perp", name: "Gains Network" },
    { match: /vertex/i, category: "perp", name: "Vertex" },
    { match: /synthetix/i, category: "perp", name: "Synthetix" },

    // Bridges
    { match: /stargate/i, category: "bridge", name: "Stargate" },
    { match: /across/i, category: "bridge", name: "Across" },
    { match: /synapse/i, category: "bridge", name: "Synapse" },
    { match: /cbridge|celer/i, category: "bridge", name: "Celer cBridge" },
    { match: /hop/i, category: "bridge", name: "Hop" },
    { match: /connext/i, category: "bridge", name: "Connext" },
    { match: /layerzero/i, category: "bridge", name: "LayerZero" },
  ];

export function classifyProtocol(
  projectId: string | null | undefined,
  projectName: string | null | undefined
): ProtocolInfo | null {
  if (!projectId && !projectName) return null;
  const haystack = `${projectId ?? ""} ${projectName ?? ""}`;
  for (const p of PATTERNS) {
    if (p.match.test(haystack)) {
      return {
        id: projectId ?? p.name ?? "unknown",
        name: projectName || p.name || projectId || "Unknown",
        category: p.category,
      };
    }
  }
  if (projectId || projectName) {
    return {
      id: projectId ?? projectName!,
      name: projectName ?? projectId!,
      category: "other",
    };
  }
  return null;
}

const STABLES = new Set([
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
  "SUSDE",
  "USDD",
  "GUSD",
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
]);

const EUR_STABLES = new Set([
  "EURC",
  "EUROC",
  "EURE",
  "EURS",
  "AGEUR",
  "EURT",
  "EURI",
  "EUROE",
]);

export function isEurStableSymbol(symbol: string): boolean {
  if (!symbol) return false;
  return EUR_STABLES.has(symbol.toUpperCase());
}

export function tokenFamily(symbol: string): string {
  if (!symbol) return "";
  let s = symbol.toUpperCase().trim();
  s = s.replace(/₮/g, "T");
  s = s.replace(/\.[A-Z0-9]+$/, "");
  s = s.replace(/(?<=[A-Z])0+$/, "");
  if (s === "WETH") return "ETH";
  if (s === "WBTC" || s === "TBTC" || s === "CBBTC") return "BTC";
  if (s === "WSOL") return "SOL";
  if (s === "WBNB") return "BNB";
  if (s === "WMATIC") return "MATIC";
  if (s === "WAVAX") return "AVAX";
  return s;
}

export function isStableSymbol(symbol: string): boolean {
  if (!symbol) return false;
  const upper = symbol.toUpperCase();
  if (STABLES.has(upper)) return true;
  const normalized = upper.replace(/₮/g, "T");
  if (STABLES.has(normalized)) return true;
  if (/^(USDT|USDC|DAI|USDE)(\.|[0-9]|$)/.test(normalized)) return true;
  return false;
}

const PROTOCOL_TOKEN_PREFIXES_SENSITIVE = [
  /^a(Arb|Eth|Opt|Pol|Bsc|Avax|Base|Met|Sca|Lin)[A-Z]/,
  /^a(USDC|USDT|DAI|WETH|ETH|WBTC|BTC|EURS|LUSD|FRAX|TUSD|sUSDC|sUSDT)/,
  /^variableDebt/,
  /^stableDebt/,
  /^c(USDC|USDT|DAI|WETH|ETH|WBTC|BTC|UNI|LINK|COMP)/,
  /^c[A-Z][a-zA-Z]+v3$/,
];

const PROTOCOL_TOKEN_PREFIXES_UPPER = [
  /^MOO/,
  /^YV/,
  /^XV/,
  /^STETH$|^WSTETH$|^RETH$|^SFRXETH$|^EETH$|^WEETH$|^EZETH$|^RSETH$|^SWETH$|^OSETH$/,
  /^SLP$/,
  /^UNI-V/,
  /^CRV-?LP/,
  /^BPT/,
  /^CAKE-LP/,
  /VELO-/,
  /AERO-/,
  /^GM($|[\s:[(])/,
  /^GLV($|[\s:[(])/,
  /^GLP$/,
  /^FLP($|[\s:[])/,
  /^FVLT/,
  /^LBT$/,
  /^PT-/,
  /^YT-/,
];

export function isProtocolToken(symbol: string): boolean {
  if (!symbol) return false;
  for (const re of PROTOCOL_TOKEN_PREFIXES_SENSITIVE) {
    if (re.test(symbol)) return true;
  }
  const upper = symbol.toUpperCase();
  for (const re of PROTOCOL_TOKEN_PREFIXES_UPPER) {
    if (re.test(upper)) return true;
  }
  return false;
}

export function isLendingReceipt(symbol: string): boolean {
  if (!symbol) return false;
  for (const re of PROTOCOL_TOKEN_PREFIXES_SENSITIVE) {
    if (re.test(symbol)) return true;
  }
  return false;
}
