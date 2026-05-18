/**
 * UCB B4: aggregated sync coverage state per user.
 *
 * Возвращает единый snapshot:
 *   - all on-chain wallets (last sync time / error / ops count)
 *   - all CEX accounts (last sync per data-type / errors / trades + transfers + p2p counts)
 *
 * Один read-only endpoint, UI потребляет для отрисовки "что-где-сколько
 * просинкано". Нужен пользователю чтобы увидеть gaps в данных и принять
 * решение что requeue'ить.
 */
import { type Database, schema } from "@cap-flow/db";
import { count, eq, inArray, sql } from "drizzle-orm";

export interface WalletCoverage {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly lastSyncAt: Date | null;
  readonly lastSyncError: string | null;
  readonly opsCount: number;
}

export interface CexAccountCoverage {
  readonly id: string;
  readonly exchange: string;
  readonly label: string | null;
  readonly lastSyncAt: Date | null;
  readonly lastSyncError: string | null;
  readonly lastTradesSyncAt: Date | null;
  readonly lastTradesSyncError: string | null;
  readonly lastInternalTransfersSyncAt: Date | null;
  readonly lastInternalTransfersSyncError: string | null;
  readonly tradesCount: number;
  readonly transfersCount: number;
  readonly internalTransfersCount: number;
  readonly p2pCount: number;
}

export interface SyncCoverage {
  readonly wallets: WalletCoverage[];
  readonly cexAccounts: CexAccountCoverage[];
}

export class SyncCoverageService {
  constructor(private readonly db: Database) {}

  async getCoverage(userId: string): Promise<SyncCoverage> {
    const [wallets, cexAccounts] = await Promise.all([
      this.listWallets(userId),
      this.listCexAccounts(userId),
    ]);
    return { wallets, cexAccounts };
  }

  private async listWallets(userId: string): Promise<WalletCoverage[]> {
    // Все wallets user'а через accounts.owner_id + count chain_operations.
    // Левый JOIN'им и группируем для одно-проходного запроса.
    const rows = await this.db
      .select({
        id: schema.wallets.id,
        name: schema.wallets.name,
        kind: schema.wallets.kind,
        lastSyncAt: schema.wallets.lastOpsSyncAt,
        lastSyncError: schema.wallets.lastOpsSyncError,
        opsCount: count(schema.chainOperations.id),
      })
      .from(schema.wallets)
      .innerJoin(
        schema.accounts,
        eq(schema.accounts.id, schema.wallets.accountId),
      )
      .leftJoin(
        schema.chainOperations,
        eq(schema.chainOperations.walletId, schema.wallets.id),
      )
      .where(eq(schema.accounts.ownerId, userId))
      .groupBy(
        schema.wallets.id,
        schema.wallets.name,
        schema.wallets.kind,
        schema.wallets.lastOpsSyncAt,
        schema.wallets.lastOpsSyncError,
      )
      .orderBy(schema.wallets.name);
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      kind: r.kind,
      lastSyncAt: r.lastSyncAt,
      lastSyncError: r.lastSyncError,
      opsCount: Number(r.opsCount),
    }));
  }

  private async listCexAccounts(userId: string): Promise<CexAccountCoverage[]> {
    // CEX accounts + counts of trades / transfers / p2p_orders.
    // Делаем base SELECT + 3 параллельных count-queries, потом merge'им
    // в памяти. SQL-side aggregation работает плохо со множественными
    // left-joins из-за multiplicative row-explosion.
    const accounts = await this.db
      .select({
        id: schema.cexAccounts.id,
        exchange: schema.cexAccounts.exchange,
        label: schema.cexAccounts.label,
        lastSyncAt: schema.cexAccounts.lastSyncedAt,
        lastSyncError: schema.cexAccounts.lastSyncError,
        lastTradesSyncAt: schema.cexAccounts.lastTradesSyncAt,
        lastTradesSyncError: schema.cexAccounts.lastTradesSyncError,
        lastInternalTransfersSyncAt:
          schema.cexAccounts.lastInternalTransfersSyncAt,
        lastInternalTransfersSyncError:
          schema.cexAccounts.lastInternalTransfersSyncError,
      })
      .from(schema.cexAccounts)
      .where(
        sql`${schema.cexAccounts.userId} = ${userId} AND ${schema.cexAccounts.archivedAt} IS NULL`,
      )
      .orderBy(schema.cexAccounts.exchange);

    if (accounts.length === 0) return [];
    const accountIds = accounts.map((a) => a.id);

    const [tradesByAcc, transfersByAcc, internalByAcc, p2pByAcc] =
      await Promise.all([
        this.db
          .select({
            accId: schema.cexTrades.cexAccountId,
            c: count(schema.cexTrades.id),
          })
          .from(schema.cexTrades)
          .where(inArray(schema.cexTrades.cexAccountId, accountIds))
          .groupBy(schema.cexTrades.cexAccountId),
        this.db
          .select({
            accId: schema.cexTransfers.cexAccountId,
            c: count(schema.cexTransfers.id),
          })
          .from(schema.cexTransfers)
          .where(inArray(schema.cexTransfers.cexAccountId, accountIds))
          .groupBy(schema.cexTransfers.cexAccountId),
        this.db
          .select({
            accId: schema.cexInternalTransfers.cexAccountId,
            c: count(schema.cexInternalTransfers.id),
          })
          .from(schema.cexInternalTransfers)
          .where(
            inArray(schema.cexInternalTransfers.cexAccountId, accountIds),
          )
          .groupBy(schema.cexInternalTransfers.cexAccountId),
        this.db
          .select({
            accId: schema.cexP2pOrders.cexAccountId,
            c: count(schema.cexP2pOrders.id),
          })
          .from(schema.cexP2pOrders)
          .where(inArray(schema.cexP2pOrders.cexAccountId, accountIds))
          .groupBy(schema.cexP2pOrders.cexAccountId),
      ]);

    const tradesMap = new Map(tradesByAcc.map((r) => [r.accId, Number(r.c)]));
    const transfersMap = new Map(
      transfersByAcc.map((r) => [r.accId, Number(r.c)]),
    );
    const internalMap = new Map(
      internalByAcc.map((r) => [r.accId, Number(r.c)]),
    );
    const p2pMap = new Map(p2pByAcc.map((r) => [r.accId, Number(r.c)]));

    return accounts.map((a) => ({
      id: a.id,
      exchange: a.exchange,
      label: a.label,
      lastSyncAt: a.lastSyncAt,
      lastSyncError: a.lastSyncError,
      lastTradesSyncAt: a.lastTradesSyncAt,
      lastTradesSyncError: a.lastTradesSyncError,
      lastInternalTransfersSyncAt: a.lastInternalTransfersSyncAt,
      lastInternalTransfersSyncError: a.lastInternalTransfersSyncError,
      tradesCount: tradesMap.get(a.id) ?? 0,
      transfersCount: transfersMap.get(a.id) ?? 0,
      internalTransfersCount: internalMap.get(a.id) ?? 0,
      p2pCount: p2pMap.get(a.id) ?? 0,
    }));
  }
}
