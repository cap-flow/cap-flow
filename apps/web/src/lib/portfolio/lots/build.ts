/**
 * `buildLotTrackerFromOps` — проходит все ops хронологически и эмитит
 * lots в трекер. Это **единственное** место где принимаются решения
 * "что считать приобретением":
 *
 *  - **swap**: stables out + token in → buy_with_stable
 *               token A out + token B in → swap (cost basis A → B)
 *  - **transfer_in** non-internal: airdrop / external income → manual_seed
 *               или airdrop в зависимости от symbol-policy
 *  - **lp_remove**: возврат underlying с attributed cost (через
 *               attributeLpCloses) → lp_close
 *  - **lp_add / lend_supply**: consume out-side underlying. Receipt-token
 *               in-side получает lot с cost = consumed cost basis.
 *  - **borrow**: in-side получает lot с cost = 0 (это долг)
 *  - **repay**: out-side underlying consumed (debt уменьшается)
 *  - **claim_rewards**: in-side получает lot с cost = market price (или 0
 *               если так настроено)
 *
 * Один проход — одна полная история cost basis. Каждый дальнейший
 * расчёт (currentCostBasisForPosition, attributedClose, etc.) использует
 * этот трекер.
 */

import { defillamaCoinKey, priceFromMap } from "@/lib/defillama";
import { isJunkOp } from "../junk_filter";
import { isStableSymbol } from "../protocols";
import { isReceiptOfProtocol } from "../token_roles";
import type { ClassifiedOp, TokenMovement } from "../types";
import { LotTracker } from "./lot_tracker";
import type { AcquiredVia } from "./types";

interface BuildOptions {
  histPrices?: Map<string, number>;
  /** Если задан — все lots создаются под этим walletId. Иначе из ops. */
  walletId: string;
}

