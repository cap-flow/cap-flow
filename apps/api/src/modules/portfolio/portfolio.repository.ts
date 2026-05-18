import { type Database, schema } from "@cap-flow/db";
import { and, asc, desc, eq, gte } from "drizzle-orm";

export type PortfolioSnapshotRow =
  typeof schema.portfolioSnapshots.$inferSelect;
export type NewPortfolioSnapshotRow =
  typeof schema.portfolioSnapshots.$inferInsert;

export interface IPortfolioRepository {
  insertSnapshot(row: NewPortfolioSnapshotRow): Promise<PortfolioSnapshotRow>;
  latestSnapshot(accountId: string): Promise<PortfolioSnapshotRow | null>;
  recentSnapshots(
    accountId: string,
    limit: number
  ): Promise<PortfolioSnapshotRow[]>;
  /**
   * H17: history series for TVL chart. Returns snapshots strictly after
   * `since`, ordered chronologically. Caller is expected to thin out the
   * point density client-side (Recharts is fine with 1000 points).
   */
  snapshotsSince(
    accountId: string,
    since: Date
  ): Promise<PortfolioSnapshotRow[]>;
}

export class PortfolioRepository implements IPortfolioRepository {
  constructor(private readonly db: Database) {}

  async insertSnapshot(
    row: NewPortfolioSnapshotRow
  ): Promise<PortfolioSnapshotRow> {
    const [inserted] = await this.db
      .insert(schema.portfolioSnapshots)
      .values(row)
      .returning();
    if (!inserted) throw new Error("portfolio_snapshots insert returned no row.");
    return inserted;
  }

  async latestSnapshot(
    accountId: string
  ): Promise<PortfolioSnapshotRow | null> {
    const rows = await this.db
      .select()
      .from(schema.portfolioSnapshots)
      .where(eq(schema.portfolioSnapshots.accountId, accountId))
      .orderBy(desc(schema.portfolioSnapshots.createdAt))
      .limit(1);
    return rows[0] ?? null;
  }

  async recentSnapshots(
    accountId: string,
    limit: number
  ): Promise<PortfolioSnapshotRow[]> {
    return this.db
      .select()
      .from(schema.portfolioSnapshots)
      .where(eq(schema.portfolioSnapshots.accountId, accountId))
      .orderBy(desc(schema.portfolioSnapshots.createdAt))
      .limit(limit);
  }

  async snapshotsSince(
    accountId: string,
    since: Date
  ): Promise<PortfolioSnapshotRow[]> {
    return this.db
      .select()
      .from(schema.portfolioSnapshots)
      .where(
        and(
          eq(schema.portfolioSnapshots.accountId, accountId),
          gte(schema.portfolioSnapshots.createdAt, since)
        )
      )
      .orderBy(asc(schema.portfolioSnapshots.createdAt));
  }
}
