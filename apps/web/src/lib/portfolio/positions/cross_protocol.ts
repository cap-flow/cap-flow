/**
 * Cross-protocol lot transfer.
 *
 * Когда токен который у пользователя как lot (с известным cost basis)
 * уходит в DEPOSIT_COLLATERAL events в Position (Aave, Morpho, …),
 * cost basis должен **переехать** в эту позицию. Тогда close позиции
 * будет давать realistic PnL.
 *
 * Пример: GMX V2 даёт пользователю GLV (lot создан с cost basis $1.534/GLV
 * через handleSupply в build.ts). Затем GLV отдаётся в Morpho как
 * collateral → Position event `deposit_collateral` с lotConsumption,
 * указывающим какие лоты GLV ушли в эту позицию.
 *
 * Этот модуль — combiner: проходит ops + LotTracker + PositionTracker
 * вместе, эмитит cross-protocol-aware events.
 *
 * **Главный wiring** для Этапа 12 / Фазы 5: `buildEverything(ops, walletId)`
 * возвращает (LotTracker, PositionTracker) согласованно прокачанные
 * через единственный chronological pass.
 */

import { defillamaCoinKey, priceFromMap } from "@/lib/defillama";
import { isJunkOp } from "../junk_filter";
import { isStableSymbol } from "../protocols";
import { isReceiptLessProtocol, isReceiptOfProtocol } from "../token_roles";
import { LotTracker } from "../lots/lot_tracker";
import type { AcquiredVia } from "../lots/types";
import type { ClassifiedOp, TokenMovement } from "../types";
import { PositionTracker } from "./position_tracker";
import type { PositionEvent, PositionEventType } from "./types";

interface BuildResult {
  lots: LotTracker;
  positions: PositionTracker;
}

interface BuildOptions {
  histPrices?: Map<string, number>;
  walletNameById: Map<string, string>;
}

function isGas(m: TokenMovement): boolean {
  if (m.symbol !== "ETH" && m.symbol !== "WETH") return false;
  return m.amount < 0.01 && (m.usd ?? 0) < 100;
}

