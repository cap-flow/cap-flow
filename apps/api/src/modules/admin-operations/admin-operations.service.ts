import { type Database, schema } from "@cap-flow/db";
import { and, desc, eq, gte, ilike, lt, or, sql, type SQL } from "drizzle-orm";

export interface AdminOperationsFilter {
  readonly userId?: string | undefined;
  readonly accountId?: string | undefined;
  readonly walletId?: string | undefined;
  readonly opType?: string | undefined;
  readonly chain?: string | undefined;
  readonly status?: string | undefined;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly search?: string | undefined;
  readonly limit: number;
  readonly offset: number;
}

export interface AdminOperationMovement {
  readonly symbol: string;
  readonly amount: number;
  readonly usd: number | null;
  readonly direction: "in" | "out";
}

export interface AdminOperationRow {
  readonly id: string;
  readonly walletId: string;
  readonly walletName: string;
  readonly accountId: string;
  readonly accountName: string;
  readonly ownerId: string;
  readonly ownerEmail: string | null;
  readonly ownerName: string | null;
  readonly opTime: string;
  readonly opType: string;
  readonly chain: string;
  readonly status: string;
  readonly txHash: string;
  readonly protocol: string | null;
  readonly counterparty: string | null;
  readonly netUsd: number | null;
  readonly gasUsd: number | null;
  readonly movements: AdminOperationMovement[];
  readonly notes: string[];
  readonly createdAt: Date;
}

