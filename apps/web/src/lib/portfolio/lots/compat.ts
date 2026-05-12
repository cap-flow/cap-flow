/**
 * Backward-compat адаптер для существующего `CostBasisTracker` API.
 *
 * Старый код в `cost_basis_tracker.ts` использует:
 *   tracker.buy(symbol, amount, paidUsd, time)
 *   tracker.consume(symbol, amount, time)
 *   tracker.avgAt(symbol, time): number | null
 *   tracker.currentAvg(symbol): number | null
 *
 * Этот адаптер маппит эти вызовы на новый `LotTracker`. Используется в
 * переходный период (Фазы 3-4 Этапа 12), пока остальной код не
 * мигрирует на нативный `LotTracker` API с per-wallet разделением.
 *
 * Ключевое отличие нового API: lots разделены per (walletId, symbol).
 * Compat-адаптер использует синтетический walletId="compat" — это значит
 * lots всех кошельков смешиваются в одну очередь (как было в старом
 * tracker'е). Когда вызывающий код мигрирует на native API, можно
 * передавать реальный walletId per kошелёк.
 */

import { LotTracker } from "./lot_tracker";
import type { AcquiredVia } from "./types";

const COMPAT_WALLET_ID = "compat";

export class CostBasisTrackerCompat {
  private readonly inner = new LotTracker("WAC");

  buy(
    symbol: string,
    amount: number,
    paidUsd: number,
    time: number,
    sourceHash = "",
    tokenId = "",
    chain = "",
  ): void {
    if (amount <= 0 || paidUsd < 0) return;
    this.inner.acquire({
      symbol,
      tokenId: tokenId.toLowerCase(),
      chain,
      amount,
      costPerUnitUsd: paidUsd / amount,
      acquiredAt: time,
      acquiredVia: "buy_with_stable" as AcquiredVia,
      sourceHash,
      walletId: COMPAT_WALLET_ID,
    });
  }

  consume(symbol: string, amount: number, time: number): void {
    if (amount <= 0) return;
    this.inner.consume({
      symbol,
      amount,
      consumedAt: time,
      walletId: COMPAT_WALLET_ID,
    });
  }

  avgAt(symbol: string, time: number): number | null {
    return this.inner.wacAt(COMPAT_WALLET_ID, symbol, time);
  }

  currentAvg(symbol: string): number | null {
    return this.inner.currentWac(COMPAT_WALLET_ID, symbol);
  }

  /** Доступ к нативному LotTracker (для миграции). */
  asLotTracker(): LotTracker {
    return this.inner;
  }
}