function tokenUsdHist(
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
 * Главный builder — запускает ops через LotTracker И PositionTracker
 * в один chronological pass. Cost basis для cross-protocol depositов
 * берётся из текущего LotTracker (т.е. учитывает предыдущие приобретения
 * того же токена в других протоколах).
 *
 * После этого:
 *   - Lots содержат полную картину покупок/продаж/начислений
 *   - Positions содержат events с reference на consumed lots
 *   - Запросы UI становятся быстрыми и derived
 */
export function buildLotsAndPositions(
  ops: ClassifiedOp[],
  walletId: string,
  options: BuildOptions,
): BuildResult {
  const lots = new LotTracker("WAC");
  const positions = new PositionTracker();
  const histPrices = options.histPrices ?? new Map<string, number>();
  const walletName = options.walletNameById.get(walletId) ?? walletId;

  const sorted = [...ops].sort((a, b) => a.time - b.time);

  for (const op of sorted) {
    if (op.status === "failed") continue;
    if (isJunkOp(op)) continue;

    // 1. Обновляем lots для swap / transfer / claim / approve.
    handleLotsForOp(op, lots, walletId, histPrices);

    // 2. Если это позиционная op — эмитим event в PositionTracker.
    if (op.protocol) {
      const eventType = mapOpToEventType(op.type);
      if (!eventType) continue;
      const marketKey = inferMarketKey(op, walletId);
      if (!marketKey) continue;
      emitPositionEvent(
        op,
        eventType,
        marketKey,
        walletId,
        walletName,
        positions,
        lots,
        histPrices,
      );
    }
  }

  return { lots, positions };
}

// ─── Lots side ──────────────────────────────────────────────────────────

function handleLotsForOp(
  op: ClassifiedOp,
  lots: LotTracker,
  walletId: string,
  histPrices: Map<string, number>,
): void {
  // Эта функция отвечает за UPDATE lots для НЕ-позиционных ops (swap,
  // transfer_in/out, deposit_fiat, claim_rewards). Для позиционных
  // (lp_add/remove, lend_supply/withdraw, borrow/repay) lot-attribution
  // делается внутри `emitPositionEvent` вместе с position-event.
  switch (op.type) {
    case "swap":
      handleSwap(op, lots, walletId, histPrices);
      break;
    case "transfer_in":
    case "deposit_fiat":
    case "bridge_in":
      handleTransferIn(op, lots, walletId, histPrices);
      break;
    case "transfer_out":
    case "withdraw_fiat":
    case "bridge_out":
      handleTransferOut(op, lots, walletId);
      break;
    case "claim_rewards":
      handleClaim(op, lots, walletId, histPrices);
      break;
  }
}

function handleSwap(
  op: ClassifiedOp,
  lots: LotTracker,
  walletId: string,
  histPrices: Map<string, number>,
): void {
  const ins = op.movement.filter((m) => m.direction === "in" && m.amount > 0);
  const outs = op.movement.filter(
    (m) => m.direction === "out" && m.amount > 0 && !isGas(m),
  );
  if (ins.length === 0 || outs.length === 0) return;

  let paidUsd = 0;
  for (const m of outs) {
    const consumed = lots.consume({
      symbol: m.symbol,
      tokenId: m.tokenId,
      chain: op.chain,
      amount: m.amount,
      consumedAt: op.time,
      walletId,
    });
    if (consumed.totalCostUsd > 0) {
      paidUsd += consumed.totalCostUsd;
    } else {
      const fallbackUsd = isStableSymbol(m.symbol)
        ? m.amount
        : tokenUsdHist(m, op.chain, op.time, histPrices);
      paidUsd += fallbackUsd;
    }
  }

  const totalInUsd = ins.reduce(
    (s, m) => s + tokenUsdHist(m, op.chain, op.time, histPrices),
    0,
  );
  const stableOuts = outs.every((m) => m.isStable);
  for (const m of ins) {
    const share =
      totalInUsd > 0
        ? tokenUsdHist(m, op.chain, op.time, histPrices) / totalInUsd
        : 1 / ins.length;
    const costForLot = paidUsd * share;
    lots.acquire({
      symbol: m.symbol,
      tokenId: m.tokenId,
      chain: op.chain,
      amount: m.amount,
      costPerUnitUsd: costForLot / m.amount,
      acquiredAt: op.time,
      acquiredVia: stableOuts
        ? ("buy_with_stable" as AcquiredVia)
        : ("swap" as AcquiredVia),
      sourceHash: op.hash,
      walletId,
    });
  }
}

function handleTransferIn(
  op: ClassifiedOp,
  lots: LotTracker,
  walletId: string,
  histPrices: Map<string, number>,
): void {
  for (const m of op.movement) {
    if (m.direction !== "in" || m.amount <= 0) continue;
    const usd = isStableSymbol(m.symbol)
      ? m.amount
      : tokenUsdHist(m, op.chain, op.time, histPrices);
    lots.acquire({
      symbol: m.symbol,
      tokenId: m.tokenId,
      chain: op.chain,
      amount: m.amount,
      costPerUnitUsd: m.amount > 0 ? usd / m.amount : 0,
      acquiredAt: op.time,
      acquiredVia:
        op.type === "deposit_fiat"
          ? ("manual_seed" as AcquiredVia)
          : ("transfer_in" as AcquiredVia),
      sourceHash: op.hash,
      walletId,
    });
  }
}

function handleTransferOut(
  op: ClassifiedOp,
  lots: LotTracker,
  walletId: string,
): void {
  for (const m of op.movement) {
    if (m.direction !== "out" || m.amount <= 0) continue;
    if (isGas(m)) continue;
    lots.consume({
      symbol: m.symbol,
      tokenId: m.tokenId,
      chain: op.chain,
      amount: m.amount,
      consumedAt: op.time,
      walletId,
    });
  }
}

function handleClaim(
  op: ClassifiedOp,
  lots: LotTracker,
  walletId: string,
  histPrices: Map<string, number>,
): void {
  for (const m of op.movement) {
    if (m.direction !== "in" || m.amount <= 0) continue;
    const usd = isStableSymbol(m.symbol)
      ? m.amount
      : tokenUsdHist(m, op.chain, op.time, histPrices);
    lots.acquire({
      symbol: m.symbol,
      tokenId: m.tokenId,
      chain: op.chain,
      amount: m.amount,
      costPerUnitUsd: m.amount > 0 ? usd / m.amount : 0,
      acquiredAt: op.time,
      acquiredVia: "claim_rewards",
      sourceHash: op.hash,
      walletId,
    });
  }
}

// ─── Position-event side ────────────────────────────────────────────────

function inferMarketKey(op: ClassifiedOp, walletId: string): string | null {
  const protoId = op.protocol?.id ?? "";
  if (op.linkedLpTokenId) return stripChainPrefix(op.linkedLpTokenId);
  for (const m of op.movement) {
    if (isReceiptOfProtocol(m.symbol, protoId, m.tokenId)) {
      return stripChainPrefix(m.tokenId);
    }
  }
  if (isReceiptLessProtocol(protoId)) {
    for (const m of op.movement) {
      if (m.direction !== "out" || m.amount <= 0) continue;
      if (isGas(m)) continue;
      if (isStableSymbol(m.symbol)) continue;
      return `synthetic:${protoId}:${op.chain}:${m.symbol.toUpperCase()}:${walletId}`;
    }
  }
  return null;
}

function emitPositionEvent(
  op: ClassifiedOp,
  eventType: PositionEventType,
  marketKey: string,
  walletId: string,
  walletName: string,
  positions: PositionTracker,
  lots: LotTracker,
  histPrices: Map<string, number>,
): void {
  const protoId = op.protocol?.id ?? "";
  const isReceipt = (m: TokenMovement) =>
    isReceiptOfProtocol(m.symbol, protoId, m.tokenId);

  const inTokens = op.movement
    .filter((m) => m.direction === "in" && m.amount > 0 && !isGas(m))
    .map((m) => ({
      symbol: m.symbol,
      amount: m.amount,
      usd: tokenUsdHist(m, op.chain, op.time, histPrices),
    }));

  // Out-tokens: для deposit_collateral консьюмим lots (cost basis transfer).
  const outRaw = op.movement.filter(
    (m) => m.direction === "out" && m.amount > 0 && !isGas(m),
  );
  const outTokens: { symbol: string; amount: number; usd: number }[] = [];
  let attributedCost = 0;
  for (const m of outRaw) {
    let lotCost = 0;
    // Receipt-токены отдаются в withdraw — для них consume lot напрямую.
    if (eventType === "deposit_collateral" && !isReceipt(m)) {
      const consumed = lots.consume({
        symbol: m.symbol,
        tokenId: m.tokenId,
        chain: op.chain,
        amount: m.amount,
        consumedAt: op.time,
        walletId,
      });
      lotCost = consumed.totalCostUsd;
    } else if (eventType === "withdraw_collateral" && isReceipt(m)) {
      const consumed = lots.consume({
        symbol: m.symbol,
        tokenId: m.tokenId,
        chain: op.chain,
        amount: m.amount,
        consumedAt: op.time,
        walletId,
      });
      lotCost = consumed.totalCostUsd;
    }
    const fallbackUsd = isStableSymbol(m.symbol)
      ? m.amount
      : tokenUsdHist(m, op.chain, op.time, histPrices);
    const usd = lotCost > 0 ? lotCost : fallbackUsd;
    if (lotCost > 0) attributedCost += lotCost;
    outTokens.push({ symbol: m.symbol, amount: m.amount, usd });
  }

  // Withdraw_collateral: возвращаем cost basis в lots (in-side underlying
  // получает recovered cost пропорционально amount).
  if (eventType === "withdraw_collateral" && attributedCost > 0) {
    const totalInUsd = inTokens.reduce((s, t) => s + t.usd, 0);
    for (const t of inTokens) {
      const share = totalInUsd > 0 ? t.usd / totalInUsd : 1 / inTokens.length;
      const costForLot = attributedCost * share;
      lots.acquire({
        symbol: t.symbol,
        tokenId: "",
        chain: op.chain,
        amount: t.amount,
        costPerUnitUsd: costForLot / t.amount,
        acquiredAt: op.time,
        acquiredVia:
          op.type === "lp_remove"
            ? ("lp_close" as AcquiredVia)
            : ("lend_withdraw" as AcquiredVia),
        sourceHash: op.hash,
        walletId,
      });
    }
  }

  // Deposit_collateral: receipt-токены in-side создают lot с cost = attributedCost
  // (cross-protocol cost basis carries — главное!).
  if (eventType === "deposit_collateral") {
    const receiptIns = op.movement.filter(
      (m) => m.direction === "in" && isReceipt(m) && m.amount > 0,
    );
    if (receiptIns.length > 0 && attributedCost > 0) {
      const totalRecv = receiptIns.reduce((s, m) => s + m.amount, 0);
      for (const m of receiptIns) {
        const share = (m.amount / totalRecv) * attributedCost;
        lots.acquire({
          symbol: m.symbol,
          tokenId: m.tokenId,
          chain: op.chain,
          amount: m.amount,
          costPerUnitUsd: share / m.amount,
          acquiredAt: op.time,
          acquiredVia: "linked_async_fill" as AcquiredVia,
          sourceHash: op.hash,
          walletId,
        });
      }
    }
    // Borrow proceeds (non-receipt in) — lot с cost=0.
    const borrowIns = op.movement.filter(
      (m) => m.direction === "in" && !isReceipt(m) && m.amount > 0,
    );
    for (const m of borrowIns) {
      lots.acquire({
        symbol: m.symbol,
        tokenId: m.tokenId,
        chain: op.chain,
        amount: m.amount,
        costPerUnitUsd: 0,
        acquiredAt: op.time,
        acquiredVia: "borrow",
        sourceHash: op.hash,
        walletId,
      });
    }
  }

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

  positions.recordEvent(
    walletId,
    walletName,
    protoId,
    op.protocol?.name ?? protoId,
    op.chain,
    marketKey,
    event,
  );
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
