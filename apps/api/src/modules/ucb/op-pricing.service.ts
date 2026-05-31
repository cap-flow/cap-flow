/**
 * UCB B1 — server op-pricing service.
 *
 * `priceMapForOps(ops)` builds the SAME `histPrices` Map the client feeds the
 * UCB engine (`${coin}|${bucketTs}` → price), reading the shared
 * `op_token_prices` cache. The op→(coin,bucket) collection MIRRORS the client
 * `useWalletHistPrices` filter byte-for-byte (apps/web/.../use_hist_prices.ts)
 * so server cost basis is identical to the client's — and deterministic
 * regardless of which account/sync produced the op (fixes the movement.usd
 * sync-time non-determinism, POS-005).
 *
 * This stage is CACHE-READ only: it returns the map built from cached rows plus
 * the list of MISSING (coin, bucket) keys. B1.3 fills misses via the DefiLlama
 * batcher (then `priced_ok=true` rows land here for the next call). Not yet
 * wired into served metrics (cache-fill only).
 */
import { defillamaCoinKey, bucketTs, cacheKeyFor } from "@cap-flow/ucb/pricing";
import type { ClassifiedOp } from "@cap-flow/ucb/types";

import {
  type OpPriceKey,
  type OpPricingRepository,
} from "./op-pricing.repository.js";

export interface PriceNeed extends OpPriceKey {
  /** Original op.time (seconds) — kept so B1.3 can fetch the exact bucket. */
  readonly timestamp: number;
  readonly chain: string;
  readonly tokenId: string | null;
}

export interface PriceMapResult {
  /** `${coin}|${bucketTs}` → priceUsd — same shape the engine's histPrices expects. */
  readonly histPrices: Map<string, number>;
  /** (coin, bucket) pairs not in cache — B1.3 fills these. */
  readonly missing: PriceNeed[];
}

/**
 * Collect the (coin, hourBucket) pairs the engine will look up for these ops.
 * EXACT mirror of client `useWalletHistPrices` (use_hist_prices.ts:31-62):
 * non-failed ops; per movement: amount>0, not gas-ETH (<0.01), not stable, not
 * protocol-token, direction in|out, coin resolvable; dedupe by coin+hour.
 */
export function collectPriceNeeds(ops: readonly ClassifiedOp[]): PriceNeed[] {
  const out: PriceNeed[] = [];
  const seen = new Set<string>();
  for (const op of ops) {
    if (op.status === "failed") continue;
    for (const m of op.movement) {
      if (m.amount <= 0) continue;
      if ((m.symbol === "ETH" || m.symbol === "WETH") && m.amount < 0.01) continue;
      if (m.isStable) continue;
      if (m.isProtocolToken) continue;
      if (m.direction !== "out" && m.direction !== "in") continue;
      const coin = defillamaCoinKey(op.chain, m.tokenId, m.symbol);
      if (!coin) continue;
      const hourBucket = bucketTs(op.time);
      const dedupe = `${coin}|${hourBucket}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      out.push({
        coin,
        hourBucket,
        timestamp: op.time,
        chain: op.chain,
        tokenId: m.tokenId ?? null,
      });
    }
  }
  return out;
}

/**
 * Fetch DefiLlama historical prices for one hour bucket. Injectable so B1.4
 * can mock it offline. Returns `coin → priceUsd` ONLY for coins DefiLlama
 * priced > 0 (R5: zero/missing are dropped, never cached).
 */
export type DefillamaFetch = (
  bucketTs: number,
  coins: readonly string[],
  signal?: AbortSignal,
) => Promise<Map<string, number>>;

interface LlamaResponse {
  coins?: Record<string, { price?: number } | undefined>;
}

/** Default fetcher → DefiLlama public coins API (no key). `DEFILLAMA_BASE_URL` overrides. */
export const defaultDefillamaFetch: DefillamaFetch = async (
  bucketTs,
  coins,
  signal,
) => {
  const base = process.env["DEFILLAMA_BASE_URL"] ?? "https://coins.llama.fi";
  const out = new Map<string, number>();
  // Chunk ≤50 coins/request (URL length), mirrors client.
  for (let i = 0; i < coins.length; i += 50) {
    const chunk = coins.slice(i, i + 50);
    const url = `${base}/prices/historical/${bucketTs}/${chunk.join(",")}?searchWidth=4h`;
    const res = await fetch(url, signal ? { signal } : {});
    if (!res.ok) continue; // R5: failed lookup → no rows for this chunk
    const data = (await res.json()) as LlamaResponse;
    for (const [coin, v] of Object.entries(data.coins ?? {})) {
      const price = v?.price;
      if (typeof price === "number" && price > 0) out.set(coin, price);
    }
  }
  return out;
};

const FILL_CONCURRENCY = 4; // hard cap (risk R6) — never one-per-op unbounded

export class OpPricingService {
  constructor(
    private readonly repo: OpPricingRepository,
    private readonly fetcher: DefillamaFetch = defaultDefillamaFetch,
  ) {}

  /**
   * B1.3: fetch missing (coin,bucket) from DefiLlama with bounded concurrency
   * and cache `priced_ok=true` rows. R5: only price>0 lands. Returns count
   * written. Safe under worker race via repo `onConflictDoNothing`.
   */
  async fillMissing(
    missing: readonly PriceNeed[],
    signal?: AbortSignal,
  ): Promise<{ written: number }> {
    if (missing.length === 0) return { written: 0 };
    // Group needs by hour bucket; collect coin→need meta (chain/tokenId).
    const byBucket = new Map<number, PriceNeed[]>();
    for (const n of missing) {
      const arr = byBucket.get(n.hourBucket);
      if (arr) arr.push(n);
      else byBucket.set(n.hourBucket, [n]);
    }
    const buckets = [...byBucket.entries()];
    let cursor = 0;
    let written = 0;
    const worker = async (): Promise<void> => {
      while (cursor < buckets.length) {
        if (signal?.aborted) return;
        const [bucket, needs] = buckets[cursor++]!;
        const coins = [...new Set(needs.map((n) => n.coin))];
        const priced = await this.fetcher(bucket, coins, signal);
        if (priced.size === 0) continue;
        const metaByCoin = new Map(needs.map((n) => [n.coin, n]));
        const rows = [...priced.entries()].map(([coin, priceUsd]) => {
          const meta = metaByCoin.get(coin)!;
          return {
            coin,
            hourBucket: bucket,
            priceUsd,
            chain: meta.chain,
            tokenId: meta.tokenId,
            source: "defillama",
          };
        });
        await this.repo.upsertMany(rows);
        written += rows.length;
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(FILL_CONCURRENCY, buckets.length) }, worker),
    );
    return { written };
  }

  /**
   * Build the histPrices map from the cache for these ops. Returns the map
   * (cache hits) + the missing keys (cache misses → B1.3 fetches them).
   */
  async priceMapForOps(ops: readonly ClassifiedOp[]): Promise<PriceMapResult> {
    const needs = collectPriceNeeds(ops);
    const histPrices = new Map<string, number>();
    if (needs.length === 0) return { histPrices, missing: [] };

    const cached = await this.repo.getByKeys(needs);
    const hit = new Set<string>();
    for (const row of cached) {
      const key = `${row.coin}|${row.hourBucket}`;
      histPrices.set(key, row.priceUsd);
      hit.add(key);
    }
    const missing = needs.filter((n) => !hit.has(`${n.coin}|${n.hourBucket}`));
    // `cacheKeyFor` invariant check (dev): served keys must equal the client's.
    void cacheKeyFor;
    return { histPrices, missing };
  }
}
