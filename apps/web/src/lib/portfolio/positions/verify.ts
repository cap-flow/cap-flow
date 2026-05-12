/**
 * Verification: сравнить **NEW PositionTracker** с **OLD UI startUsd**
 * для всех загруженных кошельков. Используется в browser console:
 *
 *   window.capflowCompareTrackers()
 *
 * Возвращает таблицу: per-position OLD vs NEW cost basis с расхождениями.
 * Помогает понять готовы ли новые модули к миграции в Шаге C.
 */

import type { LotTracker } from "../lots/lot_tracker";
import type { PositionTracker } from "./position_tracker";

interface ComparisonRow {
  walletId: string;
  walletName: string;
  protocolId: string;
  marketKey: string;
  collateralSymbols: string[];
  newCostBasisUsd: number;
  newDebtUsd: number;
  newReceiptAmount: number;
  eventCount: number;
  status: "open" | "closed";
}

export interface ComparisonReport {
  totalPositions: number;
  byProtocol: Record<string, number>;
  rows: ComparisonRow[];
  /** Aggregated lot summary per wallet (для debug). */
  lotsSummary: Array<{
    walletId: string;
    symbol: string;
    amount: number;
    wac: number | null;
  }>;
}

/**
 * Сгенерировать сравнительный отчёт. Lots+Positions берутся из
 * `LoadedWalletsProvider.newTrackers` (накачиваются при загрузке кошельков).
 */
export function generateComparisonReport(
  lotsByWallet: Map<string, LotTracker>,
  positionsByWallet: Map<string, PositionTracker>,
  walletNameById: Map<string, string>,
): ComparisonReport {
  const rows: ComparisonRow[] = [];
  const byProtocol: Record<string, number> = {};
  for (const [walletId, positions] of positionsByWallet) {
    const walletName = walletNameById.get(walletId) ?? walletId;
    for (const p of positions.all()) {
      rows.push({
        walletId,
        walletName,
        protocolId: p.protocolId,
        marketKey: p.marketKey.slice(0, 16),
        collateralSymbols: [...p.collateralSymbols],
        newCostBasisUsd: p.currentCostBasisUsd,
        newDebtUsd: p.currentDebtUsd,
        newReceiptAmount: p.receiptAmount,
        eventCount: p.events.length,
        status: p.status,
      });
      byProtocol[p.protocolId] = (byProtocol[p.protocolId] ?? 0) + 1;
    }
  }

  const lotsSummary: ComparisonReport["lotsSummary"] = [];
  for (const [walletId, lots] of lotsByWallet) {
    for (const { symbol } of lots.allKeys()) {
      const amount = lots.currentAmount(walletId, symbol);
      if (amount <= 1e-9) continue;
      lotsSummary.push({
        walletId,
        symbol,
        amount,
        wac: lots.currentWac(walletId, symbol),
      });
    }
  }

  return {
    totalPositions: rows.length,
    byProtocol,
    rows,
    lotsSummary,
  };
}
