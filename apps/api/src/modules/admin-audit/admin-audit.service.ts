import { type Database, schema } from "@cap-flow/db";
import { and, desc, eq, gte, ilike, lte, sql } from "drizzle-orm";

export interface AuditFilter {
  readonly actorId?: string;
  readonly targetUserId?: string;
  readonly action?: string;
  readonly asAdmin?: boolean;
  readonly accountId?: string;
  readonly since?: Date;
  readonly until?: Date;
  readonly limit?: number;
  readonly offset?: number;
}

export type AuditEntryRow = typeof schema.auditLog.$inferSelect;

export class AdminAuditService {
  constructor(private readonly db: Database) {}

  async list(filter: AuditFilter): Promise<AuditEntryRow[]> {
    const limit = Math.min(filter.limit ?? 100, 500);
    const offset = filter.offset ?? 0;

    const where = [];
    if (filter.actorId) where.push(eq(schema.auditLog.actorId, filter.actorId));
    if (filter.targetUserId)
      where.push(eq(schema.auditLog.targetUserId, filter.targetUserId));
    if (filter.accountId)
      where.push(eq(schema.auditLog.accountId, filter.accountId));
    if (filter.asAdmin !== undefined)
      where.push(eq(schema.auditLog.asAdmin, filter.asAdmin));
    if (filter.action)
      where.push(ilike(schema.auditLog.action, `${filter.action}%`));
    if (filter.since) where.push(gte(schema.auditLog.occurredAt, filter.since));
    if (filter.until) where.push(lte(schema.auditLog.occurredAt, filter.until));

    const query = this.db.select().from(schema.auditLog);
    const filtered = where.length > 0 ? query.where(and(...where)) : query;
    return filtered
      .orderBy(desc(schema.auditLog.occurredAt))
      .limit(limit)
      .offset(offset);
  }

  /** Counts by action over a window — quick eye-ball of what's happening. */
  async actionCounts(since: Date): Promise<Array<{ action: string; n: number }>> {
    const rows = await this.db.execute<{ action: string; n: string }>(sql`
      SELECT action, COUNT(*) AS n
      FROM audit_log
      WHERE occurred_at >= ${since.toISOString()}
      GROUP BY action
      ORDER BY COUNT(*) DESC
    `);
    return rows.rows.map((r) => ({ action: r.action, n: Number(r.n) }));
  }
}