/** Стоимость движения в USD (приоритет: hist price → m.usd → 0). */
function movementUsd(
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

/** Skip gas micro-amounts (< 0.01 ETH/WETH AND < $100). */
function isGas(m: TokenMovement): boolean {
  if (m.symbol !== "ETH" && m.symbol !== "WETH") return false;
  return m.amount < 0.01 && (m.usd ?? 0) < 100;
}

/**
 * Прогнать все ops через новый LotTracker.
 *
 * Возвращает заполненный трекер, готовый к запросам wacAt / consume / etc.
 */
export function buildLotTrackerFromOps(
  ops: ClassifiedOp[],
  options: BuildOptions,
): LotTracker {
  const tracker = new LotTracker("WAC");
  const histPrices = options.histPrices ?? new Map<string, number>();
  const walletId = options.walletId;

  const sorted = [...ops].sort((a, b) => a.time - b.time);

  for (const op of sorted) {
    if (op.status === "failed") continue;
    if (isJunkOp(op)) continue;

    switch (op.type) {
      case "swap":
        handleSwap(op, tracker, walletId, histPrices);
        break;
      case "lp_add":
      case "lend_supply":
      case "stake":
        handleSupply(op, tracker, walletId, histPrices);
        break;
      case "lp_remove":
      case "lend_withdraw":
      case "unstake":
        handleWithdraw(op, tracker, walletId, histPrices);
        break;
      case "borrow":
        handleBorrow(op, tracker, walletId);
        break;
      case "repay":
        handleRepay(op, tracker, walletId);
        break;
      case "claim_rewards":
        handleClaim(op, tracker, walletId, histPrices);
        break;
      case "transfer_in":
      case "deposit_fiat":
        handleTransferIn(op, tracker, walletId, histPrices);
        break;
      case "transfer_out":
      case "bridge_out":
      case "withdraw_fiat":
        handleTransferOut(op, tracker, walletId);
        break;
      case "bridge_in":
        handleBridgeIn(op, tracker, walletId, histPrices);
        break;
      // approve / unknown / failed — ничего не делаем
    }
  }

  return tracker;
}

// ─── Handlers ───────────────────────────────────────────────────────────

function handleSwap(
  op: ClassifiedOp,
  tracker: LotTracker,
  walletId: string,
  histPrices: Map<string, number>,
): void {
  const ins = op.movement.filter((m) => m.direction === "in" && m.amount > 0);
  const outs = op.movement.filter(
    (m) => m.direction === "out" && m.amount > 0 && !isGas(m),
  );
  if (ins.length === 0 || outs.length === 0) return;

  // Total USD that was paid (out side).
  let paidUsd = 0;
  for (const m of outs) {
    // Consume out-side from existing lots — это движение их уменьшает.
    // Stable: $1 × amount. Non-stable: используем hist price если есть.
    const usd = isStableSymbol(m.symbol)
      ? m.amount
      : movementUsd(m, op.chain, op.time, histPrices);
    paidUsd += usd;
    tracker.consume({
      symbol: m.symbol,
      tokenId: m.tokenId,
      chain: op.chain,
      amount: m.amount,
      consumedAt: op.time,
      walletId,
    });
  }

  // Распределяем paidUsd между in-токенами пропорционально их amount-share
  // (или USD-share если есть оценки).
  const totalInUsd = ins.reduce(
    (s, m) => s + movementUsd(m, op.chain, op.time, histPrices),
    0,
  );

  const stableOuts = outs.every((m) => m.isStable);
  for (const m of ins) {
    let share: number;
    if (totalInUsd > 0) {
      share = movementUsd(m, op.chain, op.time, histPrices) / totalInUsd;
    } else {
      share = 1 / ins.length;
    }
    const costForLot = paidUsd * share;
    if (m.amount > 0 && costForLot >= 0) {
      const acquiredVia: AcquiredVia = stableOuts
        ? "buy_with_stable"
        : "swap";
      tracker.acquire({
        symbol: m.symbol,
        tokenId: m.tokenId,
        chain: op.chain,
        amount: m.amount,
        costPerUnitUsd: costForLot / m.amount,
        acquiredAt: op.time,
        acquiredVia,
        sourceHash: op.hash,
        walletId,
      });
    }
  }
}

function handleSupply(
  op: ClassifiedOp,
  tracker: LotTracker,
  walletId: string,
  histPrices: Map<string, number>,
): void {
  // Receipt-token (если есть) получает lot с cost = USD из out-side underlying.
  const protoId = op.protocol?.id ?? "";
  const isReceipt = (m: TokenMovement) =>
    isReceiptOfProtocol(m.symbol, protoId, m.tokenId);

  // Consume all out-side underlying (non-receipt, non-gas).
  let totalCostUsd = 0;
  for (const m of op.movement) {
    if (m.direction !== "out" || m.amount <= 0) continue;
    if (isGas(m)) continue;
    if (isReceipt(m)) {
      // out receipt — это редко (transfer existing receipt). Просто consume.
      tracker.consume({
        symbol: m.symbol,
        tokenId: m.tokenId,
        chain: op.chain,
        amount: m.amount,
        consumedAt: op.time,
        walletId,
      });
      continue;
    }
    // Underlying out → consume from lots, прибавляем cost к totalCostUsd.
    const consumed = tracker.consume({
      symbol: m.symbol,
      tokenId: m.tokenId,
      chain: op.chain,
      amount: m.amount,
      consumedAt: op.time,
      walletId,
    });
    if (consumed.totalCostUsd > 0) {
      totalCostUsd += consumed.totalCostUsd;
    } else {
      // Fallback: если LotTracker не нашёл cost (token не отслеживался),
      // берём hist price.
      const fallbackUsd = isStableSymbol(m.symbol)
        ? m.amount
        : movementUsd(m, op.chain, op.time, histPrices);
      totalCostUsd += fallbackUsd;
    }
  }

  // Receipt(ы) in-side получают lots с пропорциональным cost.
  const receiptIns = op.movement.filter(
    (m) => m.direction === "in" && isReceipt(m) && m.amount > 0,
  );
  if (receiptIns.length > 0 && totalCostUsd > 0) {
    const totalRecv = receiptIns.reduce((s, m) => s + m.amount, 0);
    for (const m of receiptIns) {
      const share = (m.amount / totalRecv) * totalCostUsd;
      tracker.acquire({
        symbol: m.symbol,
        tokenId: m.tokenId,
        chain: op.chain,
        amount: m.amount,
        costPerUnitUsd: share / m.amount,
        acquiredAt: op.time,
        acquiredVia: "linked_async_fill",
        sourceHash: op.hash,
        walletId,
      });
    }
  }

  // Non-receipt in-side (например USDC borrow в combined-supply-borrow):
  // получает lot с cost = 0 (это занятые средства, не приобретение).
  const nonReceiptIns = op.movement.filter(
    (m) => m.direction === "in" && !isReceipt(m) && m.amount > 0,
  );
  for (const m of nonReceiptIns) {
    tracker.acquire({
      symbol: m.symbol,
      tokenId: m.tokenId,
      chain: op.chain,
      amount: m.amount,
      costPerUnitUsd: 0, // borrow proceeds: cost = 0 (debt counted separately)
      acquiredAt: op.time,
      acquiredVia: "borrow",
      sourceHash: op.hash,
      walletId,
    });
  }
}

function handleWithdraw(
  op: ClassifiedOp,
  tracker: LotTracker,
  walletId: string,
  histPrices: Map<string, number>,
): void {
  const protoId = op.protocol?.id ?? "";
  const isReceipt = (m: TokenMovement) =>
    isReceiptOfProtocol(m.symbol, protoId, m.tokenId);

  // Receipt out — consume его lot (списываем proportional cost).
  let recoveredCost = 0;
  for (const m of op.movement) {
    if (m.direction !== "out" || m.amount <= 0) continue;
    if (!isReceipt(m)) continue;
    const consumed = tracker.consume({
      symbol: m.symbol,
      tokenId: m.tokenId,
      chain: op.chain,
      amount: m.amount,
      consumedAt: op.time,
      walletId,
    });
    recoveredCost += consumed.totalCostUsd;
  }

  // Underlying in-side получает recovered cost пропорционально amount.
  const ins = op.movement.filter(
    (m) => m.direction === "in" && !isReceipt(m) && m.amount > 0,
  );
  if (ins.length === 0) return;

  // Если recovered cost > 0 — используем его. Иначе fallback на hist price.
  const totalInUsd = ins.reduce(
    (s, m) => s + movementUsd(m, op.chain, op.time, histPrices),
    0,
  );

  for (const m of ins) {
    let costForLot: number;
    if (recoveredCost > 0 && totalInUsd > 0) {
      const share = movementUsd(m, op.chain, op.time, histPrices) / totalInUsd;
      costForLot = recoveredCost * share;
    } else {
      costForLot = isStableSymbol(m.symbol)
        ? m.amount
        : movementUsd(m, op.chain, op.time, histPrices);
    }
    tracker.acquire({
      symbol: m.symbol,
      tokenId: m.tokenId,
      chain: op.chain,
      amount: m.amount,
      costPerUnitUsd: costForLot / m.amount,
      acquiredAt: op.time,
      acquiredVia: op.type === "lp_remove" ? "lp_close" : "lend_withdraw",
      sourceHash: op.hash,
      walletId,
    });
  }
}

function handleBorrow(
  op: ClassifiedOp,
  tracker: LotTracker,
  walletId: string,
): void {
  // Borrow: in-side получает lot с cost = 0 (это занятые средства).
  for (const m of op.movement) {
    if (m.direction !== "in" || m.amount <= 0) continue;
    tracker.acquire({
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

function handleRepay(
  op: ClassifiedOp,
  tracker: LotTracker,
  walletId: string,
): void {
  // Repay: out-side consumed (используется debt borrowed asset).
  for (const m of op.movement) {
    if (m.direction !== "out" || m.amount <= 0) continue;
    if (isGas(m)) continue;
    tracker.consume({
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
  tracker: LotTracker,
  walletId: string,
  histPrices: Map<string, number>,
): void {
  // Claim rewards: in-side получает lot с cost = market price на момент.
  for (const m of op.movement) {
    if (m.direction !== "in" || m.amount <= 0) continue;
    const usd = isStableSymbol(m.symbol)
      ? m.amount
      : movementUsd(m, op.chain, op.time, histPrices);
    tracker.acquire({
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

function handleTransferIn(
  op: ClassifiedOp,
  tracker: LotTracker,
  walletId: string,
  histPrices: Map<string, number>,
): void {
  // Transfer in: external income / CEX deposit / fiat purchase.
  // Cost = market price на момент (если задан manual_annotations.fiatPurchase
  // — это уже учтено классификатором через op.type).
  for (const m of op.movement) {
    if (m.direction !== "in" || m.amount <= 0) continue;
    const usd = isStableSymbol(m.symbol)
      ? m.amount
      : movementUsd(m, op.chain, op.time, histPrices);
    tracker.acquire({
      symbol: m.symbol,
      tokenId: m.tokenId,
      chain: op.chain,
      amount: m.amount,
      costPerUnitUsd: m.amount > 0 ? usd / m.amount : 0,
      acquiredAt: op.time,
      acquiredVia:
        op.type === "deposit_fiat" ? "manual_seed" : "transfer_in",
      sourceHash: op.hash,
      walletId,
    });
  }
}

function handleTransferOut(
  op: ClassifiedOp,
  tracker: LotTracker,
  walletId: string,
): void {
  // Out-side consumed.
  for (const m of op.movement) {
    if (m.direction !== "out" || m.amount <= 0) continue;
    if (isGas(m)) continue;
    tracker.consume({
      symbol: m.symbol,
      tokenId: m.tokenId,
      chain: op.chain,
      amount: m.amount,
      consumedAt: op.time,
      walletId,
    });
  }
}

function handleBridgeIn(
  op: ClassifiedOp,
  tracker: LotTracker,
  walletId: string,
  histPrices: Map<string, number>,
): void {
  // Bridge in: same as transfer_in — actor unknown, treat as external arrival.
  // Bridge_pair detection (handled elsewhere) может потом ре-link cost из bridge_out.
  handleTransferIn(op, tracker, walletId, histPrices);
}
