import { type Database, schema } from "@cap-flow/db";
import { and, eq } from "drizzle-orm";

export interface ResolvedCoingeckoId {
  readonly source: "override" | "global";
  readonly coingeckoId: string;
}

/**
 * Look up coingecko_id for a symbol:
 *   1. per-account override (`cg_id_overrides`)
 *   2. global registry (`coingecko_registry`)
 *   3. null → caller surfaces it as "unmapped" for admin attention.
 */
export class PricesRepository {
  constructor(private readonly db: Database) {}

  async resolveCoingeckoId(
    symbol: string,
    accountId: string | null
  ): Promise<ResolvedCoingeckoId | null> {
    const upper = symbol.toUpperCase();

    if (accountId) {
      const ov = await this.db
        .select()
        .from(schema.cgIdOverrides)
        .where(
          and(
            eq(schema.cgIdOverrides.accountId, accountId),
            eq(schema.cgIdOverrides.symbol, upper)
          )
        )
        .limit(1);
      if (ov[0]) {
        return { source: "override", coingeckoId: ov[0].coingeckoId };
      }
    }

    const reg = await this.db
      .select()
      .from(schema.coingeckoRegistry)
      .where(eq(schema.coingeckoRegistry.symbol, upper))
      .limit(1);
    if (reg[0]) {
      return { source: "global", coingeckoId: reg[0].coingeckoId };
    }
    return null;
  }
}
