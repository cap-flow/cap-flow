import { type Database, schema } from "@cap-flow/db";
import { and, count, desc, gte, sql, sum } from "drizzle-orm";

export type ApiUsageRow = typeof schema.apiUsage.$inferSelect;
export type NewApiUsageRow = typeof schema.apiUsage.$inferInsert;

export interface ApiUsageSummary {
  readonly provider: string;
  readonly calls: number;
  readonly errors: number;
  readonly cacheHits: number;
  readonly totalCostUsd: string;
}

export interface IApiUsageRepository {
  insert(entry: NewApiUsageRow): Promise<void>;
  summaryByProvider(sinceUtc: Date): Promise<ApiUsageSummary[]>;
  recent(limit: number): Promise<ApiUsageRow[]>;
  topUsers(
    sinceUtc: Date,
    limit: number
  ): Promise<Array<{ userId: string; calls: number }>>;
}

export class ApiUsageRepository implements IApiUsageRepository {
  constructor(private readonly db: Database) {}

  async insert(entry: NewApiUsageRow): Promise<void> {
    await this.db.insert(schema.apiUsage).values(entry);
  }

  async summaryByProvider(sinceUtc: Date): Promise<ApiUsageSummary[]> {
    const rows = await this.db
      .select({
        provider: schema.apiUsage.provider,
        calls: count(schema.apiUsage.id),
        errors: sql<number>`COUNT(*) FILTER (WHERE ${schema.apiUsage.error} IS NOT NULL)`,
        cacheHits: sql<number>`COUNT(*) FILTER (WHERE ${schema.apiUsage.cacheHit} = 1)`,
        totalCostUsd: sum(schema.apiUsage.costEstimateUsd),
      })
      .from(schema.apiUsage)
      .where(gte(schema.apiUsage.createdAt, sinceUtc))
      .groupBy(schema.apiUsage.provider);

    return rows.map((r) => ({
      provider: r.provider,
      calls: Number(r.calls),
      errors: Number(r.errors),
      cacheHits: Number(r.cacheHits),
      totalCostUsd: r.totalCostUsd ?? "0",
    }));
  }

  async recent(limit: number): Promise<ApiUsageRow[]> {
    return this.db
      .select()
      .from(schema.apiUsage)
      .orderBy(desc(schema.apiUsage.createdAt))
      .limit(limit);
  }

  async topUsers(
    sinceUtc: Date,
    limit: number
  ): Promise<Array<{ userId: string; calls: number }>> {
    const rows = await this.db
      .select({
        userId: schema.apiUsage.userId,
        calls: count(schema.apiUsage.id),
      })
      .from(schema.apiUsage)
      .where(
        and(
          gte(schema.apiUsage.createdAt, sinceUtc),
          sql`${schema.apiUsage.userId} IS NOT NULL`
        )
      )
      .groupBy(schema.apiUsage.userId)
      .orderBy(desc(count(schema.apiUsage.id)))
      .limit(limit);

    const out: Array<{ userId: string; calls: number }> = [];
    for (const r of rows) {
      if (r.userId) out.push({ userId: r.userId, calls: Number(r.calls) });
    }
    return out;
  }
}
