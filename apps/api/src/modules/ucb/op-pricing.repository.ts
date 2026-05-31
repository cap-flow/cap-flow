/**
 * UCB B1 — repository for the shared `op_token_prices` cache.
 *
 * Read by `(coin, hour_bucket)` (the deterministic pricing key = DefiLlama coin
 * + hour bucket). Writes are `onConflictDoNothing` — these are immutable facts
 * shared across all users, safe under the worker race (risk R7). R5: only
 * `priced_ok=true` rows are served (callers never persist failed/zero lookups).
 */
import { type Database, schema } from "@cap-flow/db";
import { and, eq, sql } from "drizzle-orm";

const { opTokenPrices } = schema;

export interface OpPriceKey {
  readonly coin: string;
  readonly hourBucket: number;
}

export interface OpPriceRow {
  readonly coin: string;
  readonly hourBucket: number;
  readonly priceUsd: number;
}

export interface OpPriceInsert {
  readonly coin: string;
  readonly hourBucket: number;
  readonly priceUsd: number;
  readonly chain: string;
  readonly tokenId: string | null;
  readonly source: string;
}

export class OpPricingRepository {
  constructor(private readonly db: Database) {}

  /** Fetch cached prices for a set of (coin, hour_bucket) keys. priced_ok only. */
  async getByKeys(keys: readonly OpPriceKey[]): Promise<OpPriceRow[]> {
    if (keys.length === 0) return [];
    const tuples = sql.join(
      keys.map((k) => sql`(${k.coin}, ${k.hourBucket})`),
      sql`, `,
    );
    const rows = await this.db
      .select({
        coin: opTokenPrices.coin,
        hourBucket: opTokenPrices.hourBucket,
        priceUsd: opTokenPrices.priceUsd,
      })
      .from(opTokenPrices)
      .where(
        and(
          eq(opTokenPrices.pricedOk, true),
          sql`(${opTokenPrices.coin}, ${opTokenPrices.hourBucket}) IN (${tuples})`,
        ),
      );
    return rows.map((r) => ({
      coin: r.coin,
      hourBucket: r.hourBucket,
      priceUsd: Number(r.priceUsd),
    }));
  }

  /**
   * Batch-insert priced rows. `onConflictDoNothing` (immutable facts; first
   * writer wins under the concurrency:5 worker race). Caller MUST pass only
   * successful (priced_ok=true) lookups — R5 forbids persisting zero/failed.
   */
  async upsertMany(rows: readonly OpPriceInsert[]): Promise<void> {
    if (rows.length === 0) return;
    await this.db
      .insert(opTokenPrices)
      .values(
        rows.map((r) => ({
          coin: r.coin,
          hourBucket: r.hourBucket,
          priceUsd: String(r.priceUsd),
          pricedOk: true,
          chain: r.chain,
          tokenId: r.tokenId,
          source: r.source,
        })),
      )
      .onConflictDoNothing();
  }
}
