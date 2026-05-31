/**
 * `buildPositionsFromOps` — основной builder.
 *
 * Проходит ops хронологически и для каждой DeFi-операции эмитит
 * соответствующий PositionEvent в PositionTracker. Cost basis для
 * deposit'ов берётся из LotTracker (передан как dependency).
 *
 * `marketKey` детектится по приоритету:
 *   1. `op.linkedLpTokenId` (от async-deposit linker — GMX V2)
 *   2. Receipt-токен в movement с known protocol
 *   3. Synthetic для receipt-less (Morpho Blue, Drift): используем
 *      collateral symbol + chain
 */

import { defillamaCoinKey, priceFromMap } from "../pricing.js";
import { isJunkOp } from "../junk_filter.js";
import { isStableSymbol } from "../protocols.js";
import { isReceiptLessProtocol, isReceiptOfProtocol } from "../token_roles.js";
import type { ClassifiedOp, TokenMovement } from "../types.js";
import type { LotTracker } from "../lots/lot_tracker.js";
import { PositionTracker } from "./position_tracker.js";
import type { PositionEvent, PositionEventType } from "./types.js";

interface BuildOptions {
  histPrices?: Map<string, number>;
  walletNameById: Map<string, string>;
}

function isGas(m: TokenMovement): boolean {
  if (m.symbol !== "ETH" && m.symbol !== "WETH") return false;
  return m.amount < 0.01 && (m.usd ?? 0) < 100;
}

function tokenUsd(
  m: TokenMovement,
  chain: string,
  time: number,
  histPrices: Map<string, number>,
): number {
  if (m.amount <= 0) return 0;
  if (isStableSymbol(m.symbol)) return m.amount;
  const coin = defillamaCoinKey(chain, m.tokenId, m.symbol);
  if (coin) {
    const hp = priceFromMap(histPrices, coin, time);
    if (hp != null && hp > 0) return m.amount * hp;
  }
  if (m.usd != null && m.usd > 0) return m.usd;
  return 0;
}

function stripChainPrefix(id: string): string {
  return id
    .replace(/^[a-z]{2,6}:/i, "")
    .replace(/:[a-z][a-z0-9_-]+$/i, "")
    .toLowerCase();
}

/**
 * Определить marketKey для op.
 * Receipt-based: первый receipt-token в movement.
 * Receipt-less: первый non-stable non-gas underlying symbol + chain.
 * Linked async: использует op.linkedLpTokenId.
 */
function inferMarketKey(
  op: ClassifiedOp,
  walletId: string,
): string | null {
  const protoId = op.protocol?.id ?? "";
  if (op.linkedLpTokenId) {
    return stripChainPrefix(op.linkedLpTokenId);
  }
  for (const m of op.movement) {
    if (isReceiptOfProtocol(m.symbol, protoId, m.tokenId)) {
      return stripChainPrefix(m.tokenId);
    }
  }
  if (isReceiptLessProtocol(protoId)) {
    // Synthetic для receipt-less — collateral_symbol + chain.
    for (const m of op.movement) {
      if (m.direction !== "out" || m.amount <= 0) continue;
      if (isGas(m)) continue;
      if (isStableSymbol(m.symbol)) continue;
      return `synthetic:${protoId}:${op.chain}:${m.symbol.toUpperCase()}:${walletId}`;
    }
  }
  return null;
}

export function buildPositionsFromOps(
  ops: ClassifiedOp[],
  walletId: string,
  _lots: LotTracker,
  options: BuildOptions,
): PositionTracker {
  const tracker = new PositionTracker();
  const histPrices = options.histPrices ?? new Map<string, number>();
  const walletName = options.walletNameById.get(walletId) ?? walletId;

  const sorted = [...ops].sort((a, b) => a.time - b.time);

  for (const op of sorted) {
    if (op.status === "failed") continue;
    if (isJunkOp(op)) continue;
    if (!op.protocol) continue;

    const eventType = mapOpToEventType(op.type);
    if (!eventType) continue;

    const marketKey = inferMarketKey(op, walletId);
    if (!marketKey) continue;

    const protoId = op.protocol.id;
    const isReceipt = (m: TokenMovement) =>
      isReceiptOfProtocol(m.symbol, protoId, m.tokenId);

    const inTokens = op.movement
      .filter((m) => m.direction === "in" && m.amount > 0 && !isGas(m))
      .map((m) => ({
        symbol: m.symbol,
        amount: m.amount,
        usd: tokenUsd(m, op.chain, op.time, histPrices),
      }));
    const outTokens = op.movement
      .filter((m) => m.direction === "out" && m.amount > 0 && !isGas(m))
      .map((m) => ({
        symbol: m.symbol,
        amount: m.amount,
        usd: tokenUsd(m, op.chain, op.time, histPrices),
      }));

    // Receipt-delta = чистое изменение receipt-amount в этой op.
    let receiptDelta = 0;
    for (const m of op.movement) {
      if (!isReceipt(m)) continue;
      if (m.direction === "in") receiptDelta += m.amount;
      else if (m.direction === "out") receiptDelta -= m.amount;
    }

    const event: PositionEvent = {
      time: op.time,
      hash: op.hash,
      type: eventType,
      inTokens,
      outTokens,
      receiptDelta,
      ...((op.notes?.length ?? 0) > 0
        ? { note: (op.notes as string[]).join(", ") }
        : {}),
    };

    tracker.recordEvent(
      walletId,
      walletName,
      protoId,
      op.protocol.name,
      op.chain,
      marketKey,
      event,
    );
  }

  return tracker;
}

function mapOpToEventType(opType: string): PositionEventType | null {
  switch (opType) {
    case "lp_add":
    case "lend_supply":
    case "stake":
      return "deposit_collateral";
    case "lp_remove":
    case "lend_withdraw":
    case "unstake":
      return "withdraw_collateral";
    case "borrow":
      return "borrow";
    case "repay":
      return "repay";
    case "claim_rewards":
      return "claim_rewards";
    default:
      return null;
  }
}
