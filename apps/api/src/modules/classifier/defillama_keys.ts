/**
 * DefiLlama coin-key + cache-key helpers — server port of pure subset of
 * `apps/web/src/lib/defillama.ts` (P5.5). The fetch/cache I/O lives in
 * P5.6 (`defillama_prices.ts`), but `defillamaCoinKey` and `priceFromMap`
 * are pure — used by LP attribution (P5.5) for historical price lookup.
 */

const HOUR = 3600;

const NATIVE_COIN: Record<string, string> = {
  eth: "coingecko:ethereum",
  arb: "arbitrum:0x0000000000000000000000000000000000000000",
  op: "optimism:0x0000000000000000000000000000000000000000",
  base: "base:0x0000000000000000000000000000000000000000",
  matic: "polygon:0x0000000000000000000000000000000000001010",
  bsc: "bsc:0x0000000000000000000000000000000000000000",
  avax: "avax:0x0000000000000000000000000000000000000000",
  ftm: "fantom:0x0000000000000000000000000000000000000000",
  sol: "coingecko:solana",
};

const CHAIN_TO_LLAMA: Record<string, string> = {
  eth: "ethereum",
  arb: "arbitrum",
  op: "optimism",
  base: "base",
  matic: "polygon",
  bsc: "bsc",
  avax: "avax",
  ftm: "fantom",
  linea: "linea",
  scrl: "scroll",
  blast: "blast",
  zksync: "era",
  zora: "zora",
  metis: "metis",
  manta: "manta",
  mode: "mode",
  mnt: "mantle",
  cro: "cronos",
  klay: "klaytn",
  kava: "kava",
  celo: "celo",
  moonbeam: "moonbeam",
  moonriver: "moonriver",
  hmy: "harmony",
  okt: "okexchain",
  movr: "moonriver",
  glmr: "moonbeam",
  bera: "berachain",
  sonic: "sonic",
  unichain: "unichain",
  hype: "hyperliquid",
  hyper: "hyperliquid",
  abs: "abstract",
  apechain: "apechain",
  taiko: "taiko",
  sol: "solana",
};

/** Bucket timestamp down to the nearest hour — dedupes hist-price requests. */
export function bucketTs(ts: number): number {
  return Math.floor(ts / HOUR) * HOUR;
}

export const cacheKeyFor = (coin: string, ts: number): string =>
  `${coin}|${bucketTs(ts)}`;

/**
 * Map (chain, tokenId, symbol) → DefiLlama coin id, or null when we can't
 * resolve. Priority:
 *   1. `tokenId === chain` → native token
 *   2. legacy `tokenId === "eth"` → eth native
 *   3. EUR-pegged stablecoins → coingecko EUR feeds
 *   4. EVM contract address (`0x{40}`) → `{llama}:{address}`
 *   5. Solana base58 mint → `solana:{mint}`
 *   6. Symbol fallback (ETH/WETH/SOL/BTC/WBTC)
 */
export function defillamaCoinKey(
  chain: string,
  tokenId: string | null | undefined,
  symbol?: string
): string | null {
  if (!tokenId) return null;
  if (tokenId === chain) return NATIVE_COIN[chain] ?? null;
  if (tokenId === "eth") return NATIVE_COIN["eth"]!;

  if (symbol) {
    const sym = symbol.toUpperCase();
    if (sym === "EURC" || sym === "EUROC") return "coingecko:euro-coin";
    if (sym === "EURE") return "coingecko:monerium-eur-money";
    if (sym === "EURS") return "coingecko:stasis-eurs";
    if (sym === "EURT") return "coingecko:tether-eurt";
    if (sym === "AGEUR") return "coingecko:ageur";
    if (sym === "EURI") return "coingecko:eurite";
  }

  if (/^0x[0-9a-fA-F]{40}$/.test(tokenId)) {
    const llamaChain = CHAIN_TO_LLAMA[chain];
    if (!llamaChain) return null;
    return `${llamaChain}:${tokenId.toLowerCase()}`;
  }

  if (chain === "sol" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(tokenId)) {
    return `solana:${tokenId}`;
  }

  if (symbol) {
    const sym = symbol.toUpperCase();
    if (sym === "ETH" || sym === "WETH") return NATIVE_COIN["eth"]!;
    if (sym === "SOL") return NATIVE_COIN["sol"]!;
    if (sym === "BTC" || sym === "WBTC") return "coingecko:bitcoin";
  }

  return null;
}

/** Lookup a price by `(coin, timestamp)` from a previously fetched map. */
export function priceFromMap(
  map: Map<string, number>,
  coin: string,
  timestamp: number
): number | null {
  return map.get(cacheKeyFor(coin, timestamp)) ?? null;
}
