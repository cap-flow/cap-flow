import { ForbiddenError } from "../../core/errors.js";
import type { AuditService } from "../audit/audit.service.js";

import {
  type ChainOpUpsertInput,
  type ChainOperationRow,
  ChainOpsRepository,
} from "./chain-ops.repository.js";
import {
  detectCexHopChains,
  type CexHopChain,
  type CexHopInboundRow,
  type CexHopOutboundRow,
} from "./cex-hop-detector.js";
import {
  detectMultiHopCycles,
  type MultiHopCycle,
} from "./multi-hop-cycles.js";
import {
  detectUntrackedDestinations,
  type WithdrawalRow as UntrackedWithdrawalRow,
} from "./untracked-destinations.js";
import {
  detectSelfBridgeCycles,
  extractMovements,
  matchCrossChainPairs,
  type MatchedCrossChainPair,
  type SelfBridgeCycle,
} from "./internal-transfer-matcher.js";

interface CexHopTransferLookup {
  listAllTransfersWithHashForUser(
    userId: string,
  ): Promise<
    Array<{
      readonly cexAccountId: string;
      readonly exchange: string;
      readonly label: string | null;
      readonly direction: "deposit" | "withdrawal";
      readonly asset: string;
      readonly amount: string;
      readonly txHash: string;
      readonly executedAt: Date;
    }>
  >;
}

/**
 * Walletownership-check для авторизации. Без него любой пользователь
 * мог бы push'нуть/read on-chain ops в любой wallet системы.
 */
export interface IWalletOwnershipCheck {
  walletBelongsToUser(walletId: string, userId: string): Promise<boolean>;
}

export interface ChainOpsBatchInput {
  readonly chain: string;
  readonly txHash: string;
  readonly logIndex?: number;
  readonly opType: string;
  /** Unix seconds, как в ClassifiedOp.time. */
  readonly opTime: number;
  readonly status: string;
  readonly raw?: unknown;
}

export class ChainOpsService {
  constructor(
    private readonly repo: ChainOpsRepository,
    private readonly ownership: IWalletOwnershipCheck,
    private readonly audit: AuditService,
    /**
     * UCB C2: optional CEX transfer lookup для detection хоп цепей
     * (CEX A → wallet → CEX B). Передаётся CexRepository как-есть;
     * берём только метод который нужен — listAllTransfersWithHashForUser.
     */
    private readonly cexLookup?: CexHopTransferLookup,
  ) {}

  /**
   * Bulk-sync ops для одного wallet'а. Idempotent через
   * `(wallet, tx_hash, log_index)` unique index. UCB B5.
   */
  async syncBatch(
    walletId: string,
    userId: string,
    ops: readonly ChainOpsBatchInput[],
  ): Promise<{ inserted: number; total: number }> {
    const owned = await this.ownership.walletBelongsToUser(walletId, userId);
    if (!owned) throw new ForbiddenError(`Wallet ${walletId} not accessible.`);

    const valid: ChainOpUpsertInput[] = [];
    for (const o of ops) {
      if (!o.chain || !o.txHash || !o.opType) continue;
      if (!Number.isFinite(o.opTime) || o.opTime <= 0) continue;
      valid.push({
        walletId,
        chain: o.chain,
        txHash: o.txHash.toLowerCase(),
        logIndex: o.logIndex ?? 0,
        opType: o.opType,
        opTime: new Date(o.opTime * 1000),
        status: o.status || "ok",
        raw: o.raw,
      });
    }

    try {
      const inserted = await this.repo.upsertBatch(valid);
      await this.repo.markSyncSuccess(walletId);
      await this.audit.log({
        actorUserId: userId,
        action: "chain_ops.sync",
        target: walletId,
        payload: { inserted, total: ops.length, skipped: ops.length - valid.length },
      });
      return { inserted, total: ops.length };
    } catch (e) {
      const msg = (e as Error).message;
      await this.repo.markSyncError(walletId, msg);
      throw e;
    }
  }

