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

import {
  defillamaCoinKey,
  priceFromMap,
  priceFromMapNearest,
} from "@/lib/defillama";
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
  /**
   * UCB A4.2: per-op cost basis overrides, keyed by `op.hash.toLowerCase()`.
   * Значение — **полная** USD-стоимость приобретения для этой tx (не per-unit).
   * Acquisition handlers заменяют derived `movementUsd(...)` на этот override.
   * Multiple in-movements в одной tx → cost делится пропорционально по amount.
   *
   * Источник: `chain_operation_annotations.manual_cost_basis_usd` (server A3).
   * Применяется в handleTransferIn / handleBridgeIn / handleSwap.
   */
  costBasisOverrideByHash?: Map<string, number>;
}

/** Стоимость движения в USD (приоритет: hist price → m.usd → 0). */
function movementUsd(
  m: TokenMovement,
  chain: string,
  time: number,
  histPrices: Map<string, number>,
): number {
  if (m.amount <= 0) return 0;
  // H11 (2026-05-14): same depeg fix as position_lot_cost_basis.movementUsd —
  // stables go through DefiLlama hist lookup first with [$0.5, $2] sanity
  // clamp, $1 fallback only when no price.
  const coin = defillamaCoinKey(chain, m.tokenId, m.symbol);
  if (coin) {
    const hp = priceFromMap(histPrices, coin, time);
    if (hp != null && hp > 0) {
      if (isStableSymbol(m.symbol) && (hp < 0.5 || hp > 2)) {
        return m.amount;
      }
      return m.amount * hp;
    }
    // UCB D9: exact-bucket miss → ближайший bucket ±7d того же coin.
    // Sparse hist-data случается для редких токенов; approximate price
    // лучше чем 0 (которое treats lot как airdrop).
    const nearest = priceFromMapNearest(histPrices, coin, time);
    if (nearest != null && nearest.price > 0) {
      if (isStableSymbol(m.symbol) && (nearest.price < 0.5 || nearest.price > 2)) {
        return m.amount;
      }
      return m.amount * nearest.price;
    }
  }
  if (isStableSymbol(m.symbol)) return m.amount;
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
  const overrides =
    options.costBasisOverrideByHash ?? new Map<string, number>();

  // UCB D5: "bridge state" — last consumed per-unit cost для каждого
  // (walletId|family). bridge_out записывает сюда WAC ДО consume; bridge_in
  // на другой chain читает и переиспользует. Очищается по asset когда
  // bridge_in матчится (one-shot).
  const lastBridgeOutWac = new Map<string, number>();

  const sorted = [...ops].sort((a, b) => a.time - b.time);

  for (const op of sorted) {
    if (op.status === "failed") continue;
    if (isJunkOp(op)) continue;

    const override = overrides.get(op.hash.toLowerCase());

    switch (op.type) {
      case "swap":
        handleSwap(op, tracker, walletId, histPrices, override);
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
        handleTransferIn(op, tracker, walletId, histPrices, override);
        break;
      case "transfer_out":
      case "withdraw_fiat":
        handleTransferOut(op, tracker, walletId);
        break;
      case "bridge_out":
        // D5: capture pre-consume WAC per family ДО consume, чтобы
        // matching bridge_in мог переиспользовать.
        for (const m of op.movement) {
          if (m.direction !== "out" || m.amount <= 0) continue;
          const wac = tracker.wacAt(walletId, m.symbol, op.time);
          if (wac != null && wac > 0) {
            lastBridgeOutWac.set(m.symbol.toUpperCase(), wac);
          }
        }
        handleTransferOut(op, tracker, walletId);
        break;
      case "bridge_in":
        handleBridgeIn(
          op,
          tracker,
          walletId,
          histPrices,
          override,
          lastBridgeOutWac,
        );
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
  overrideUsd?: number,
): void {
  const ins = op.movement.filter((m) => m.direction === "in" && m.amount > 0);
  const outs = op.movement.filter(
    (m) => m.direction === "out" && m.amount > 0 && !isGas(m),
  );
  if (ins.length === 0 || outs.length === 0) return;

  // Total USD that was paid (out side).
  //
  // UCB invariant: cost basis of OUT-token flows through to IN-token.
  // Для stable → не важно (cost = amount = $1 × amount).
  // Для non-stable → consumed lot's WAC × amount, **не** market price.
  // Иначе token→token swap инфлирует cost basis за счёт price
  // appreciation (купил BTC за $20k → swap по market $50k → ETH lot
  // получает $50k вместо $20k → realized PnL ломается).
  let paidUsd = 0;
  for (const m of outs) {
    if (isStableSymbol(m.symbol)) {
      paidUsd += m.amount;
      tracker.consume({
        symbol: m.symbol,
        tokenId: m.tokenId,
        chain: op.chain,
        amount: m.amount,
        consumedAt: op.time,
        walletId,
      });
    } else {
      // Non-stable OUT: cost = consumed WAC × amount (НЕ market price).
      const consumed = tracker.consume({
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
        // Fallback: source token не tracked (external transfer_in
        // без cost basis) → market price лучше чем $0.
        paidUsd += movementUsd(m, op.chain, op.time, histPrices);
      }
    }
  }

  // UCB A4.2: если user задал override — заменяем derived paidUsd на него.
  // Out-side всё равно consumed (без override это и происходило бы), только
  // cost basis новых in-lots использует user value.
  if (
    overrideUsd != null &&
    Number.isFinite(overrideUsd) &&
    overrideUsd >= 0
  ) {
    paidUsd = overrideUsd;
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
  // UCB D6: rewards имеют cost basis = $0 (user ничего не заплатил).
  // Sale такого лота даёт realized = full proceeds. Market price на
  // момент получения сохраняется как `fmvAtAcquisitionUsd` для будущего
  // income-reporting (tax: ordinary income at FMV at receipt).
  for (const m of op.movement) {
    if (m.direction !== "in" || m.amount <= 0) continue;
    const fmvUsd = isStableSymbol(m.symbol)
      ? m.amount
      : movementUsd(m, op.chain, op.time, histPrices);
    tracker.acquire({
      symbol: m.symbol,
      tokenId: m.tokenId,
      chain: op.chain,
      amount: m.amount,
      costPerUnitUsd: 0,
      acquiredAt: op.time,
      acquiredVia: "received_as_reward",
      sourceHash: op.hash,
      walletId,
      fmvAtAcquisitionUsd: fmvUsd,
    });
  }
}

function handleTransferIn(
  op: ClassifiedOp,
  tracker: LotTracker,
  walletId: string,
  histPrices: Map<string, number>,
  overrideUsd?: number,
): void {
  // Transfer in: external income / CEX deposit / fiat purchase.
  // Cost = market price на момент (если задан manual_annotations.fiatPurchase
  // — это уже учтено классификатором через op.type).
  //
  // UCB A4.2: если задан `overrideUsd` (annotation manual_cost_basis_usd),
  // делим его пропорционально между in-movements по amount — игнорируя
  // derived market prices. Это user explicit override.
  const ins = op.movement.filter((m) => m.direction === "in" && m.amount > 0);
  const totalAmount = ins.reduce((s, m) => s + m.amount, 0);
  for (const m of ins) {
    let usd: number;
    if (
      overrideUsd != null &&
      Number.isFinite(overrideUsd) &&
      overrideUsd >= 0 &&
      totalAmount > 0
    ) {
      usd = overrideUsd * (m.amount / totalAmount);
    } else {
      usd = isStableSymbol(m.symbol)
        ? m.amount
        : movementUsd(m, op.chain, op.time, histPrices);
    }
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
  overrideUsd?: number,
  lastBridgeOutWac?: Map<string, number>,
): void {
  // UCB D5: bridge_in cost basis inheritance.
  //
  // Precedence:
  //   1. explicit overrideUsd (A4 manual / D3 server CEX inheritance)
  //   2. lastBridgeOutWac[symbol-family] (paired bridge_out — same wallet,
  //      pre-consume WAC сохранён)
  //   3. existing WAC of (walletId, family) если ещё не fully consumed
  //   4. fallback: derived market price (первый bridge_in без prior history)
  const ins = op.movement.filter((m) => m.direction === "in" && m.amount > 0);
  const totalAmount = ins.reduce((s, m) => s + m.amount, 0);
  for (const m of ins) {
    let usd: number;
    if (
      overrideUsd != null &&
      Number.isFinite(overrideUsd) &&
      overrideUsd >= 0 &&
      totalAmount > 0
    ) {
      usd = overrideUsd * (m.amount / totalAmount);
    } else {
      const symKey = m.symbol.toUpperCase();
      const wacFromBridge = lastBridgeOutWac?.get(symKey);
      if (wacFromBridge != null && wacFromBridge > 0) {
        usd = m.amount * wacFromBridge;
        // one-shot: после успешного match очищаем (не reuse'м для
        // следующего unrelated bridge_in того же family).
        lastBridgeOutWac?.delete(symKey);
      } else {
        const existingWac = tracker.wacAt(walletId, m.symbol, op.time);
        if (existingWac != null && existingWac > 0) {
          usd = m.amount * existingWac;
        } else {
          usd = isStableSymbol(m.symbol)
            ? m.amount
            : movementUsd(m, op.chain, op.time, histPrices);
        }
      }
    }
    tracker.acquire({
      symbol: m.symbol,
      tokenId: m.tokenId,
      chain: op.chain,
      amount: m.amount,
      costPerUnitUsd: m.amount > 0 ? usd / m.amount : 0,
      acquiredAt: op.time,
      acquiredVia: "bridge_in",
      sourceHash: op.hash,
      walletId,
    });
  }
}
