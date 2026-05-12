import { type Database, schema } from "@cap-flow/db";
import { desc, eq } from "drizzle-orm";

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
}
