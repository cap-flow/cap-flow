/**
 * Per-position cost basis underlying токена через **purchase-only lot
 * tracker** + consume по выбранной методике (FIFO/LIFO/WAC).
 *
 * **Подход**: трекер регистрирует ТОЛЬКО события-покупки (swap_from_stable,
 * swap_from_token, fiat_buy, lp_close attribution). DeFi-операции
 * (lend_supply / lp_add / borrow / Aave round-trips) НЕ влияют на lot
 * tracker. Это устраняет проблему с borrow loops где cost basis "теряется"
 * через цепочку supply→borrow→supply.
 *
 * Затем для конкретной позиции:
 *   1. Берём её current_amount underlying
 *   2. consume этот amount из purchase-tracker по выбранной методике
 *   3. Сумма consumed lots = startUsd позиции
 *
 * Результат: для POS-005 Fluid WBTC (4 покупки на $30,000, current 0.368)
 *   FIFO consume 0.368 → берёт все 4 lots → cost = $30,000 ✓
 *   LIFO consume 0.368 → берёт от новых → тоже $30,000 (все consumed)
 *   WAC consume 0.368 → cost = $30,000 (все consumed)
 *
 * Для позиций где current_amount < total_purchased (часть продана/
 * переведена), методики дадут разные результаты — toggle FIFO/LIFO/WAC
 * имеет смысл.
 */

import { LotTracker } from "./lots/lot_tracker";
import type { LotMethodology } from "./lots/types";
import { isStableSymbol } from "./protocols";
import { isJunkOp } from "./junk_filter";
import type { ClassifiedOp, TokenMovement } from "./types";
import { defillamaCoinKey, priceFromMap } from "@/lib/defillama";

function normalizeSymbol(s: string): string {
  const u = s.toUpperCase();
  return u === "WETH" ? "ETH" : u;
}

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

function isGas(m: TokenMovement): boolean {
  if (m.symbol !== "ETH" && m.symbol !== "WETH") return false;
  return m.amount < 0.01 && (m.usd ?? 0) < 100;
}

export interface SuppliedLotConsumption {
  purchaseTime: number;
  costPerUnit: number;
  amount: number;
  costUsd: number;
  acquiredVia: string;
}

export interface PositionLotCostBasisResult {
  methodology: LotMethodology;
  consumedLots: SuppliedLotConsumption[];
  totalAmountSupplied: number;
  totalCostUsd: number;
  effectiveWac: number;
  uncoveredAmount: number;
}

interface Args {
  ops: ClassifiedOp[];
  walletId: string;
  protocolId: string;
  chain: string;
  symbol: string;
  /** Сколько токена в текущей позиции — для consume. Если не задан,
   *  consume не вызывается, возвращается empty result. */
  currentAmount?: number;
  methodology?: LotMethodology;
  histPrices?: Map<string, number>;
}

/**
 * Прогон ops через purchase-only LotTracker. Регистрируем все true
 * purchases как acquire (swap stable→token, swap token→token, transfer_in
 * с known USD, lp_remove returns с attributed cost).
 *
 * Затем consume currentAmount из tracker'а по выбранной методике.
 * Это даёт cost basis именно для current_amount в этой позиции.
 *
 * Если currentAmount не задан — возвращает empty result (как раньше).
 */
