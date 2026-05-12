import { type Database, schema } from "@cap-flow/db";
import { and, eq, isNull, or } from "drizzle-orm";

export type FeatureFlagRow = typeof schema.featureFlags.$inferSelect;
export type FeatureFlagScope = "global" | "account" | "user";

export interface UpsertFlagInput {
  readonly key: string;
  readonly scope: FeatureFlagScope;
  /** null for global; account.id for account; user.id for user. */
  readonly scopeRefId: string | null;
  readonly enabled: boolean;
  readonly payload?: Record<string, unknown> | null;
  readonly actorUserId: string | null;
}

export interface IFeatureFlagsRepository {
  listAll(): Promise<FeatureFlagRow[]>;
  listByKey(key: string): Promise<FeatureFlagRow[]>;
  /** Fetch global + (optional) per-account + (optional) per-user rows for
   *  one key in a single query — used by the resolver. */
  fetchForResolution(args: {
    key: string;
    userId: string | null;
    accountId: string | null;
  }): Promise<FeatureFlagRow[]>;
  upsert(input: UpsertFlagInput): Promise<FeatureFlagRow>;
  delete(id: string): Promise<void>;
}

export class FeatureFlagsRepository implements IFeatureFlagsRepository {
  constructor(private readonly db: Database) {}

  async listAll(): Promise<FeatureFlagRow[]> {
    return this.db
      .select()
      .from(schema.featureFlags)
      .orderBy(schema.featureFlags.key, schema.featureFlags.scope);
  }

  async listByKey(key: string): Promise<FeatureFlagRow[]> {
    return this.db
      .select()
      .from(schema.featureFlags)
      .where(eq(schema.featureFlags.key, key));
  }

  async fetchForResolution(args: {
    key: string;
    userId: string | null;
    accountId: string | null;
  }): Promise<FeatureFlagRow[]> {
    // One query: global row + user-scoped row (if userId) + account-scoped
    // row (if accountId). Resolver picks the most specific match.
    //
    // Earlier draft tried to splice a manual `sql.join(..., 'OR')` into a
    // composite WHERE — but drizzle's `and()` returns a SQL wrapper that
    // didn't compose with template `OR` glue, so the OR was dropped and
    // *every* row of the table came back. Use the typed `or()` helper.
    const branches = [
      and(
        eq(schema.featureFlags.scope, "global"),
        isNull(schema.featureFlags.scopeRefId)
      ),
    ];
    if (args.userId) {
      branches.push(
        and(
          eq(schema.featureFlags.scope, "user"),
          eq(schema.featureFlags.scopeRefId, args.userId)
        )
      );
    }
    if (args.accountId) {
      branches.push(
        and(
          eq(schema.featureFlags.scope, "account"),
          eq(schema.featureFlags.scopeRefId, args.accountId)
        )
      );
    }
    const scopeWhere = or(...branches);
    return this.db
      .select()
      .from(schema.featureFlags)
      .where(and(eq(schema.featureFlags.key, args.key), scopeWhere));
  }

  async upsert(input: UpsertFlagInput): Promise<FeatureFlagRow> {
    // We don't have a UNIQUE constraint on (key, scope, scope_ref_id) yet —
    // emulate upsert manually so we don't accumulate duplicate rows over time.
    const existing = await this.db
      .select()
      .from(schema.featureFlags)
      .where(
        and(
          eq(schema.featureFlags.key, input.key),
          eq(schema.featureFlags.scope, input.scope),
          input.scopeRefId === null
            ? isNull(schema.featureFlags.scopeRefId)
            : eq(schema.featureFlags.scopeRefId, input.scopeRefId)
        )
      )
      .limit(1);

    if (existing[0]) {
      const [updated] = await this.db
        .update(schema.featureFlags)
        .set({
          enabled: input.enabled,
          payload: input.payload ?? null,
          updatedAt: new Date(),
        })
        .where(eq(schema.featureFlags.id, existing[0].id))
        .returning();
      if (!updated) throw new Error("Feature flag update returned no row.");
      return updated;
    }

    const [created] = await this.db
      .insert(schema.featureFlags)
      .values({
        key: input.key,
        scope: input.scope,
        scopeRefId: input.scopeRefId,
        enabled: input.enabled,
        payload: input.payload ?? null,
      })
      .returning();
    if (!created) throw new Error("Feature flag insert returned no row.");
    return created;
  }

  async delete(id: string): Promise<void> {
    await this.db
      .delete(schema.featureFlags)
      .where(eq(schema.featureFlags.id, id));
  }
}
