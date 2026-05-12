/**
 * CoinStats — универсальный wallet API.
 *
 * Используется для сетей, которые не покрывают наши primary источники:
 *   • TON, Bitcoin, Aptos, Sui, Cardano, Tron, XRP, Stellar, Algorand, Hedera, …
 *   • Cosmos-экосистема (Osmosis, Injective, Celestia, Sei, Akash, Stride, …)
 *   • Новые EVM L2: Berachain, Monad, HyperEVM, Sonic, Soneium, Plume,
 *     Worldchain, Unichain, Zircuit, …
 *
 * Endpoint base: `/coinstats/*` → проксируется на
 * `https://openapiv1.coinstats.app/*` (см. vite.config.ts).
 *
 * Авторизация: header `X-API-KEY: <key>`.
 *
 * Стоимость (credits per call):
 *   • /wallet/balance        — 40
 *   • /wallet/defi           — ~30 (не указано в доке)
 *   • /wallet/transactions   — 30
 *   • PATCH /wallet/transactions (sync)  — 50
 */

const BASE = "/coinstats";

export interface CoinStatsBalanceItem {
  coinId: string;
  amount: number;
  decimals?: number;
  contractAddress?: string;
  chain?: string;
  name: string;
  symbol: string;
  price: number;
  priceBtc?: number;
  imgUrl?: string;
  pCh24h?: number;
  rank?: number;
  volume?: number;
}

export interface CoinStatsDefiResponse {
  totalAssets: { USD: number; BTC: number; ETH: number };
  protocols: CoinStatsDefiProtocol[];
}

/**
 * Реальная схема CoinStats:
 *   protocols[].investments[].assets[]  с полем `title` ("Deposit" / "Debt" / …).
 * Поле `assets[].price.USD` — это USD-стоимость позиции (amount × unit_price),
 * а не цена за токен. Имя поля `price` в API сбивающее, но проверено на
 * Jupiter Lending: 0.24 cbBTC → price.USD ≈ $19 878 (~0.24 × $82 500).
 */
export interface CoinStatsDefiProtocol {
  id?: string;
  protocolId?: string;
  name: string;
  logo?: string;
  url?: string;
  chain?: string;
  totalValue?: { USD?: number; BTC?: number; ETH?: number };
  /** Реальные позиции пользователя в этом протоколе. */
  investments?: CoinStatsDefiInvestment[];
  /** @deprecated Старая схема — оставлено для обратной совместимости. */
  positions?: CoinStatsDefiInvestment[];
}

export interface CoinStatsDefiInvestment {
  id?: string;
  name?: string;
  type?: string;
  symbols?: string;
  value?: { USD?: number; BTC?: number; ETH?: number };
  assets?: CoinStatsDefiAsset[];
}

export interface CoinStatsDefiAsset {
  address?: string;
  chain?: string;
  /** "Deposit" | "Supply" | "Stake" | "Provide Liquidity" | "Borrow" | "Debt" | "Reward" | … */
  title?: string;
  coinId?: string;
  amount: number;
  symbol: string;
  /** USD-стоимость позиции (amount × unit_price), не unit price. */
  price?: { USD?: number; BTC?: number; ETH?: number };
  logo?: string;
  /** true для позиций с риском (например, debt в режиме около ликвидации). */
  danger?: boolean;
}

export interface CoinStatsBlockchain {
  connectionId: string;
  name: string;
  icon?: string;
  chain?: string;
}

export class CoinStatsError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "CoinStatsError";
  }
}

/* ---------------------------- low-level fetcher --------------------------- */

async function callCoinStats<T>(
  path: string,
  apiKey: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      "X-API-KEY": apiKey,
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    let msg = `CoinStats ${res.status}`;
    try {
      const body = await res.json();
      if (body?.message) msg = body.message;
    } catch {
      /* ignore */
    }
    throw new CoinStatsError(res.status, msg);
  }
  return (await res.json()) as T;
}

/* ------------------------------- public api ------------------------------- */

/** Список поддерживаемых сетей. */
export function fetchSupportedBlockchains(
  apiKey: string,
): Promise<CoinStatsBlockchain[]> {
  return callCoinStats<CoinStatsBlockchain[]>(
    "/wallet/blockchains",
    apiKey,
  );
}

/** Спот-балансы по адресу на конкретной сети. */
export function fetchWalletBalance(args: {
  address: string;
  connectionId: string;
  apiKey: string;
}): Promise<CoinStatsBalanceItem[]> {
  const qs = new URLSearchParams({
    address: args.address,
    connectionId: args.connectionId,
  });
  return callCoinStats<CoinStatsBalanceItem[]>(
    `/wallet/balance?${qs}`,
    args.apiKey,
  );
}

/** Сводный список DeFi-позиций (staking, lending, LP). */
export function fetchWalletDefi(args: {
  address: string;
  connectionId: string;
  apiKey: string;
}): Promise<CoinStatsDefiResponse> {
  const qs = new URLSearchParams({
    address: args.address,
    connectionId: args.connectionId,
  });
  return callCoinStats<CoinStatsDefiResponse>(
    `/wallet/defi?${qs}`,
    args.apiKey,
  );
}

/** История транзакций (требует предварительный sync для свежих данных). */
export function fetchWalletTransactions(args: {
  address: string;
  connectionId: string;
  apiKey: string;
  limit?: number;
}): Promise<{ result: unknown[] }> {
  const qs = new URLSearchParams({
    address: args.address,
    connectionId: args.connectionId,
    ...(args.limit != null && { limit: String(args.limit) }),
  });
  return callCoinStats<{ result: unknown[] }>(
    `/wallet/transactions?${qs}`,
    args.apiKey,
  );
}

/**
 * Принудительный sync wallet'а — CoinStats индексирует историю в фоне,
 * этот вызов запускает обновление. Вернёт `{ status: "syncing" }`,
 * после чего нужно подождать ~10-15 сек и повторить запросы.
 */
export function syncWallet(args: {
  address: string;
  connectionId: string;
  apiKey: string;
}): Promise<{ status: string }> {
  const qs = new URLSearchParams({
    address: args.address,
    connectionId: args.connectionId,
  });
  return callCoinStats<{ status: string }>(
    `/wallet/transactions?${qs}`,
    args.apiKey,
    { method: "PATCH" },
  );
}
