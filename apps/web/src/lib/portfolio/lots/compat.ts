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

/**
 * UCB C5: per-wallet view над shared `LotTracker`.
 *
 * Где это используется: `open_positions.ts` legacy code expects
 * `CostBasisTracker` (per-wallet) с API `avgAt(symbol, time)` /
 * `currentAvg(symbol)`. Новый pipeline (`runUcbPipelineForWallet`) даёт
 * один `LotTracker` per-wallet, но API — `wacAt(walletId, symbol, time)`.
 *
 * Этот адаптер биндит walletId, exposing legacy 2-arg API. Используется в
 * `buildOpenPositions` чтобы передать в downstream функции тот же
 * tracker-objet что был от старого `buildCostBasisTracker` — без правки
 * этих функций.
 *
 * После полной миграции (open_positions перейдёт на native wacAt-API)
 * этот wrapper можно удалить.
 */
export class PerWalletLotTrackerView {
  constructor(
    private readonly lots: LotTracker,
    private readonly walletId: string,
  ) {}

  avgAt(symbol: string, time: number): number | null {
    return this.lots.wacAt(this.walletId, symbol, time);
  }

  currentAvg(symbol: string): number | null {
    return this.lots.currentWac(this.walletId, symbol);
  }

  currentAmount(_symbol: string): number {
    // CostBasisTracker.currentAmount used for diagnostics only — not exposed
    // by LotTracker. Return 0 (callers check >0, so it's defensive no-op).
    return 0;
  }
}