  /** Read ops для одного wallet'а — newest first. */
  async listByWallet(
    walletId: string,
    userId: string,
    options: { limit?: number } = {},
  ): Promise<ChainOperationRow[]> {
    const owned = await this.ownership.walletBelongsToUser(walletId, userId);
    if (!owned) throw new ForbiddenError(`Wallet ${walletId} not accessible.`);
    return this.repo.listByWallet(walletId, options);
  }

  /**
   * Sync-state для wallet'а — UI показывает «last synced X ago».
   * Также latest_op_time для delta-refresh.
   */
  async syncStatus(
    walletId: string,
    userId: string,
  ): Promise<{
    walletId: string;
    latestOpTime: Date | null;
    /** Cached count — для UI hint. */
    opsCount: number;
  }> {
    const owned = await this.ownership.walletBelongsToUser(walletId, userId);
    if (!owned) throw new ForbiddenError(`Wallet ${walletId} not accessible.`);
    const latestOpTime = await this.repo.latestOpTimestamp(walletId);
    const ops = await this.repo.listByWallet(walletId);
    return { walletId, latestOpTime, opsCount: ops.length };
  }

  /**
   * UCB A1 (Layer 1): server-side cross-wallet self-transfer detection
   * через tx_hash equality. Scope ограничен wallets текущего user'а.
   *
   * Возвращает пары `(from_wallet, to_wallet, tx_hash, ...)` для same-chain
   * self-transfers. UI / cost basis pipeline помечает эти ops как
   * **internal** — cost basis НЕ пересчитывается по spot, а наследуется
   * между wallets (UCB invariant: own movements don't realize PnL).
   *
   * Cross-chain bridges (eth→arb через Across/Stargate) с РАЗНЫМИ
   * tx_hashes — Layer 2 (A2 in roadmap), пока обрабатываются client-side
   * heuristic'ом `findInternalTransferPairs`.
   */
  async findCrossWalletInternalTransfers(
    userId: string,
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
    const walletIds = await this.repo.listUserWalletIds(userId);
    if (walletIds.length < 2) return [];
    const pairs = await this.repo.findCrossWalletSameHashPairs(walletIds);
    await this.audit.log({
      actorUserId: userId,
      action: "chain_ops.graph_internal_transfers",
      target: userId,
      payload: { walletCount: walletIds.length, pairsFound: pairs.length },
    });
    return pairs;
  }

  /**
   * UCB A2 (Layer 2): cross-chain fuzzy internal-transfer matching.
   *
   * Tx_hash на двух сторонах bridge'а РАЗНЫЙ (eth → arb через Across),
   * поэтому L1 (`findCrossWalletSameHashPairs`) их не ловит. Здесь:
   *   1. Тянем все transfer_in/out, bridge_in/out, *_fiat ops user'а
   *   2. Извлекаем `movement[]` из `raw` JSONB
   *   3. Прогоняем heuristic matcher (time ±60min, symbol family,
   *      amount ±5/10%, разные wallets)
   *
   * НЕ дублирует L1: tx_hash equality исключается в `matchCrossChainPairs`.
   */
  async findCrossChainInternalTransfers(userId: string): Promise<
    {
      readonly outTxHash: string;
      readonly inTxHash: string;
      readonly outChain: string;
      readonly inChain: string;
      readonly outWalletId: string;
      readonly inWalletId: string;
      readonly symbol: string;
      readonly outAmount: number;
      readonly inAmount: number;
      readonly feeUsd: number;
      readonly outRaw: unknown;
      readonly inRaw: unknown;
    }[]
  > {
    const walletIds = await this.repo.listUserWalletIds(userId);
    if (walletIds.length < 2) return [];

    const rows = await this.repo.listOpsByTypes(walletIds, [
      "transfer_in",
      "transfer_out",
      "bridge_in",
      "bridge_out",
      "deposit_fiat",
      "withdraw_fiat",
    ]);
    const movements = extractMovements(rows);
    const pairs = matchCrossChainPairs(movements);
    await this.audit.log({
      actorUserId: userId,
      action: "chain_ops.graph_cross_chain_internal_transfers",
      target: userId,
      payload: {
        walletCount: walletIds.length,
        opsScanned: rows.length,
        pairsFound: pairs.length,
      },
    });
    return pairs;
  }

