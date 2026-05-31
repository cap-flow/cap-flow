/**
 * Pure pricing helpers — shared UCB engine (A0). Moved verbatim from
 * `apps/web/src/lib/defillama.ts`; the fetch/localStorage DefiLlama client
 * stays in web and re-exports these. No I/O here — only key-formatting and
 * (chain, tokenId, symbol) → DefiLlama coin-id mapping.
 *
 * The key format (`{coin}|{bucketTs}`) is a load-bearing invariant: the web
 * fetch client WRITES maps with `cacheKeyFor`, and `priceFromMap` READS them.
 * Both now come from this single source so they can never drift.
 */

const HOUR = 3600;

/** Округление timestamp вниз до часа — для дедупликации запросов. */
export function bucketTs(ts: number): number {
  return Math.floor(ts / HOUR) * HOUR;
}

export const cacheKeyFor = (coin: string, ts: number): string =>
  `${coin}|${bucketTs(ts)}`;

/* ---------------------- mapping chain/token → coin ---------------------- */

/**
 * Нативный токен сети → его DefiLlama-coin id. Native ETH у нас в DeBank
 * приходит с `tokenId === chain` (например `tokenId: "arb"`, `chain: "arb"`).
 */
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
  // Top-tier EVM
  eth: "ethereum",
  arb: "arbitrum",
  op: "optimism",
  base: "base",
  matic: "polygon",
  bsc: "bsc",
  avax: "avax",
  ftm: "fantom",
  // Расширенный список — DefiLlama поддерживает ~150 chains.
  // DeBank chain codes → DefiLlama chain names.
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
  // Non-EVM
  sol: "solana",
};

/**
 * Map (chain, tokenId, symbol) → DefiLlama coin id, или null если не знаем.
 *
 *  - `tokenId === chain` → нативный токен сети (Native ETH, MATIC, SOL).
 *  - EVM-адрес контракта (`0x...`) → `{llamaChain}:{address}`
 *  - Solana mint (base58) → `solana:{mint}`
 */
export function defillamaCoinKey(
  chain: string,
  tokenId: string | null | undefined,
  symbol?: string,
): string | null {
  if (!tokenId) return null;
  // Native: tokenId совпадает с chain.
  if (tokenId === chain) {
    return NATIVE_COIN[chain] ?? null;
  }
  if (tokenId === "eth") return NATIVE_COIN.eth!;
  // EUR-pegged stablecoins: используем CoinGecko EUR feed (универсальный
  // EUR/USD rate) ВМЕСТО chain-specific contract. Иначе DefiLlama для
  // EURC на Base/etc. может не иметь цен → fallback на DeBank current
  // spot ($1.00 — неверно для EUR-pegged tokens).
  if (symbol) {
    const sym = symbol.toUpperCase();
    if (sym === "EURC" || sym === "EUROC") return "coingecko:euro-coin";
    if (sym === "EURE") return "coingecko:monerium-eur-money";
    if (sym === "EURS") return "coingecko:stasis-eurs";
    if (sym === "EURT") return "coingecko:tether-eurt";
    if (sym === "AGEUR") return "coingecko:ageur";
    if (sym === "EURI") return "coingecko:eurite";
  }
  // EVM address
  if (/^0x[0-9a-fA-F]{40}$/.test(tokenId)) {
    const llamaChain = CHAIN_TO_LLAMA[chain];
    if (!llamaChain) return null;
    return `${llamaChain}:${tokenId.toLowerCase()}`;
  }
  // Solana mint (base58 ~ 32-44 chars)
  if (chain === "sol" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(tokenId)) {
    return `solana:${tokenId}`;
  }
  // Fallback по symbol — некоторые DeBank tokenIds выглядят как `{chain}_{contract}` или просто prefix.
  if (symbol) {
    const sym = symbol.toUpperCase();
    if (sym === "ETH" || sym === "WETH") return NATIVE_COIN.eth!;
    if (sym === "SOL") return NATIVE_COIN.sol!;
    if (sym === "BTC" || sym === "WBTC") return "coingecko:bitcoin";
  }
  return null;
}

/** Хелпер: достать цену по `(coin, timestamp)` из ранее загруженного результата. */
export function priceFromMap(
  map: Map<string, number>,
  coin: string,
  timestamp: number,
): number | null {
  const k = cacheKeyFor(coin, timestamp);
  return map.get(k) ?? null;
}

/**
 * UCB D9: fallback к ближайшему по времени bucket'у для того же coin'а.
 *
 * DefiLlama hist-цены — sparse: для редких токенов или экстремальных дат
 * может не быть exact-bucket match'а, и `priceFromMap` возвращает null.
 * Это приводит к unknown cost basis для transfer_in / bridge_in / claim.
 *
 * Эта функция расширяет lookup: если exact miss, ищем ближайший bucket
 * ±maxOffsetHours (default 7 days = 168h). Возвращает цену из ближайшего
 * найденного bucket'а; null если ни одного в окне.
 *
 * Не используется для time-sensitive расчётов (PnL, fees APR), только
 * для cost basis fallback — где иметь approximate price лучше чем 0.
 */
export function priceFromMapNearest(
  map: Map<string, number>,
  coin: string,
  timestamp: number,
  maxOffsetHours = 24 * 7,
): { readonly price: number; readonly offsetHours: number } | null {
  // Fast-path: exact hit.
  const exact = priceFromMap(map, coin, timestamp);
  if (exact != null && exact > 0) return { price: exact, offsetHours: 0 };

  const targetBucket = bucketTs(timestamp);
  const prefix = `${coin}|`;
  let best: { price: number; offsetHours: number } | null = null;

  // Linear scan по ключам — O(n_buckets). Для типичной session (~100-500
  // pairs) практически instant. Если в будущем станет hot — построим
  // per-coin sorted index в init-time.
  for (const [k, v] of map) {
    if (!k.startsWith(prefix)) continue;
    if (v <= 0) continue;
    const bucket = Number(k.slice(prefix.length));
    if (!Number.isFinite(bucket)) continue;
    const offsetHours = Math.abs(bucket - targetBucket) / HOUR;
    if (offsetHours > maxOffsetHours) continue;
    if (!best || offsetHours < best.offsetHours) {
      best = { price: v, offsetHours };
    }
  }
  return best;
}
