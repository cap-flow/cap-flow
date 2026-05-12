/**
 * Shyft API клиент — Solana indexer с DeFi-aware parsing.
 *
 * Используется как **обогащение** Helius parsed history. В отличие от
 * Solscan Pro (где free tier ничего не даёт), Shyft Free tier разрешает
 * 1M req/мес — хватает с большим запасом.
 *
 * Ценное:
 *   - `/wallet/transaction_history` — parsed Solana tx с
 *     `protocol.name` ("METEORA_AMM", "RAYDIUM_AMM_V2", "JUPITER_AGG", …)
 *     и `type` ("SWAP", "STAKE", "UNSTAKE", "ADD_LIQ", "REMOVE_LIQ", …).
 *     Это покрывает гораздо больше DeFi-протоколов чем Helius parsed.
 *   - `/wallet/all_tokens` — токены кошелька с **полной metadata**
 *     (name, symbol, decimals, image). Используется как fallback для
 *     unknown SPL mints.
 *
 * Auth: header `x-api-key: <key>`.
 * Endpoint: `https://api.shyft.to/sol/v1/`
 * Документация: https://docs.shyft.to/
 */

const ENDPOINT = "https://api.shyft.to/sol/v1";
const TX_CACHE_KEY = "capflow.shyft_tx";
const TOKENS_CACHE_KEY = "capflow.shyft_tokens";
const CACHE_VERSION = 1;
const TX_CACHE_TTL_MS = 30 * 60 * 1000; // 30 минут — DeFi parsed чуть-чуть устаревает
const TOKENS_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 часа — metadata стабильная

export type ShyftTxType =
  | "SWAP"
  | "STAKE"
  | "UNSTAKE"
  | "ADD_LIQ"
  | "REMOVE_LIQ"
  | "DEPOSIT"
  | "WITHDRAW"
  | "TRANSFER"
  | "BORROW"
  | "REPAY"
  | "CLAIM"
  | string;

export interface ShyftTokenBalanceChange {
  address: string;
  decimals: number;
  changeAmount: number;
  preBalance: number;
  postBalance: number;
  mint: string;
  owner: string;
}

export interface ShyftTransaction {
  signature: string;
  /** Unix seconds. */
  timestamp: number;
  type: ShyftTxType;
  status: string;
  protocol?: {
    address: string;
    name: string;
  };
  fee: number;
  feePayer: string;
  tokenBalanceChanges: ShyftTokenBalanceChange[];
}

export interface ShyftTokenMeta {
  /** SPL mint address. */
  address: string;
  balance: number;
  associatedAccount: string;
  decimals: number;
  name: string;
  symbol: string;
  image?: string;
}

interface CacheEntry<T> {
  data: T;
  fetchedAt: number;
}

interface CacheShape<T> {
  v: number;
  byAddress: Record<string, CacheEntry<T>>;
}

function loadCache<T>(key: string): CacheShape<T> {
  if (typeof window === "undefined") return { v: CACHE_VERSION, byAddress: {} };
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return { v: CACHE_VERSION, byAddress: {} };
    const parsed = JSON.parse(raw) as CacheShape<T>;
    if (parsed.v !== CACHE_VERSION) return { v: CACHE_VERSION, byAddress: {} };
    return parsed;
  } catch {
    return { v: CACHE_VERSION, byAddress: {} };
  }
}

function saveCache<T>(key: string, cache: CacheShape<T>) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(cache));
  } catch {
    /* ignore quota */
  }
}

interface RawTxResponse {
  success: boolean;
  message?: string;
  result?: Array<{
    signature?: string;
    signatures?: string[];
    timestamp: string; // ISO 8601
    fee: number;
    fee_payer: string;
    type: string;
    status: string;
    protocol?: { address: string; name: string };
    token_balance_changes?: Array<{
      address: string;
      decimals: number;
      change_amount: number;
      pre_balance: number;
      post_balance: number;
      mint: string;
      owner: string;
    }>;
  }>;
}

function normalizeTransaction(
  raw: NonNullable<RawTxResponse["result"]>[number],
): ShyftTransaction {
  const sig = raw.signature ?? raw.signatures?.[0] ?? "";
  const ts = Math.floor(new Date(raw.timestamp).getTime() / 1000);
  return {
    signature: sig,
    timestamp: ts,
    type: raw.type,
    status: raw.status,
    ...(raw.protocol && {
      protocol: {
        address: raw.protocol.address,
        name: raw.protocol.name,
      },
    }),
    fee: raw.fee,
    feePayer: raw.fee_payer,
    tokenBalanceChanges: (raw.token_balance_changes ?? []).map((c) => ({
      address: c.address,
      decimals: c.decimals,
      changeAmount: c.change_amount,
      preBalance: c.pre_balance,
      postBalance: c.post_balance,
      mint: c.mint,
      owner: c.owner,
    })),
  };
}

/**
 * Получить parsed transaction history кошелька.
 *
 * Pagination: Shyft использует `before` (signature) для seek. Мы тянем
 * до `maxTxs` (по умолчанию 500), чтобы покрыть основной use case без
 * слишком долгой загрузки.
 */
