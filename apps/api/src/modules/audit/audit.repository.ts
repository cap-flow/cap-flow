import { type Database, schema } from "@cap-flow/db";

export type AuditEntryRow = typeof schema.auditLog.$inferSelect;
export type NewAuditEntryRow = typeof schema.auditLog.$inferInsert;

export interface IAuditRepository {
  insert(entry: NewAuditEntryRow): Promise<AuditEntryRow>;
}

export class AuditRepository implements IAuditRepository {
  constructor(private readonly db: Database) {}

  async insert(entry: NewAuditEntryRow): Promise<AuditEntryRow> {
    const [row] = await this.db
      .insert(schema.auditLog)
      .values(entry)
      .returning();
    if (!row) throw new Error("Audit insert returned no row.");
    return row;
  }
}
