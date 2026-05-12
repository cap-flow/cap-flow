import { NotFoundError } from "../../core/errors.js";
import type { AuditService } from "../audit/audit.service.js";
import type { JsonCache } from "../redis/cache.js";

import type {
  FeatureFlagRow,
  FeatureFlagScope,
  IFeatureFlagsRepository,
} from "./feature-flags.repository.js";

export interface ResolutionContext {
  readonly userId?: string | null;
  readonly accountId?: string | null;
}

export interface ResolvedFlag {
  readonly key: string;
  readonly enabled: boolean;
  readonly source: FeatureFlagScope | "default";
  readonly payload: Record<string, unknown> | null;
}

export interface FeatureFlagsConfig {
  /** Cache TTL for the resolver result, in seconds. */
  readonly cacheTtlSeconds: number;
}

/**
 * Resolves a feature-flag for a (user, account) context with the precedence:
 *   1. user-scope override (if userId given)
 *   2. account-scope override (if accountId given)
 *   3. global
 *   4. default → false (with `source: "default"`)
 *
 * Result is cached in Redis under `flag:<key>:u=<userId|->:a=<accountId|->`
 * for the configured TTL. All admin mutations call `invalidate(key)` —
 * a wildcard DEL across that key's cache shards.
 */
export class FeatureFlagsService {
  constructor(
    private readonly repo: IFeatureFlagsRepository,
    private readonly cache: JsonCache,
    private readonly audit: AuditService,
    private readonly cfg: FeatureFlagsConfig
  ) {}

  // ─── public resolver ─────────────────────────────────────────────────

  /**
   * Single-flag lookup. Cheap on hot path: one Redis GET on cache hit, one
   * SELECT (one row at most for global + 0..2 overrides) on miss.
   */
  async resolve(key: string, ctx: ResolutionContext): Promise<ResolvedFlag> {
    const cacheKey = this.cacheKey(key, ctx);
    const cached = await this.cache.get<ResolvedFlag>(cacheKey);
    if (cached !== null) return cached;

    const rows = await this.repo.fetchForResolution({
      key,
      userId: ctx.userId ?? null,
      accountId: ctx.accountId ?? null,
    });

    const result = this.applyPrecedence(key, rows);
    await this.cache.set(cacheKey, result, this.cfg.cacheTtlSeconds);
    return result;
  }

  /** Convenience for branchy code: `if (await flags.enabled('foo', {userId})) ...`. */
  async enabled(key: string, ctx: ResolutionContext): Promise<boolean> {
    return (await this.resolve(key, ctx)).enabled;
  }

  /** Resolve a set of keys at once — used by /me/feature-flags for the
   *  frontend to seed its in-memory flag store. */
  async resolveAll(
    keys: string[],
    ctx: ResolutionContext
  ): Promise<ResolvedFlag[]> {
    return Promise.all(keys.map((k) => this.resolve(k, ctx)));
  }

  // ─── admin ops ───────────────────────────────────────────────────────

  async listAll(): Promise<FeatureFlagRow[]> {
    return this.repo.listAll();
  }

  async listByKey(key: string): Promise<FeatureFlagRow[]> {
    return this.repo.listByKey(key);
  }

  async upsert(
    input: {
      key: string;
      scope: FeatureFlagScope;
      scopeRefId: string | null;
      enabled: boolean;
      payload?: Record<string, unknown> | null;
    },
    actorAdminId: string
  ): Promise<FeatureFlagRow> {
    if (input.scope === "global" && input.scopeRefId !== null) {
      throw new Error("Global flags must have scopeRefId = null.");
    }
    if (input.scope !== "global" && input.scopeRefId === null) {
      throw new Error(`Scope '${input.scope}' requires scopeRefId.`);
    }
    const row = await this.repo.upsert({
      key: input.key,
      scope: input.scope,
      scopeRefId: input.scopeRefId,
      enabled: input.enabled,
      payload: input.payload ?? null,
      actorUserId: actorAdminId,
    });
    await this.invalidate(input.key);
    await this.audit.log({
      actorUserId: actorAdminId,
      asAdmin: true,
      action: "feature_flag.upserted",
      target: input.key,
      payload: {
        scope: input.scope,
        scopeRefId: input.scopeRefId,
        enabled: input.enabled,
      },
    });
    return row;
  }

  async deleteById(id: string, actorAdminId: string): Promise<void> {
    // We need the key for the audit log + cache invalidation, so look up first.
    const all = await this.repo.listAll();
    const target = all.find((r) => r.id === id);
    if (!target) throw new NotFoundError(`Feature flag '${id}' not found.`);
    await this.repo.delete(id);
    await this.invalidate(target.key);
    await this.audit.log({
      actorUserId: actorAdminId,
      asAdmin: true,
      action: "feature_flag.deleted",
      target: target.key,
      payload: { id, scope: target.scope, scopeRefId: target.scopeRefId },
    });
  }

  // ─── internals ───────────────────────────────────────────────────────

  /**
   * Resolution precedence — `user > account > global > default(false)`.
   *
   * Note: we always treat default-false as the floor. That matches the
   * canary workflow — a brand new flag with no rows is OFF for everyone
   * until the admin creates a row.
   */
  private applyPrecedence(
    key: string,
    rows: FeatureFlagRow[]
  ): ResolvedFlag {
    const userRow = rows.find((r) => r.scope === "user");
    if (userRow) {
      return {
        key,
        enabled: userRow.enabled,
        source: "user",
        payload: (userRow.payload as Record<string, unknown> | null) ?? null,
      };
    }
    const accountRow = rows.find((r) => r.scope === "account");
    if (accountRow) {
      return {
        key,
        enabled: accountRow.enabled,
        source: "account",
        payload:
          (accountRow.payload as Record<string, unknown> | null) ?? null,
      };
    }
    const globalRow = rows.find((r) => r.scope === "global");
    if (globalRow) {
      return {
        key,
        enabled: globalRow.enabled,
        source: "global",
        payload: (globalRow.payload as Record<string, unknown> | null) ?? null,
      };
    }
    return { key, enabled: false, source: "default", payload: null };
  }

  private cacheKey(key: string, ctx: ResolutionContext): string {
    const u = ctx.userId ?? "-";
    const a = ctx.accountId ?? "-";
    return `flag:${key}:u=${u}:a=${a}`;
  }

  /**
   * Invalidate every cached resolution for a key. Cheap broad nuke: we
   * iterate matching keys via SCAN. With <10 active flags × <100 users the
   * total cardinality is tiny.
   */
  private async invalidate(key: string): Promise<void> {
    // The JsonCache wraps ioredis directly through `.get/.set/.del` — for
    // wildcard delete we go via the underlying client. Use SCAN to avoid
    // KEYS-blocking on production-sized DBs even though dev is small.
    const pattern = `flag:${key}:*`;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const redis = (this.cache as unknown as { redis: any }).redis;
    let cursor = "0";
    do {
      const [next, batch] = (await redis.scan(
        cursor,
        "MATCH",
        pattern,
        "COUNT",
        100
      )) as [string, string[]];
      cursor = next;
      if (batch.length > 0) {
        await redis.del(...batch);
      }
    } while (cursor !== "0");
  }
}