export async function fetchShyftTransactionHistory(args: {
  address: string;
  apiKey: string;
  signal?: AbortSignal;
  /** Максимальное число tx (защита от runaway). По умолчанию 500. */
  maxTxs?: number;
}): Promise<ShyftTransaction[]> {
  const { address, apiKey, signal, maxTxs = 500 } = args;
  if (!apiKey) return [];

  const cache = loadCache<ShyftTransaction[]>(TX_CACHE_KEY);
  const cached = cache.byAddress[address];
  if (cached && Date.now() - cached.fetchedAt < TX_CACHE_TTL_MS) {
    return cached.data;
  }

  const all: ShyftTransaction[] = [];
  let beforeSig: string | undefined;
  const PAGE_SIZE = 100;

  while (all.length < maxTxs) {
    const url =
      `${ENDPOINT}/wallet/transaction_history?network=mainnet-beta` +
      `&wallet=${encodeURIComponent(address)}&tx_num=${PAGE_SIZE}` +
      (beforeSig ? `&before_tx_signature=${beforeSig}` : "");
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { "x-api-key": apiKey },
        ...(signal ? { signal } : {}),
      });
    } catch (e) {
      if ((e as Error).name === "AbortError") throw e;
      break;
    }
    if (!res.ok) {
      console.warn(`Shyft API ${res.status} for ${address}:`, await res.text().catch(() => ""));
      break;
    }
    const json = (await res.json()) as RawTxResponse;
    if (!json.success || !json.result || json.result.length === 0) break;
    for (const r of json.result) all.push(normalizeTransaction(r));
    if (json.result.length < PAGE_SIZE) break;
    const lastTx = json.result[json.result.length - 1];
    beforeSig = lastTx?.signature ?? lastTx?.signatures?.[0];
    if (!beforeSig) break;
  }

  cache.byAddress[address] = { data: all, fetchedAt: Date.now() };
  saveCache(TX_CACHE_KEY, cache);
  return all;
}

interface RawTokensResponse {
  success: boolean;
  message?: string;
  result?: Array<{
    address: string;
    balance: number;
    associated_account: string;
    info: {
      decimals: number;
      name: string;
      symbol: string;
      image?: string;
    };
  }>;
}

/**
 * Получить metadata всех токенов кошелька.
 * Возвращает Map<mint, ShyftTokenMeta>.
 */
export async function fetchShyftTokenMeta(args: {
  address: string;
  apiKey: string;
  signal?: AbortSignal;
}): Promise<Map<string, ShyftTokenMeta>> {
  const { address, apiKey, signal } = args;
  const out = new Map<string, ShyftTokenMeta>();
  if (!apiKey) return out;

  const cache = loadCache<ShyftTokenMeta[]>(TOKENS_CACHE_KEY);
  const cached = cache.byAddress[address];
  if (cached && Date.now() - cached.fetchedAt < TOKENS_CACHE_TTL_MS) {
    for (const t of cached.data) out.set(t.address, t);
    return out;
  }

  try {
    const url =
      `${ENDPOINT}/wallet/all_tokens?network=mainnet-beta` +
      `&wallet=${encodeURIComponent(address)}`;
    const res = await fetch(url, {
      headers: { "x-api-key": apiKey },
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) {
      console.warn(`Shyft tokens ${res.status} for ${address}`);
      return out;
    }
    const json = (await res.json()) as RawTokensResponse;
    if (!json.success || !json.result) return out;
    const list: ShyftTokenMeta[] = json.result.map((r) => ({
      address: r.address,
      balance: r.balance,
      associatedAccount: r.associated_account,
      decimals: r.info.decimals,
      name: r.info.name,
      symbol: r.info.symbol,
      ...(r.info.image && { image: r.info.image }),
    }));
    for (const t of list) out.set(t.address, t);
    cache.byAddress[address] = { data: list, fetchedAt: Date.now() };
    saveCache(TOKENS_CACHE_KEY, cache);
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    console.warn("Shyft tokens fetch failed:", e);
  }
  return out;
}

/**
 * Маппинг Shyft type → CapFlow OpType.
 */
export function mapShyftTypeToOpType(
  shyftType: string,
):
  | "swap"
  | "lp_add"
  | "lp_remove"
  | "stake"
  | "unstake"
  | "lend_supply"
  | "lend_withdraw"
  | "borrow"
  | "repay"
  | "claim_rewards"
  | null {
  const t = shyftType.toUpperCase();
  if (t === "SWAP") return "swap";
  if (t === "ADD_LIQ" || t === "ADD_LIQUIDITY") return "lp_add";
  if (t === "REMOVE_LIQ" || t === "REMOVE_LIQUIDITY") return "lp_remove";
  if (t === "STAKE" || t === "DELEGATE") return "stake";
  if (t === "UNSTAKE" || t === "UNDELEGATE" || t === "DEACTIVATE_STAKE")
    return "unstake";
  if (t === "DEPOSIT") return "lend_supply"; // часто это lending deposit
  if (t === "WITHDRAW") return "lend_withdraw";
  if (t === "BORROW") return "borrow";
  if (t === "REPAY") return "repay";
  if (t === "CLAIM" || t === "CLAIM_REWARDS") return "claim_rewards";
  return null;
}