  /**
   * UCB A5: найти A→B→A self-bridge петли. Используем same data flow
   * как findCrossChainInternalTransfers — extract movements → match
   * pairs — потом передаём pairs в `detectSelfBridgeCycles`.
   *
   * Возвращает list cycles с обоими leg-pairs и aggregate fee USD.
   * Каждый pair, попавший в cycle, всё равно фигурирует в L2 pairs
   * response — это **дополнительный** аналитический слой, не замена.
   */
  async findSelfBridgeCycles(userId: string): Promise<SelfBridgeCycle[]> {
    const walletIds = await this.repo.listUserWalletIds(userId);
    if (walletIds.length < 2) return [];
    const rows = await this.repo.listOpsByTypes(walletIds, [
      "transfer_in",
      "transfer_out",
      "bridge_in",
      "bridge_out",
      "deposit_fiat",
      "withdraw_fiat",
    ]);
    const movements = extractMovements(rows);
    const pairs: MatchedCrossChainPair[] = matchCrossChainPairs(movements);
    const cycles = detectSelfBridgeCycles(pairs);
    await this.audit.log({
      actorUserId: userId,
      action: "chain_ops.graph_self_bridge_cycles",
      target: userId,
      payload: {
        walletCount: walletIds.length,
        pairsScanned: pairs.length,
        cyclesFound: cycles.length,
      },
    });
    return cycles;
  }

  /**
   * UCB Bob-test fix #4: CEX withdrawals чьи tx_hash НЕ tracked в on-chain
   * wallets user'а. Hint показывает scope "lost cost basis trail" — user
   * может подключить cold wallet для recovery.
   */
  async findUntrackedDestinations(
    userId: string,
  ): Promise<UntrackedWithdrawalRow[]> {
    if (!this.cexLookup) return [];
    const walletIds = await this.repo.listUserWalletIds(userId);
    const cexTransfers = await this.cexLookup.listAllTransfersWithHashForUser(
      userId,
    );

    // Get all tracked on-chain hashes (any op type, любого wallet user'а).
    const trackedSet = new Set<string>();
    if (walletIds.length > 0) {
      const ops = await this.repo.listOpsByTypes(walletIds, [
        "transfer_in",
        "transfer_out",
        "bridge_in",
        "bridge_out",
        "deposit_fiat",
        "withdraw_fiat",
        "swap",
      ]);
      for (const o of ops) trackedSet.add(o.txHash.toLowerCase());
    }

    const withdrawals: UntrackedWithdrawalRow[] = cexTransfers
      .filter((t) => t.direction === "withdrawal" && t.txHash)
      .map((t) => ({
        txHash: t.txHash,
        asset: t.asset,
        amount: Number(t.amount),
        exchange: t.exchange,
        executedAt: t.executedAt,
      }));

    const untracked = detectUntrackedDestinations(withdrawals, trackedSet);
    await this.audit.log({
      actorUserId: userId,
      action: "chain_ops.untracked_destinations",
      target: userId,
      payload: {
        totalWithdrawals: withdrawals.length,
        untrackedCount: untracked.length,
      },
    });
    return untracked;
  }

  /**
   * UCB A5.2: multi-hop cycles (N-leg loops A→B→C→...→A).
   * Reuses pairs из L2 matcher. См. `multi-hop-cycles.ts` для алгоритма.
   */
  async findMultiHopCycles(userId: string): Promise<MultiHopCycle[]> {
    const walletIds = await this.repo.listUserWalletIds(userId);
    if (walletIds.length < 2) return [];
    const rows = await this.repo.listOpsByTypes(walletIds, [
      "transfer_in",
      "transfer_out",
      "bridge_in",
      "bridge_out",
      "deposit_fiat",
      "withdraw_fiat",
    ]);
    const movements = extractMovements(rows);
    const pairs: MatchedCrossChainPair[] = matchCrossChainPairs(movements);
    const cycles = detectMultiHopCycles(pairs);
    await this.audit.log({
      actorUserId: userId,
      action: "chain_ops.graph_multi_hop_cycles",
      target: userId,
      payload: {
        pairsScanned: pairs.length,
        cyclesFound: cycles.length,
        maxLegs: cycles.reduce((m, c) => Math.max(m, c.legs.length), 0),
      },
    });
    return cycles;
  }

