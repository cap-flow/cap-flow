/**
 * **UCB C5 Phase 3 v2 (Task #18, 2026-05-23)**: `buildLotTrackerFromOps` теперь
 * тонкий wrapper над canonical `cross_protocol.ts:buildLotsAndPositions`.
 *
 * До Phase 3 эта функция содержала ~700 строк параллельной реализации
 * handlers (handleSwap / handleSupply / handleWithdraw / handleBorrow /
 * handleRepay / handleClaim / handleTransferIn / handleTransferOut /
 * handleBridgeIn). Это было **anti-recurrence pattern #3** — параллельный
 * pipeline, в который не пробрасывались fixes из canonical: C8, C10, C12 в
 * одной сессии повторялись 5+ раз потому что фикс в build.ts не помогал
 * production-пути (cross_protocol.ts) и наоборот.
 *
 * Phase 2 / Phase 2b создали `dual_pipeline_equivalence.test.ts` (16
 * сценариев) — он зафиксировал что обе реализации дают идентичные
 * `wacAt()` результаты на ключевых UCB-инвариантах (C8 async-deposit,
 * C10 self-loop, D5 bridge, swap chains, multi-source, claim_rewards).
 *
 * Phase 3 v2 = drop-in замена + расширение `inferMarketKey` чтобы
 * консьюмить лоты для ВСЕХ position-style ops (lp_add/lend_supply/stake/
 * repay/borrow/withdraw/claim_rewards), а не только для receipt-less
 * protocols. Это устраняет divergence на Aave-style supply tests.
 *
 * Польза:
 *   - **Один source of truth** для lot tracking (cross_protocol.ts)
 *   - Любой будущий C-fix автоматически работает в обоих use cases
 *   - −500+ строк дублирующегося кода
 *   - Тесты `build.*.test.ts` продолжают работать (signature wrapper'а та же)
 *
 * Если когда-нибудь нужно вернуть legacy реализацию — git history
 * сохранил всё в commit'е перед Phase 3.
 */

import type { ClassifiedOp } from "../types";
import { buildLotsAndPositions } from "../positions/cross_protocol";
import type { LotTracker } from "./lot_tracker";

interface BuildOptions {
  histPrices?: Map<string, number>;
  /** Wallet'а для всех lots (single-wallet API). */
  walletId: string;
  /**
   * UCB A4.2: per-op cost basis overrides, keyed by `op.hash.toLowerCase()`.
   * Значение — **полная** USD-стоимость приобретения для этой tx (не per-unit).
   * Источник: `chain_operation_annotations.manual_cost_basis_usd` (server A3).
   */
  costBasisOverrideByHash?: Map<string, number>;
}

/**
 * Single-wallet legacy API: строит LotTracker через canonical pipeline
 * `buildLotsAndPositions` и возвращает только `.lots` (PositionTracker
 * игнорируется — это lots-only API для walker'ов в `open_positions.ts` и
 * для test fixtures).
 *
 * Семантически эквивалентно (verified by `dual_pipeline_equivalence.test.ts`):
 *   buildLotTrackerFromOps(ops, { walletId, histPrices, overrides })
 *   === buildLotsAndPositions(ops, walletId, { histPrices, overrides, walletNameById }).lots
 */
export function buildLotTrackerFromOps(
  ops: ClassifiedOp[],
  options: BuildOptions,
): LotTracker {
  const walletId = options.walletId;
  return buildLotsAndPositions(ops, walletId, {
    histPrices: options.histPrices ?? new Map<string, number>(),
    walletNameById: new Map([[walletId, walletId]]),
    ...(options.costBasisOverrideByHash && {
      costBasisOverrideByHash: options.costBasisOverrideByHash,
    }),
  }).lots;
}