export interface AdminOperationsPage {
  readonly items: AdminOperationRow[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

/** Subset of the frozen ClassifiedOp JSON we surface in the registry. */
interface RawMovement {
  readonly symbol?: unknown;
  readonly amount?: unknown;
  readonly usd?: unknown;
  readonly direction?: unknown;
}
interface RawClassifiedOp {
  readonly netUsd?: unknown;
  readonly gasUsd?: unknown;
  readonly protocol?: { readonly name?: unknown } | null;
  readonly counterparty?: unknown;
  readonly movement?: unknown;
  readonly notes?: unknown;
}

function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function parseRaw(raw: unknown): {
  netUsd: number | null;
  gasUsd: number | null;
  protocol: string | null;
  counterparty: string | null;
  movements: AdminOperationMovement[];
  notes: string[];
} {
  const r = (raw ?? {}) as RawClassifiedOp;
  const movements: AdminOperationMovement[] = Array.isArray(r.movement)
    ? (r.movement as RawMovement[]).map((m) => ({
        symbol: typeof m.symbol === "string" ? m.symbol : "",
        amount: num(m.amount) ?? 0,
        usd: num(m.usd),
        direction: m.direction === "out" ? "out" : "in",
      }))
    : [];
  return {
    netUsd: num(r.netUsd),
    gasUsd: num(r.gasUsd),
    protocol:
      r.protocol && typeof r.protocol.name === "string" ? r.protocol.name : null,
    counterparty: typeof r.counterparty === "string" ? r.counterparty : null,
    movements,
    notes: Array.isArray(r.notes)
      ? (r.notes as unknown[]).filter((n): n is string => typeof n === "string")
      : [],
  };
}

/**
 * Cross-account operations registry — the admin "единое окно" over the
 * on-chain ledger of every user/account/wallet, without impersonation.
 *
 * Source = `chain_operations`: machine-classified on-chain ops (DeBank/
 * Helius → Capflow classifier), persisted server-side. Linked by
 * wallet_id → wallets.account_id → accounts.owner_id, so each row carries
 * full owner/account/wallet identity. The classified payload lives in the
 * frozen `raw` JSON (movements, netUsd, gas, protocol, notes), which we
 * project into a flat row for the table. Offset paging is fine at this
 * scale; keyset on (op_time, id) is the escape hatch if it gets hot.
 */
export class AdminOperationsService {
  constructor(private readonly db: Database) {}

  private buildWhere(f: AdminOperationsFilter): SQL | undefined {
    const conds: SQL[] = [];
    if (f.userId) conds.push(eq(schema.accounts.ownerId, f.userId));
    if (f.accountId) conds.push(eq(schema.wallets.accountId, f.accountId));
    if (f.walletId) conds.push(eq(schema.chainOperations.walletId, f.walletId));
    if (f.opType) conds.push(eq(schema.chainOperations.opType, f.opType));
    if (f.chain) conds.push(eq(schema.chainOperations.chain, f.chain));
    if (f.status) conds.push(eq(schema.chainOperations.status, f.status));
    if (f.from) {
      conds.push(gte(schema.chainOperations.opTime, sql`${f.from}::date`));
    }
    if (f.to) {
      // Inclusive end-of-day: op_time < (to + 1 day).
      conds.push(
        lt(schema.chainOperations.opTime, sql`${f.to}::date + interval '1 day'`)
      );
    }
    if (f.search) {
      const pat = `%${f.search}%`;
      const term = or(
        ilike(schema.chainOperations.txHash, pat),
        ilike(schema.chainOperations.opType, pat),
        ilike(schema.wallets.name, pat),
        ilike(schema.accounts.name, pat),
        sql`${schema.chainOperations.raw}::text ILIKE ${pat}`
      );
      if (term) conds.push(term);
    }
    return conds.length > 0 ? and(...conds) : undefined;
  }

  async list(f: AdminOperationsFilter): Promise<AdminOperationsPage> {
    const where = this.buildWhere(f);

    const rows = await this.db
      .select({
        id: schema.chainOperations.id,
        walletId: schema.chainOperations.walletId,
        walletName: schema.wallets.name,
        accountId: schema.wallets.accountId,
        accountName: schema.accounts.name,
        ownerId: schema.accounts.ownerId,
        ownerEmail: schema.users.email,
        ownerName: schema.users.name,
        opTime: schema.chainOperations.opTime,
        opType: schema.chainOperations.opType,
        chain: schema.chainOperations.chain,
        status: schema.chainOperations.status,
        txHash: schema.chainOperations.txHash,
        raw: schema.chainOperations.raw,
        createdAt: schema.chainOperations.createdAt,
      })
      .from(schema.chainOperations)
      .innerJoin(
        schema.wallets,
        eq(schema.wallets.id, schema.chainOperations.walletId)
      )
      .innerJoin(
        schema.accounts,
        eq(schema.accounts.id, schema.wallets.accountId)
      )
      .innerJoin(schema.users, eq(schema.users.id, schema.accounts.ownerId))
      .where(where)
      .orderBy(
        desc(schema.chainOperations.opTime),
        desc(schema.chainOperations.createdAt)
      )
      .limit(f.limit)
      .offset(f.offset);

    const totalRow = await this.db
      .select({ n: sql<number>`COUNT(*)::int` })
      .from(schema.chainOperations)
      .innerJoin(
        schema.wallets,
        eq(schema.wallets.id, schema.chainOperations.walletId)
      )
      .innerJoin(
        schema.accounts,
        eq(schema.accounts.id, schema.wallets.accountId)
      )
      .innerJoin(schema.users, eq(schema.users.id, schema.accounts.ownerId))
      .where(where);

    return {
      items: rows.map((r) => {
        const p = parseRaw(r.raw);
        return {
          id: r.id,
          walletId: r.walletId,
          walletName: r.walletName,
          accountId: r.accountId,
          accountName: r.accountName,
          ownerId: r.ownerId,
          ownerEmail: r.ownerEmail,
          ownerName: r.ownerName,
          opTime: r.opTime.toISOString(),
          opType: r.opType,
          chain: r.chain,
          status: r.status,
          txHash: r.txHash,
          protocol: p.protocol,
          counterparty: p.counterparty,
          netUsd: p.netUsd,
          gasUsd: p.gasUsd,
          movements: p.movements,
          notes: p.notes,
          createdAt: r.createdAt,
        };
      }),
      total: Number(totalRow[0]?.n ?? 0),
      limit: f.limit,
      offset: f.offset,
    };
  }

  /** Distinct chains + op types present in the ledger — powers the filters. */
  async facets(): Promise<{ chains: string[]; opTypes: string[] }> {
    const [chainRows, typeRows] = await Promise.all([
      this.db
        .selectDistinct({ chain: schema.chainOperations.chain })
        .from(schema.chainOperations)
        .orderBy(schema.chainOperations.chain),
      this.db
        .selectDistinct({ opType: schema.chainOperations.opType })
        .from(schema.chainOperations)
        .orderBy(schema.chainOperations.opType),
    ]);
    return {
      chains: chainRows
        .map((r) => r.chain)
        .filter((c): c is string => c !== null && c.length > 0),
      opTypes: typeRows
        .map((r) => r.opType)
        .filter((t): t is string => t !== null && t.length > 0),
    };
  }
}
