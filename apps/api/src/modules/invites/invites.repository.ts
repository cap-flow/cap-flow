import { type Database, schema } from "@cap-flow/db";
import { and, desc, eq, isNull, lt } from "drizzle-orm";

export type InviteRow = typeof schema.invites.$inferSelect;
export type InviteStatus = InviteRow["status"];

export interface CreateInviteInput {
  /** May be null for open invite links (user supplies email at registration). */
  readonly email: string | null;
  readonly tokenHash: string;
  readonly createdByUserId: string;
  readonly expiresAt: Date;
  readonly notes: string | null;
}

export interface IInvitesRepository {
  create(input: CreateInviteInput): Promise<InviteRow>;
  findByTokenHash(tokenHash: string): Promise<InviteRow | null>;
  findById(id: string): Promise<InviteRow | null>;
  listAll(filter: { status?: InviteStatus | undefined }): Promise<InviteRow[]>;
  consume(id: string, consumedByUserId: string, when: Date): Promise<void>;
  revoke(id: string, when: Date): Promise<void>;
  markExpired(when: Date): Promise<number>;
  pendingByEmail(email: string): Promise<InviteRow[]>;
}

export class InvitesRepository implements IInvitesRepository {
  constructor(private readonly db: Database) {}

  async create(input: CreateInviteInput): Promise<InviteRow> {
    const [row] = await this.db
      .insert(schema.invites)
      .values({
        email: input.email ? input.email.toLowerCase() : null,
        tokenHash: input.tokenHash,
        createdByUserId: input.createdByUserId,
        expiresAt: input.expiresAt,
        notes: input.notes,
      })
      .returning();
    if (!row) throw new Error("Invite insert returned no row.");
    return row;
  }

  async findByTokenHash(tokenHash: string): Promise<InviteRow | null> {
    const rows = await this.db
      .select()
      .from(schema.invites)
      .where(eq(schema.invites.tokenHash, tokenHash))
      .limit(1);
    return rows[0] ?? null;
  }

  async findById(id: string): Promise<InviteRow | null> {
    const rows = await this.db
      .select()
      .from(schema.invites)
      .where(eq(schema.invites.id, id))
      .limit(1);
    return rows[0] ?? null;
  }

  async listAll(filter: {
    status?: InviteStatus | undefined;
  }): Promise<InviteRow[]> {
    if (filter.status) {
      return this.db
        .select()
        .from(schema.invites)
        .where(eq(schema.invites.status, filter.status))
        .orderBy(desc(schema.invites.createdAt));
    }
    return this.db
      .select()
      .from(schema.invites)
      .orderBy(desc(schema.invites.createdAt));
  }

  async consume(
    id: string,
    consumedByUserId: string,
    when: Date
  ): Promise<void> {
    await this.db
      .update(schema.invites)
      .set({ status: "consumed", consumedByUserId, consumedAt: when })
      .where(eq(schema.invites.id, id));
  }

  async revoke(id: string, when: Date): Promise<void> {
    await this.db
      .update(schema.invites)
      .set({ status: "revoked", revokedAt: when })
      .where(eq(schema.invites.id, id));
  }

  /** Bulk-mark pending invites whose expires_at has passed. Returns count. */
  async markExpired(when: Date): Promise<number> {
    const rows = await this.db
      .update(schema.invites)
      .set({ status: "expired" })
      .where(
        and(
          eq(schema.invites.status, "pending"),
          lt(schema.invites.expiresAt, when)
        )
      )
      .returning({ id: schema.invites.id });
    return rows.length;
  }

  /** Find non-consumed/non-revoked invites for an email (for conflict checks). */
  async pendingByEmail(email: string): Promise<InviteRow[]> {
    return this.db
      .select()
      .from(schema.invites)
      .where(
        and(
          eq(schema.invites.email, email.toLowerCase()),
          eq(schema.invites.status, "pending"),
          isNull(schema.invites.revokedAt)
        )
      );
  }
}
