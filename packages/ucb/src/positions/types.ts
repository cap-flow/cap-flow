/**
 * Модель `Position` через **event log** — каждое изменение позиции
 * фиксируется как event с полным cost-attribution.
 *
 * Преимущества над текущим подходом:
 *   - **Replay-able**: вся история позиции видна в events
 *   - **Cross-protocol**: lot переезжает с протокола на протокол через
 *     `collateral_in` / `collateral_out` events
 *   - **Receipt-less / receipt-based**: единая модель для обоих случаев
 *   - **NFT lifecycle**: split / merge / burn обрабатываются как events
 *   - **Atomic multi-event**: один tx может породить несколько events
 *     (combined supply+borrow → 2 events с одним hash)
 *
 * Каждая Position принадлежит одному (walletId, protocolId, marketKey).
 * `marketKey` — стабильный идентификатор рынка:
 *   - GMX V2: GM-токен contract address
 *   - Aave V3: receipt aToken contract address
 *   - Morpho Blue: market ID от DeBank lpTokenId
 *   - Uniswap V3: NFT tokenId
 */

import type { LotConsumption } from "../lots/types.js";

export type PositionStatus = "open" | "closed";

export type PositionEventType =
  | "deposit_collateral" // collateral в позицию (lend_supply, lp_add)
  | "withdraw_collateral" // collateral из позиции (lend_withdraw, lp_remove)
  | "borrow" // занять (debt увеличился)
  | "repay" // погасить (debt уменьшился)
  | "claim_rewards" // получить накопленный yield
  | "interest_accrual" // начислены % по долгу (synthetic, не on-chain)
  | "liquidation" // ликвидация (force-close часть позиции)
  | "split" // V3 NFT разделён на 2 NFT
  | "merge" // 2 V3 NFT слиты
  | "open" // первое событие, создавшее позицию
  | "close"; // последнее событие, полностью закрывшее позицию

export interface PositionEvent {
  readonly time: number;
  readonly hash: string;
  readonly type: PositionEventType;
  /** Какие токены вошли (получены пользователем). */
  readonly inTokens: { symbol: string; amount: number; usd: number }[];
  /** Какие токены вышли (отданы в протокол). */
  readonly outTokens: { symbol: string; amount: number; usd: number }[];
  /** Cost-attribution от lots (если применимо: deposit/withdraw). */
  readonly lotConsumption?: LotConsumption[];
  /** Изменение receipt-amount (для receipt-based позиций). */
  readonly receiptDelta?: number;
  /** Свободная заметка для UI / debug. */
  readonly note?: string;
}

export interface Position {
  readonly walletId: string;
  readonly walletName: string;
  readonly protocolId: string;
  readonly protocolName: string;
  readonly chain: string;
  /** Стабильный ID рынка (receipt-token contract / market ID / NFT tokenId). */
  readonly marketKey: string;
  /** Активы залога (символы). */
  readonly collateralSymbols: readonly string[];
  /** Активы долга (символы). */
  readonly debtSymbols: readonly string[];
  readonly events: readonly PositionEvent[];
  /** Текущий cost basis (running sum) — derived from events. */
  readonly currentCostBasisUsd: number;
  /** Текущий долг (running sum). */
  readonly currentDebtUsd: number;
  /** Текущий receipt-amount (для receipt-based позиций). */
  readonly receiptAmount: number;
  readonly openedAt: number;
  readonly status: PositionStatus;
  readonly closedAt?: number;
}
