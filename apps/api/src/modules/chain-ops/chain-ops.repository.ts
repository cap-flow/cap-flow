import { type Database, schema } from "@cap-flow/db";
import { aliasedTable, and, asc, desc, eq, inArray, sql } from "drizzle-orm";

export type ChainOperationRow = typeof schema.chainOperations.$inferSelect;

/**
 * Проверка ownership: wallet принадлежит account, owned by user.
 * Используется в route-handler'ах перед каждым read/write.
 */
export async function walletBelongsToUser(
  db: Database,
  walletId: string,
  userId: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: schema.wallets.id })
    .from(schema.wallets)
    .innerJoin(
      schema.accounts,
      eq(schema.accounts.id, schema.wallets.accountId),
    )
    .where(
      and(eq(schema.wallets.id, walletId), eq(schema.accounts.ownerId, userId)),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * UCB B5.1: server-side persistence on-chain ops. Repository contract
 * intentionally minimal — три операции: idempotent upsert batch,
 * list-by-wallet, multi-wallet lookup by hash (для UCB graph traversal
 * этапа A1).
 */
export interface ChainOpUpsertInput {
  readonly walletId: string;
  readonly chain: string;
  readonly txHash: string;
  /** Multiple events в одной транзакции (swap + LP add) различаются по log_index. */
  readonly logIndex: number;
  readonly opType: string;
  readonly opTime: Date;
  readonly status: string;
  /** Сырой ClassifiedOp как пришёл от DeBank/Helius classifier'а. */
  readonly raw: unknown;
}

export class ChainOpsRepository {
  constructor(private readonly db: Database) {}

  /**
   * Bulk-upsert ops. Returns count of NEW rows inserted (existing — UPDATE'нуты
   * через `onConflictDoUpdate`, не учитываются в counter).
   *
   * **Зачем `overwrite`** (`SET` non-key fields): client может пере-classify
   * прошлые ops если classifier-логика обновилась (например fix для GMX V2
   * cost basis). Repeat sync должен заменить старую raw на свежую,
   * не только skip duplicate.
   */
  async upsertBatch(ops: readonly ChainOpUpsertInput[]): Promise<number> {
    if (ops.length === 0) return 0;
    const inserted = await this.db
      .insert(schema.chainOperations)
      .values(
        ops.map((o) => ({
          walletId: o.walletId,
          chain: o.chain,
          txHash: o.txHash,
          logIndex: o.logIndex,
          opType: o.opType,
          opTime: o.opTime,
          status: o.status,
          raw: o.raw as Record<string, unknown>,
        })),
      )
      .onConflictDoUpdate({
        target: [
          schema.chainOperations.walletId,
          schema.chainOperations.txHash,
          schema.chainOperations.logIndex,
        ],
        set: {
          chain: sql`EXCLUDED.chain`,
          opType: sql`EXCLUDED.op_type`,
          opTime: sql`EXCLUDED.op_time`,
          status: sql`EXCLUDED.status`,
          raw: sql`EXCLUDED.raw`,
          updatedAt: sql`now()`,
        },
      })
      .returning({ id: schema.chainOperations.id });
    return inserted.length;
  }

  /** List ops для одного wallet'а в хронологии (newest first by default). */
  async listByWallet(
    walletId: string,
    options: { readonly limit?: number; readonly order?: "asc" | "desc" } = {},
  ): Promise<ChainOperationRow[]> {
    const order = options.order ?? "desc";
    const q = this.db
      .select()
      .from(schema.chainOperations)
      .where(eq(schema.chainOperations.walletId, walletId))
      .orderBy(
        order === "desc"
          ? desc(schema.chainOperations.opTime)
          : asc(schema.chainOperations.opTime),
      );
    return options.limit ? q.limit(options.limit) : q;
  }

  /**
   * Cross-wallet lookup by tx_hash — для UCB graph traversal (этап A1).
   * Возвращает все ops с этим hash через **любые** wallet'ы из переданного
   * списка. Используется в cross_wallet_cost_basis_tracker.
   */
  async findByHash(
    walletIds: readonly string[],
    txHash: string,
  ): Promise<ChainOperationRow[]> {
    if (walletIds.length === 0) return [];
    return this.db
      .select()
      .from(schema.chainOperations)
      .where(
        and(
          inArray(schema.chainOperations.walletId, [...walletIds]),
          eq(schema.chainOperations.txHash, txHash),
        ),
      );
  }

  /**
   * Latest op-time per wallet — используется для delta-refresh (B5.4).
   * `start_time` для DeBank/Helius pull = `latestOpTime + 1`.
   */
  async latestOpTimestamp(walletId: string): Promise<Date | null> {
    const rows = await this.db
      .select({ t: schema.chainOperations.opTime })
      .from(schema.chainOperations)
      .where(eq(schema.chainOperations.walletId, walletId))
      .orderBy(desc(schema.chainOperations.opTime))
      .limit(1);
    return rows[0]?.t ?? null;
  }

  /**
   * Mark wallet'а как successfully synced. Очищает last_ops_sync_error.
   */
  async markSyncSuccess(walletId: string): Promise<void> {
    await this.db
      .update(schema.wallets)
      .set({ lastOpsSyncAt: new Date(), lastOpsSyncError: null })
      .where(eq(schema.wallets.id, walletId));
  }

  /** Mark wallet'а sync upadл — записать error message. */
  async markSyncError(walletId: string, errorMsg: string): Promise<void> {
    await this.db
      .update(schema.wallets)
      .set({ lastOpsSyncError: errorMsg.slice(0, 500) })
      .where(eq(schema.wallets.id, walletId));
  }

  /**
   * UCB A1 (Layer 1): cross-wallet self-transfer detection через exact
   * tx_hash matching между ops двух разных wallets одного и того же user.
   *
   * Когда юзер двигает токены wallet A → wallet B на ОДНОЙ chain (eth → eth,
   * arb → arb), tx_hash идентичен на обеих сторонах — мы видим одну запись
   * как `transfer_out` (wallet A view) и одну как `transfer_in` (wallet B
   * view). Это deterministic high-confidence signal: пара выявляется
   * **точно**, без time/amount heuristics.
   *
   * Возвращает массив `(out_row, in_row)`-пар. `walletIds` ограничивает
   * scope — caller передаёт wallets из текущего account'а, чтобы не было
   * cross-tenant утечек.
   *
   * Cross-chain bridges (eth → arb через Across/Stargate) имеют РАЗНЫЕ
   * tx_hashes и НЕ покрываются этим Layer 1. Это agenda Layer 2 (heuristic
   * time+amount fuzzy match — A2 in roadmap).
   */
  async findCrossWalletSameHashPairs(
    walletIds: readonly string[],
  ): Promise<
    {
      readonly txHash: string;
      readonly chain: string;
      readonly opTime: Date;
      readonly outWalletId: string;
      readonly outOpType: string;
      readonly outRaw: unknown;
      readonly inWalletId: string;
      readonly inOpType: string;
      readonly inRaw: unknown;
    }[]
  > {
    if (walletIds.length < 2) return [];
    const o = aliasedTable(schema.chainOperations, "o");
    const i = aliasedTable(schema.chainOperations, "i");
    const ids = [...walletIds];

    // SELF-JOIN на tx_hash. Условия:
    //   - оба op'а — из переданного набора wallet ids
    //   - разные wallets (чтобы не мэтчить op сам с собой)
    //   - левая сторона = out-type (transfer_out / bridge_out / withdraw_fiat)
    //   - правая сторона = in-type (transfer_in / bridge_in / deposit_fiat)
    //
    // `WHERE o.wallet_id < i.wallet_id` НЕ ставим: out и in роли асимметричны,
    // и мы хотим именно (out_wallet → in_wallet) ordering. Дубликатов не
    // будет потому что один tx_hash имеет ровно одну out и одну in запись
    // (один и тот же tx с точки зрения чейна).
    const rows = await this.db
      .select({
        txHash: o.txHash,
        chain: o.chain,
        opTime: o.opTime,
        outWalletId: o.walletId,
        outOpType: o.opType,
        outRaw: o.raw,
        inWalletId: i.walletId,
        inOpType: i.opType,
        inRaw: i.raw,
      })
      .from(o)
      .innerJoin(
        i,
        and(eq(o.txHash, i.txHash), sql`${o.walletId} <> ${i.walletId}`),
      )
      .where(
        and(
          inArray(o.walletId, ids),
          inArray(i.walletId, ids),
          inArray(o.opType, ["transfer_out", "bridge_out", "withdraw_fiat"]),
          inArray(i.opType, ["transfer_in", "bridge_in", "deposit_fiat"]),
        ),
      )
      .orderBy(desc(o.opTime));
    return rows;
  }

  /**
   * UCB A2 helper: list ops по wallet-ids + op_type whitelist'у.
   * Используется матчером Layer 2 — мы тянем все transfer_in/transfer_out/
   * bridge_in/bridge_out/deposit_fiat/withdraw_fiat ops в одной выборке,
   * чтобы потом пройтись по ним в памяти и сматчить cross-chain пары.
   *
   * Возвращает только нужные columns (без `id`, `created_at` — экономим
   * payload). `raw` нужен для извлечения movements.
   */
  async listOpsByTypes(
    walletIds: readonly string[],
    opTypes: readonly string[],
  ): Promise<
    {
      readonly walletId: string;
      readonly chain: string;
      readonly txHash: string;
      readonly opType: string;
      readonly opTime: Date;
      readonly raw: unknown;
    }[]
  > {
    if (walletIds.length === 0 || opTypes.length === 0) return [];
    return this.db
      .select({
        walletId: schema.chainOperations.walletId,
        chain: schema.chainOperations.chain,
        txHash: schema.chainOperations.txHash,
        opType: schema.chainOperations.opType,
        opTime: schema.chainOperations.opTime,
        raw: schema.chainOperations.raw,
      })
      .from(schema.chainOperations)
      .where(
        and(
          inArray(schema.chainOperations.walletId, [...walletIds]),
          inArray(schema.chainOperations.opType, [...opTypes]),
        ),
      )
      .orderBy(desc(schema.chainOperations.opTime));
  }

  /**
   * Helper: все walletIds, принадлежащие user через accounts.owner_id.
   * Используется для scope'инга graph-queries — нельзя матчить чужие
   * wallets даже если случайно txhash совпал.
   */
  async listUserWalletIds(userId: string): Promise<string[]> {
    const rows = await this.db
      .select({ id: schema.wallets.id })
      .from(schema.wallets)
      .innerJoin(
        schema.accounts,
        eq(schema.accounts.id, schema.wallets.accountId),
      )
      .where(eq(schema.accounts.ownerId, userId));
    return rows.map((r) => r.id);
  }
}
