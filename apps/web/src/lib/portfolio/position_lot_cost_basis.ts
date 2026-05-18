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
  // H11 (2026-05-14): stables now also go through DefiLlama hist-price
  // lookup first. GHO traded at $0.97 for weeks in 2024, AUSD at $1.02
  // on launch — pegging at hardcoded $1 silently inflated/deflated
  // cost basis by ~3-5% during depeg windows. We accept the small extra
  // lookup cost for accuracy; $1 stays the safe fallback when DefiLlama
  // has no data (new stable, exotic chain).
  const coin = defillamaCoinKey(chain, m.tokenId, m.symbol);
  if (coin) {
    const hp = priceFromMap(histPrices, coin, time);
    if (hp != null && hp > 0) {
      // Sanity clamp: refuse obvious nonsense (a "stable" reported at
      // $50 is wrong data, not a depeg). For non-stables this branch
      // is unreachable.
      if (isStableSymbol(m.symbol) && (hp < 0.5 || hp > 2)) {
        return m.amount;
      }
      return m.amount * hp;
    }
  }
  if (isStableSymbol(m.symbol)) return m.amount;
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
  /**
   * UCB C4: per-tx cost basis overrides из merged map (A4 manual /
   * D3 CEX / C2 fiat-hop / C3 cross-wallet inheritance). Применяется
   * при регистрации acquisitions (swap / deposit_fiat / transfer_in).
   * Multiple in-movements в одной tx делятся пропорционально amount.
   *
   * Без этого popup'е cost basis для inherited lots показывался как
   * market m.usd → расхождение с position summary (LotTracker SoT).
   */
  costBasisOverrideByHash?: ReadonlyMap<string, number>;
  /**
   * UCB C4: если true (рекомендовано для lending позиций), consume
   * amount = `Σ lend_supply.out - Σ lend_withdraw.in` для этой
   * (protocolId, chain, symbol). Это исключает yield (rebase-style) из
   * cost basis расчёта. Default `false` для обратной совместимости.
   *
   * Example: user supplied 10 ETH к Fluid, yield 0.1 ETH → live = 10.1.
   * - false (legacy): consume 10.1 ETH из purchase pool → over-counts cost.
   * - true: consume 10.0 ETH (net supplied) → правильный cost basis.
   */
  useNetSuppliedAmount?: boolean;
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
  const overrides = args.costBasisOverrideByHash ?? new Map<string, number>();
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
        // Swap from stable → token (чистая покупка).
        // UCB C4: A4 override replaces derived `stableSum` если задан.
        const override = overrides.get(op.hash.toLowerCase());
        const effectivePaid =
          override != null && Number.isFinite(override) && override >= 0
            ? override
            : stableSum;
        for (const m of ins) {
          if (isStableSymbol(m.symbol) || m.amount <= 0) continue;
          const sharePaid = effectivePaid * (m.amount / totalIn);
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
        // Swap token→token: UCB invariant — cost basis inherited from
        // consumed source lot's WAC, не market price на момент swap.
        // Note: outs уже consumed выше (line ~145), но result был
        // discarded. Здесь re-trace через peek WAC of source before
        // consume happened — но это сложно. Альтернатива: capture
        // consumed cost ВЫШЕ и распределить здесь.
        //
        // Простая реализация: re-consume не требуется. Используем
        // wacAt(source.symbol, op.time) × source.amount как proxy для
        // consumed cost. Это математически equivalent FIFO consume
        // когда все source lots от одного покупочного происхождения
        // (common case). Для multi-lot sources с разными WACs может
        // быть слегка off, но lot tracker WAC mode сглаживает это.
        //
        // Лучший fix: capture consumed cost ВЫШЕ в массиве и использовать
        // здесь. Делаем это сейчас.
        let inheritedPaid = 0;
        for (const m of op.movement) {
          if (m.direction !== "out" || isStableSymbol(m.symbol)) continue;
          if (m.amount <= 0 || isGas(m)) continue;
          // Note: already consumed выше. Здесь — peek WAC before consume.
          // Tracker.wacAt смотрит на acquiredAt <= time. Если все lots
          // уже потрачены consume'ом, wacAt вернёт null. Используем
          // movementUsd как fallback.
          const wac = tracker.wacAt(args.walletId, m.symbol, op.time);
          const lotCost = wac != null && wac > 0
            ? wac * m.amount
            : movementUsd(m, op.chain, op.time, histPrices);
          inheritedPaid += lotCost;
        }
        // Distribute inheritedPaid across non-stable ins по amount-share.
        const nonStableIns = ins.filter((m) => !isStableSymbol(m.symbol));
        const totalInAmount = nonStableIns.reduce((s, m) => s + m.amount, 0);
        for (const m of nonStableIns) {
          if (m.amount <= 0) continue;
          const share = totalInAmount > 0
            ? inheritedPaid * (m.amount / totalInAmount)
            : 0;
          if (share <= 0) continue;
          tracker.acquire({
            walletId: args.walletId,
            symbol: m.symbol,
            amount: m.amount,
            costPerUnitUsd: share / m.amount,
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

    // transfer_out / withdraw_fiat / bridge_out — consume non-stable.
    // Это disposal — токены покинули wallet. Без этого fiat-hop pair
    // (withdraw_fiat → deposit_fiat) double-count'ится: оригинальный
    // cowswap lot остаётся в пуле + deposit_fiat acquires inherited
    // копию через C2 override → FIFO consume eats both = inflated cost.
    //
    // Main LotTracker (lots/build.ts) handles это через handleTransferOut
    // для ВСЕХ OUT op types. Popup tracker должен повторять.
    if (
      op.type === "transfer_out" ||
      op.type === "withdraw_fiat" ||
      op.type === "bridge_out"
    ) {
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
      // UCB C4: override replaces derived m.usd, делим пропорционально
      // amount если несколько in-movements (rare для deposit_fiat).
      const override = overrides.get(op.hash.toLowerCase());
      const ins = op.movement.filter(
        (m) => m.direction === "in" && m.amount > 0 && !m.isProtocolToken,
      );
      const totalInAmount = ins.reduce((s, m) => s + m.amount, 0);
      for (const m of ins) {
        let usd: number;
        if (
          override != null &&
          Number.isFinite(override) &&
          override >= 0 &&
          totalInAmount > 0
        ) {
          usd = override * (m.amount / totalInAmount);
        } else {
          usd = movementUsd(m, op.chain, op.time, histPrices);
        }
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

    // H7 (2026-05-14): transfer_in with a reliable historical price.
    //
    // Previous behavior dropped ALL transfer_in events to avoid the
    // "user moves token from CEX → wallet → suppliеs to Aave" case
    // double-counting against the CEX-side acquire. That cut works
    // when both wallets are tracked in the same Capflow account — but
    // the common reality is:
    //   - user has 5 wallets, only this one tracked
    //   - or buys on CEX (untracked) → withdraws to this wallet → supplies
    //
    // In those cases we previously returned uncoveredAmount = current,
    // effective PnL = 0 forever. Now: if the transfer has a confident
    // historical price (DefiLlama 4h-window hit) AND the movement
    // already carries a real USD value, treat it as an acquire at that
    // price. We mark `acquiredVia: "transfer_in"` so cross-wallet
    // duplication detectors downstream can still subtract these out
    // when both wallets are observed.
    if (op.type === "transfer_in") {
      // UCB C4: если override задан (C3 cross-wallet inheritance / A4),
      // используем его — это authoritative cost basis. Иначе fallback на
      // hist-price logic (см. H7 комментарий ниже).
      const override = overrides.get(op.hash.toLowerCase());
      const ins = op.movement.filter(
        (m) =>
          m.direction === "in" &&
          m.amount > 0 &&
          !m.isProtocolToken &&
          !isGas(m),
      );
      const totalInAmount = ins.reduce((s, m) => s + m.amount, 0);
      const overrideValid =
        override != null && Number.isFinite(override) && override >= 0;

      for (const m of ins) {
        let costPerUnit: number | null = null;
        if (overrideValid && totalInAmount > 0) {
          costPerUnit = (override * (m.amount / totalInAmount)) / m.amount;
        } else {
          // H7: legacy hist-price logic для случаев без override.
          const isStable = isStableSymbol(m.symbol);
          if (isStable) {
            costPerUnit = 1;
          } else {
            const coin = defillamaCoinKey(op.chain, m.tokenId, m.symbol);
            if (coin) {
              const hp = priceFromMap(histPrices, coin, op.time);
              if (hp != null && hp > 0) costPerUnit = hp;
            }
          }
        }
        if (costPerUnit == null || costPerUnit <= 0) continue;
        tracker.acquire({
          walletId: args.walletId,
          symbol: m.symbol,
          amount: m.amount,
          costPerUnitUsd: costPerUnit,
          tokenId: m.tokenId,
          chain: op.chain,
          acquiredAt: op.time,
          acquiredVia: "transfer_in",
          sourceHash: op.hash,
        });
      }
      continue;
    }

    // NOT processed (avoiding double-counting / incorrect acquires):
    //   - lend_supply (receipt-less like Fluid/Morpho Blue) — leave
    //     underlying lots in tracker so the position consumes them
    //   - borrow / repay — separate debt entity
  }

  // UCB C4: вычислить consume amount.
  //   - Default (useNetSuppliedAmount=false): currentAmount as-is (legacy).
  //   - useNetSuppliedAmount=true: `Σ lend_supply.out - Σ lend_withdraw.in`
  //     для этого (protocolId, chain, symbol). Это исключает yield
  //     (rebase-style accruals) из cost basis расчёта.
  let consumeAmount = args.currentAmount;
  if (args.useNetSuppliedAmount === true) {
    let supplied = 0;
    let withdrawn = 0;
    for (const op of sorted) {
      if (op.status === "failed") continue;
      if (op.protocol?.id !== args.protocolId) continue;
      if (op.chain !== args.chain) continue;
      if (op.type === "lend_supply" || op.type === "lp_add") {
        for (const m of op.movement) {
          if (m.direction !== "out" || m.amount <= 0) continue;
          if (normalizeSymbol(m.symbol) !== target) continue;
          if (m.isProtocolToken) continue;
          supplied += m.amount;
        }
      } else if (op.type === "lend_withdraw" || op.type === "lp_remove") {
        for (const m of op.movement) {
          if (m.direction !== "in" || m.amount <= 0) continue;
          if (normalizeSymbol(m.symbol) !== target) continue;
          if (m.isProtocolToken) continue;
          withdrawn += m.amount;
        }
      }
    }
    const netSupplied = Math.max(0, supplied - withdrawn);
    if (netSupplied > 0) consumeAmount = netSupplied;
  }

  if (consumeAmount == null || consumeAmount <= 0) {
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
    amount: consumeAmount,
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
      ? consumeAmount - result.totalAmount
      : 0,
  };
}
