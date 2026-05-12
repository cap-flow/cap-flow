import {
  ProviderError,
  type IBalanceProvider,
  type BalanceEntry,
} from "./types.js";

/**
 * Helius Solana wallet API.
 *
 * Two endpoints we care about:
 *   GET  https://api.helius.xyz/v0/addresses/:addr/balances?api-key=...
 *        → { nativeBalance: lamports, tokens: [{ mint, amount, decimals }] }
 *   POST https://mainnet.helius-rpc.com/?api-key=...  (JSON-RPC for raw RPC)
 *
 * For the refresh pipeline we only need the first one. We don't price-resolve
 * Solana tokens here — the calling refresh service can either look up
 * symbols via the global `coingecko_registry` (by mint address) or treat
 * the breakdown as informational until per-token pricing lands.
 *
 * Phase 3c policy: when the key isn't configured (`isLive === false`),
 * `getWalletBalances` returns `[]` so the refresh pipeline degrades
 * gracefully (Solana addresses just don't contribute to TVL).
 */
export interface HeliusTokenBalance {
  readonly mint: string;
  readonly amount: number;   // human units (already divided by decimals)
  readonly decimals: number;
  readonly tokenAccount: string;
}

export interface HeliusBalances {
  /** SOL native balance in lamports (1 SOL = 1e9 lamports). */
  readonly nativeLamports: number;
  readonly tokens: HeliusTokenBalance[];
}

/**
 * Loose shape of one Helius enhanced-transaction record. The chain
 * classifier (P5.4) re-parses these into its strict
 * `HeliusTransaction` interface (`classifier/helius_types.ts`).
 */
export interface HeliusTransactionRaw {
  signature: string;
  timestamp?: number;
  [key: string]: unknown;
}

export interface GetTransactionsOptions {
  /** Hard cap on pagination loops (each page = 100 tx). Default 10. */
  readonly maxPages?: number;
}

interface HeliusBalancesResponse {
  readonly nativeBalance: number;
  readonly tokens: Array<{
    mint: string;
    amount: number;
    decimals: number;
    tokenAccount: string;
  }>;
}

export class HeliusClient implements IBalanceProvider {
  readonly name = "helius" as const;
  private readonly base = "https://api.helius.xyz";

  constructor(private readonly apiKey: string | undefined) {}

  get isLive(): boolean {
    return Boolean(this.apiKey && this.apiKey.trim().length > 0);
  }

  /**
   * Native + SPL balances for a Solana address. Native is in lamports;
   * tokens are in human units (Helius already divides by `decimals`).
   */
  async getBalances(address: string): Promise<HeliusBalances> {
    if (!this.isLive) {
      return { nativeLamports: 0, tokens: [] };
    }
    const url = new URL(`${this.base}/v0/addresses/${address}/balances`);
    url.searchParams.set("api-key", this.apiKey ?? "");
    const res = await fetch(url.toString(), {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "<no body>");
      throw new ProviderError(
        `Helius ${res.status} ${res.statusText} — ${text.slice(0, 200)}`,
        "helius",
        res.status
      );
    }
    const body = (await res.json()) as HeliusBalancesResponse;
    return {
      nativeLamports: body.nativeBalance ?? 0,
      tokens: (body.tokens ?? []).map((t) => ({
        mint: t.mint,
        amount: t.amount,
        decimals: t.decimals,
        tokenAccount: t.tokenAccount,
      })),
    };
  }

/**
   * Fetch enhanced-transaction history for an address, paginated by the
   * `before` (signature) cursor. Helius caps each page at 100; we walk
   * until: empty page, partial page, or `maxPages`.
   *
   * Returns the raw provider payload (typed loosely as
   * `HeliusTransactionRaw[]`) — the chain classifier owns its strict
   * parsing in `modules/classifier/solana_classifier.ts`.
   *
   * When the API key is absent: returns `[]` instead of throwing, so
   * the refresh pipeline degrades gracefully.
   */
  async getTransactions(
    address: string,
    opts: GetTransactionsOptions = {}
  ): Promise<HeliusTransactionRaw[]> {
    if (!this.isLive) return [];
    const maxPages = opts.maxPages ?? 10;
    const limit = 100;

    const acc: HeliusTransactionRaw[] = [];
    const seen = new Set<string>();
    let before: string | undefined = undefined;
    let lastTime = Number.POSITIVE_INFINITY;

    for (let p = 0; p < maxPages; p++) {
      const url = new URL(
        `${this.base}/v0/addresses/${address}/transactions`
      );
      url.searchParams.set("api-key", this.apiKey ?? "");
      url.searchParams.set("limit", String(limit));
      if (before) url.searchParams.set("before", before);

      const res = await fetch(url.toString(), {
        headers: { Accept: "application/json" },
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "<no body>");
        throw new ProviderError(
          `Helius ${res.status} ${res.statusText} — ${text.slice(0, 200)}`,
          "helius",
          res.status
        );
      }
      const page = (await res.json()) as HeliusTransactionRaw[];
      if (!Array.isArray(page) || page.length === 0) break;

      for (const t of page) {
        if (!t?.signature || seen.has(t.signature)) continue;
        seen.add(t.signature);
        acc.push(t);
      }

      if (page.length < limit) break;
      const tail = page[page.length - 1]!;
      if (typeof tail.timestamp === "number" && tail.timestamp >= lastTime) {
        break;
      }
      if (typeof tail.timestamp === "number") lastTime = tail.timestamp;
      before = tail.signature;
    }

    return acc;
  }

  /**
   * Implements `IBalanceProvider` so a future `QuotedBalanceProvider`
   * decorator can wrap us identically to DeBank/Alchemy.
   *
   * `chainId` is ignored — Solana has no chainId. Pass 0 by convention.
   * `symbol` left empty for SPL tokens — refresh service resolves it via
   * the global coingecko_registry by mint address.
   */
  async getWalletBalances(
    _chainId: number,
    address: string
  ): Promise<BalanceEntry[]> {
    const bal = await this.getBalances(address);
    const out: BalanceEntry[] = [];
    if (bal.nativeLamports > 0) {
      out.push({
        symbol: "SOL",
        amount: (bal.nativeLamports / 1_000_000_000).toString(),
        chainId: 0,
        contractAddress: null,
      });
    }
    for (const t of bal.tokens) {
      out.push({
        symbol: "",
        amount: t.amount.toString(),
        chainId: 0,
        contractAddress: t.mint,
      });
    }
    return out;
  }
}