export function getPositionLotCostBasis(
  args: Args,
): PositionLotCostBasisResult {
  const methodology = args.methodology ?? "FIFO";
  const target = normalizeSymbol(args.symbol);
  const histPrices = args.histPrices ?? new Map<string, number>();
  const tracker = new LotTracker(methodology);

  const sorted = [...args.ops].sort((a, b) => a.time - b.time);

  for (const op of sorted) {
    if (op.status === "failed") continue;
    if (isJunkOp(op)) continue;

    // Только PURCHASE events регистрируем как acquire. DeFi-операции
    // (lend_supply, lp_add, borrow, и т.п.) НЕ влияют на purchase tracker.

    if (op.type === "swap") {
      const stableOuts = op.movement.filter(
        (m) => m.direction === "out" && m.isStable && m.amount > 0,
      );
      const ins = op.movement.filter(
        (m) => m.direction === "in" && m.amount > 0,
      );
      const stableSum = stableOuts.reduce((s, m) => s + m.amount, 0);
      const totalIn = ins.reduce((s, m) => s + m.amount, 0);

      // CONSUME non-stable OUT (user продал — tokens disposed). Это
      // критично для корректной "доступной массы": если user продал часть
      // купленных токенов, она не должна оставаться в tracker'е и
      // double-count'иться с current position.
      for (const m of op.movement) {
        if (m.direction !== "out" || isStableSymbol(m.symbol)) continue;
        if (m.amount <= 0 || isGas(m)) continue;
        tracker.consume({
          walletId: args.walletId,
          symbol: m.symbol,
          amount: m.amount,
          tokenId: m.tokenId,
          chain: op.chain,
        });
      }

      if (stableSum > 0 && totalIn > 0) {
        // Swap from stable → token (чистая покупка)
        for (const m of ins) {
          if (isStableSymbol(m.symbol) || m.amount <= 0) continue;
          const sharePaid = stableSum * (m.amount / totalIn);
          const costPerUnit = sharePaid / m.amount;
          tracker.acquire({
            walletId: args.walletId,
            symbol: m.symbol,
            amount: m.amount,
            costPerUnitUsd: costPerUnit,
            tokenId: m.tokenId,
            chain: op.chain,
            acquiredAt: op.time,
            acquiredVia: "buy_with_stable",
            sourceHash: op.hash,
          });
        }
      } else {
        // Swap token→token: cost = hist USD отданного non-stable.
        for (const m of ins) {
          if (m.amount <= 0 || isStableSymbol(m.symbol)) continue;
          const usd = movementUsd(m, op.chain, op.time, histPrices);
          if (usd <= 0) continue;
          tracker.acquire({
            walletId: args.walletId,
            symbol: m.symbol,
            amount: m.amount,
            costPerUnitUsd: usd / m.amount,
            tokenId: m.tokenId,
            chain: op.chain,
            acquiredAt: op.time,
            acquiredVia: "swap",
            sourceHash: op.hash,
          });
        }
      }
      continue;
    }

    // transfer_out (gift / send to external) — consume non-stable.
    // Это disposal — токены покинули owner'а, lots убираются.
    if (op.type === "transfer_out") {
      for (const m of op.movement) {
        if (m.direction !== "out" || isStableSymbol(m.symbol)) continue;
        if (m.amount <= 0 || isGas(m)) continue;
        tracker.consume({
          walletId: args.walletId,
          symbol: m.symbol,
          amount: m.amount,
          tokenId: m.tokenId,
          chain: op.chain,
        });
      }
      continue;
    }

    if (op.type === "deposit_fiat") {
      // Только явные fiat-deposits регистрируем как acquire. transfer_in
      // НЕ обрабатываем — это может быть cross-wallet перевод который
      // double-count'ится с оригинальной покупкой на другом кошельке.
      for (const m of op.movement) {
        if (m.direction !== "in" || m.amount <= 0) continue;
        if (m.isProtocolToken) continue;
        const usd = movementUsd(m, op.chain, op.time, histPrices);
        if (usd <= 0) continue;
        tracker.acquire({
          walletId: args.walletId,
          symbol: m.symbol,
          amount: m.amount,
          costPerUnitUsd: usd / m.amount,
          tokenId: m.tokenId,
          chain: op.chain,
          acquiredAt: op.time,
          acquiredVia: "manual_seed",
          sourceHash: op.hash,
        });
      }
      continue;
    }

    // lp_add WITH receipt-token IN (GMX V2 → GLV/GM, Aave → aToken,
    // Compound → cToken, Lido → stETH и т.п.). Cost basis underlying
    // flows to receipt → user может потом supply receipt в Morpho и
    // получить корректный cost basis.
    if (op.type === "lp_add") {
      const receiptIns = op.movement.filter(
        (m) =>
          m.direction === "in" && m.isProtocolToken && m.amount > 0,
      );
      if (receiptIns.length > 0) {
        const stableOuts = op.movement.filter(
          (m) => m.direction === "out" && m.isStable && m.amount > 0,
        );
        const nonStableOuts = op.movement.filter(
          (m) =>
            m.direction === "out" &&
            !m.isStable &&
            !m.isProtocolToken &&
            m.amount > 0 &&
            !isGas(m),
        );
        // 1) Considerstable OUT cost.
        let totalCost = stableOuts.reduce((s, m) => s + m.amount, 0);
        // 2) Consume non-stable OUT (underlying tokens) and accumulate
        //    их cost basis (из ранее acquired lots).
        for (const m of nonStableOuts) {
          const r = tracker.consume({
            walletId: args.walletId,
            symbol: m.symbol,
            amount: m.amount,
            tokenId: m.tokenId,
            chain: op.chain,
          });
          // Если в tracker'е не было нужных lots — fallback на hist USD.
          if (r.totalAmount > 0) {
            totalCost += r.totalCostUsd;
          } else {
            totalCost += movementUsd(m, op.chain, op.time, histPrices);
          }
        }
        // 3) Acquire receipt-токены с cost basis = totalCost (proportionally).
        const totalReceiptIn = receiptIns.reduce((s, m) => s + m.amount, 0);
        if (totalCost > 0 && totalReceiptIn > 0) {
          for (const m of receiptIns) {
            const sharePaid = totalCost * (m.amount / totalReceiptIn);
            tracker.acquire({
              walletId: args.walletId,
              symbol: m.symbol,
              amount: m.amount,
              costPerUnitUsd: sharePaid / m.amount,
              tokenId: m.tokenId,
              chain: op.chain,
              acquiredAt: op.time,
              acquiredVia: "linked_async_fill",
              sourceHash: op.hash,
            });
          }
        }
      }
      // Если нет receipt'а (receipt-less protocol), не трогаем tracker —
      // underlying lots остаются для consume позицией later.
      continue;
    }

    // lp_remove / lend_withdraw / unstake WITH receipt OUT + underlying IN.
    // Cost basis flows backward: receipt's cost → underlying.
    if (
      op.type === "lp_remove" ||
      op.type === "lend_withdraw" ||
      op.type === "unstake"
    ) {
      const receiptOuts = op.movement.filter(
        (m) =>
          m.direction === "out" && m.isProtocolToken && m.amount > 0,
      );
      const underlyingIns = op.movement.filter(
        (m) =>
          m.direction === "in" &&
          !m.isProtocolToken &&
          !m.isStable &&
          m.amount > 0,
      );
      if (receiptOuts.length > 0) {
        // 1) Consume receipt-токены, accumulate их total cost basis.
        let totalReceiptCost = 0;
        for (const m of receiptOuts) {
          const r = tracker.consume({
            walletId: args.walletId,
            symbol: m.symbol,
            amount: m.amount,
            tokenId: m.tokenId,
            chain: op.chain,
          });
          totalReceiptCost += r.totalCostUsd;
        }
        // 2) Acquire underlying IN с распределённым cost basis.
        const totalUnderlyingIn = underlyingIns.reduce(
          (s, m) => s + m.amount,
          0,
        );
        if (totalReceiptCost > 0 && totalUnderlyingIn > 0) {
          for (const m of underlyingIns) {
            const share = totalReceiptCost * (m.amount / totalUnderlyingIn);
            tracker.acquire({
              walletId: args.walletId,
              symbol: m.symbol,
              amount: m.amount,
              costPerUnitUsd: share / m.amount,
              tokenId: m.tokenId,
              chain: op.chain,
              acquiredAt: op.time,
              acquiredVia: "lp_close",
              sourceHash: op.hash,
            });
          }
        }
      }
      // Если без receipt-токена (receipt-less protocol), не трогаем.
      continue;
    }

    // НЕ обрабатываем (избегаем double-counting / некорректные acquires):
    //   - transfer_in — может быть cross-wallet дубль
    //   - lend_supply (receipt-less, как Fluid/Morpho Blue) — оставляем
    //     underlying lots в tracker'е для consume позицией
    //   - borrow / repay — это долг, отдельная сущность
  }

  // Теперь consume currentAmount из purchase-tracker по выбранной методике.
  if (args.currentAmount == null || args.currentAmount <= 0) {
    return {
      methodology,
      consumedLots: [],
      totalAmountSupplied: 0,
      totalCostUsd: 0,
      effectiveWac: 0,
      uncoveredAmount: 0,
    };
  }

  const result = tracker.consume({
    walletId: args.walletId,
    symbol: target,
    amount: args.currentAmount,
  });

  const consumedLots: SuppliedLotConsumption[] = result.consumed.map((c) => ({
    purchaseTime: c.lot.acquiredAt,
    costPerUnit: c.lot.costPerUnitUsd,
    amount: c.amountConsumed,
    costUsd: c.costAttributedUsd,
    acquiredVia: c.lot.acquiredVia,
  }));

  return {
    methodology,
    consumedLots,
    totalAmountSupplied: result.totalAmount,
    totalCostUsd: result.totalCostUsd,
    effectiveWac:
      result.totalAmount > 0 ? result.totalCostUsd / result.totalAmount : 0,
    uncoveredAmount: result.insufficient
      ? args.currentAmount - result.totalAmount
      : 0,
  };
}
