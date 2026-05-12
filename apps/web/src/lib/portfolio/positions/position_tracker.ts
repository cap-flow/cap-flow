/**
 * `PositionTracker` — реестр позиций per (walletId, protocolId, marketKey)
 * c полным event log.
 *
 * Заполняется через `buildPositionsFromOps` который проходит по ops
 * хронологически и эмитит events. Lot-attribution делается через
 * `LotTracker` (Фаза 3).
 *
 * После заполнения каждый запрос (open positions UI, dashboard analytics,
 * closed positions archive) делается через детерминированный pure-функций
 * проход по events.
 */

import type { LotTracker } from "../lots/lot_tracker";
import type { Position, PositionEvent } from "./types";

export class PositionTracker {
  private readonly positions = new Map<string, Position>();

  /** Уникальный ключ позиции — `${walletId}|${protocolId}|${marketKey}`. */
  static keyOf(walletId: string, protocolId: string, marketKey: string): string {
    return `${walletId}|${protocolId}|${marketKey}`.toLowerCase();
  }

  /**
   * Зарегистрировать новый event позиции. Если позиция не существует —
   * создаётся с этим event'ом как `open`.
   */
  recordEvent(
    walletId: string,
    walletName: string,
    protocolId: string,
    protocolName: string,
    chain: string,
    marketKey: string,
    event: PositionEvent,
  ): void {
    const k = PositionTracker.keyOf(walletId, protocolId, marketKey);
    const existing = this.positions.get(k);
    if (!existing) {
      // Создаём новую позицию.
      const collateralSymbols = new Set<string>();
      const debtSymbols = new Set<string>();
      for (const t of event.outTokens) collateralSymbols.add(t.symbol);
      this.positions.set(k, {
        walletId,
        walletName,
        protocolId,
        protocolName,
        chain,
        marketKey,
        collateralSymbols: [...collateralSymbols],
        debtSymbols: [...debtSymbols],
        events: [event],
        currentCostBasisUsd: this.deltaCostBasis(event),
        currentDebtUsd: this.deltaDebt(event),
        receiptAmount: event.receiptDelta ?? 0,
        openedAt: event.time,
        status: "open",
      });
      return;
    }
    // Расширяем существующую.
    const collateralSet = new Set(existing.collateralSymbols);
    const debtSet = new Set(existing.debtSymbols);
    if (event.type === "deposit_collateral") {
      for (const t of event.outTokens) collateralSet.add(t.symbol);
    }
    if (event.type === "borrow") {
      for (const t of event.inTokens) debtSet.add(t.symbol);
    }
    const newReceiptAmount = existing.receiptAmount + (event.receiptDelta ?? 0);
    const newCostBasis = existing.currentCostBasisUsd + this.deltaCostBasis(event);
    const newDebt = existing.currentDebtUsd + this.deltaDebt(event);

    const isClosed = newReceiptAmount < 1e-9 && newCostBasis < 1 && newDebt < 1;
    this.positions.set(k, {
      ...existing,
      collateralSymbols: [...collateralSet],
      debtSymbols: [...debtSet],
      events: [...existing.events, event],
      currentCostBasisUsd: Math.max(0, newCostBasis),
      currentDebtUsd: Math.max(0, newDebt),
      receiptAmount: Math.max(0, newReceiptAmount),
      status: isClosed ? "closed" : "open",
      ...(isClosed ? { closedAt: event.time } : {}),
    });
  }

  /** Получить позицию по ключу. */
  get(walletId: string, protocolId: string, marketKey: string): Position | null {
    return (
      this.positions.get(
        PositionTracker.keyOf(walletId, protocolId, marketKey),
      ) ?? null
    );
  }

  /** Все открытые позиции. */
  open(): readonly Position[] {
    return [...this.positions.values()].filter((p) => p.status === "open");
  }

  /** Все закрытые позиции (для архивa). */
  closed(): readonly Position[] {
    return [...this.positions.values()].filter((p) => p.status === "closed");
  }

  /** Все позиции (открытые + закрытые). */
  all(): readonly Position[] {
    return [...this.positions.values()];
  }

  /** Найти позицию по walletId + protocolId + (любой match по symbols). */
  findByCollateral(
    walletId: string,
    protocolId: string,
    collateralSymbol: string,
  ): Position | null {
    for (const p of this.positions.values()) {
      if (p.walletId !== walletId || p.protocolId !== protocolId) continue;
      if (p.collateralSymbols.includes(collateralSymbol)) return p;
    }
    return null;
  }

  // ─── Private ─────────────────────────────────────────────────────────

  private deltaCostBasis(event: PositionEvent): number {
    switch (event.type) {
      case "deposit_collateral":
      case "open":
        return event.outTokens.reduce((s, t) => s + t.usd, 0);
      case "withdraw_collateral":
      case "close":
        return -event.inTokens.reduce((s, t) => s + t.usd, 0);
      default:
        return 0;
    }
  }

  private deltaDebt(event: PositionEvent): number {
    switch (event.type) {
      case "borrow":
        return event.inTokens.reduce((s, t) => s + t.usd, 0);
      case "repay":
        return -event.outTokens.reduce((s, t) => s + t.usd, 0);
      case "interest_accrual":
        return event.outTokens.reduce((s, t) => s + t.usd, 0);
      default:
        return 0;
    }
  }
}

export function createPositionTracker(): PositionTracker {
  return new PositionTracker();
}

/** Для интеграции в Phase 5 / 6. */
export function _attachLotTracker(_lots: LotTracker): void {
  // Placeholder — Phase 5 будет связывать lots ↔ position events.
}