  /**
   * UCB C2: detect CEX A → on-chain wallet → CEX B hop chains.
   *
   * Pipeline:
   *   1. Если cexLookup не передан — return [].
   *   2. Получаем все CEX transfers с tx hash для user'а.
   *   3. Получаем все on-chain transfer/bridge ops в его wallets.
   *   4. Build inbound (CEX wd → wallet transfer_in/bridge_in) +
   *      outbound (wallet transfer_out/bridge_out → CEX dep) rows.
   *   5. Прогоняем через `detectCexHopChains` (pure function).
   *
   * Hash matching — exact (lowercase normalized). Cost basis chain
   * существует только если client уже POST'ил seeds (C1) для outbound
   * и server-side P2P/trade history покрывает inbound (D3).
   */
  async findCexHopChains(userId: string): Promise<CexHopChain[]> {
    if (!this.cexLookup) return [];
    const walletIds = await this.repo.listUserWalletIds(userId);
    if (walletIds.length === 0) return [];

    const [cexTransfers, chainOps] = await Promise.all([
      this.cexLookup.listAllTransfersWithHashForUser(userId),
      this.repo.listOpsByTypes(walletIds, [
        "transfer_in",
        "transfer_out",
        "bridge_in",
        "bridge_out",
      ]),
    ]);

    // Index CEX transfers by lowercase tx hash.
    const cexByHash = new Map<
      string,
      (typeof cexTransfers)[number]
    >();
    for (const t of cexTransfers) {
      cexByHash.set(t.txHash.toLowerCase(), t);
    }

    const inbound: CexHopInboundRow[] = [];
    const outbound: CexHopOutboundRow[] = [];
    for (const op of chainOps) {
      const h = op.txHash.toLowerCase();
      const cex = cexByHash.get(h);
      if (!cex) continue;
      const raw = op.raw as
        | { movement?: ReadonlyArray<{ direction?: string; symbol?: string; amount?: number }> }
        | null
        | undefined;
      const movs = Array.isArray(raw?.movement) ? raw.movement : [];
      const timeSec = Math.floor(op.opTime.getTime() / 1000);

      if (
        cex.direction === "withdrawal" &&
        (op.opType === "transfer_in" || op.opType === "bridge_in")
      ) {
        const inMov = movs.find((m) => m.direction === "in" && Number(m.amount) > 0);
        if (!inMov || !inMov.symbol) continue;
        inbound.push({
          walletId: op.walletId,
          chain: op.chain,
          txHash: h,
          symbol: inMov.symbol,
          amount: Number(inMov.amount),
          timeSec,
          cexAccountId: cex.cexAccountId,
          cexExchange: cex.exchange,
        });
      } else if (
        cex.direction === "deposit" &&
        (op.opType === "transfer_out" || op.opType === "bridge_out")
      ) {
        const outMov = movs.find((m) => m.direction === "out" && Number(m.amount) > 0);
        if (!outMov || !outMov.symbol) continue;
        outbound.push({
          walletId: op.walletId,
          chain: op.chain,
          txHash: h,
          symbol: outMov.symbol,
          amount: Number(outMov.amount),
          timeSec,
          cexAccountId: cex.cexAccountId,
          cexExchange: cex.exchange,
        });
      }
    }

    const chains = detectCexHopChains(inbound, outbound);
    await this.audit.log({
      actorUserId: userId,
      action: "chain_ops.graph_cex_hops",
      target: userId,
      payload: {
        inboundCount: inbound.length,
        outboundCount: outbound.length,
        chainsFound: chains.length,
      },
    });
    return chains;
  }
}
