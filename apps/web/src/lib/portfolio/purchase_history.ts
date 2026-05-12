/**
 * История движений токена для popup'а "Откуда формируется Стартовая $".
 *
 * Возвращает ВСЕ движения targetSymbol в порядке времени, с маркером
 * `affectsWac` который говорит — добавляется ли это событие в WAC расчёт.
 *
 * **Правила формирования WAC** (consistent с `cost_basis_tracker.ts`):
 *
 * | Тип события                          | Кол-во      | WAC      |
 * |--------------------------------------|-------------|----------|
 * | `swap_from_stable` (USDT→ETH)        | +amount     | ✅ обновляет avg |
 * | `swap_from_token` (WBTC→ETH)         | +amount     | ✅ обновляет avg |
 * | `fiat_buy` (явная фиат-покупка)       | +amount     | ✅ обновляет avg |
 * | `lp_close_attribution` (lp_remove)   | +amount     | ⚠️ inherited cost basis |
 * | `transfer_in` (перевод)              | +amount     | ❌ не считается покупкой |
 * | `sell_to_stable` (ETH→USDT)          | −amount     | ❌ кумулятивный (avg сохраняется) |
 * | `sell_to_token` (ETH→WBTC)           | −amount     | ❌ кумулятивный (для ETH) |
 * | `transfer_out` (перевод)              | −amount     | ❌ просто расход |
 * | `lend_supply` / `lp_add`              | −amount     | ❌ deployment в позицию |
 *
 * **Цена покупки** (для swap_from_token / WBTC→ETH):
 *   price = (WAC_WBTC × WBTC.amount) / ETH.amount
 *   То есть берём НАШУ среднюю цену отдаваемого токена (из tracker'а),
 *   а не market hist price. Это даёт корректный propagation cost basis
 *   между активами.
 */

import type { ClassifiedOp, TokenMovement } from "./types";
import { isStableSymbol } from "./protocols";
import {
  buildCostBasisTracker,
  type CostBasisTracker,
} from "./cost_basis_tracker";
import { defillamaCoinKey, priceFromMap } from "@/lib/defillama";

/** Локальный normalize: WETH→ETH (для группировки). */
function normalizeSymbol(s: string): string {
  const u = s.toUpperCase();
  if (u === "WETH") return "ETH";
  return u;
}

export type PurchaseEventKind =
  | "swap_from_stable" // USDT → ETH (покупка за стейбл)
  | "swap_from_token" // WBTC → ETH (покупка через своп с другого токена)
  | "fiat_buy" // явная пометка "куплено за фиат"
  | "lp_close_attribution" // lp_remove — inherited cost basis от lp_add
  | "transfer_in" // перевод с кошелька (НЕ покупка)
  | "sell_to_stable" // ETH → USDT (продажа за стейбл, realized PnL)
  | "sell_to_token" // ETH → WBTC (своп в другой токен)
  | "transfer_out" // перевод (НЕ продажа)
  | "deploy" // lend_supply / lp_add — отправка в позицию
  | "other";

export interface PurchaseEvent {
  /** unix sec. */
  time: number;
  /** Какая op'а породила. */
  hash: string;
  kind: PurchaseEventKind;
  /** Сколько токена пришло (positive) или ушло (negative). */
  amount: number;
  /**
   * USD-стоимость "вклада" в cost basis. Для покупок = сколько user заплатил.
   * Для sell/transfer = informational только.
   */
  costUsd: number;
  /** Cost basis цена за единицу = costUsd / |amount|. Для swap_from_token
   *  это **WAC отданного токена / полученного нового токена** — может
   *  существенно отличаться от market price если отданный токен изменил
   *  цену с момента покупки. */
  pricePerUnit: number;
  /** Market price targetSymbol на момент op.time (DefiLlama hist).
   *  Показывается рядом с cost basis price для прозрачности — особенно
   *  важно для swap_from_token где cost basis может расходиться с market. */
  marketPriceAtOp?: number;
  /** Влияет ли на WAC (только true buys). */
  affectsWac: boolean;
  /** Что отдали или получили взамен (контекст для UI). */
  counterpart?: { symbol: string; amount: number };
  chain: string;
}

/**
 * Получить полную историю движений `targetSymbol` для popup'а.
 *
 * @param ops — все ops кошелька
 * @param targetSymbol — например "WETH" или "ETH"
 * @param histPrices — DefiLlama hist prices для swap_from_token (наш WAC
 *                      уже учтён через tracker, но fallback на hist price
 *                      если tracker.avgAt вернул null)
 */
export function getPurchaseHistory(
  ops: ClassifiedOp[],
  targetSymbol: string,
  histPrices?: Map<string, number>,
): PurchaseEvent[] {
  const target = normalizeSymbol(targetSymbol);
  const out: PurchaseEvent[] = [];
  const sorted = [...ops].sort((a, b) => a.time - b.time);

  // Cost basis tracker — наша authoritative WAC. Строим его на тех же ops
  // чтобы swap_from_token использовал правильную цену отдаваемого токена.
  const tracker: CostBasisTracker = buildCostBasisTracker(
    sorted,
    histPrices ?? new Map(),
  );

  for (const op of sorted) {
    if (op.status !== "ok") continue;

    // Найти все movements targetSymbol в этом op'е.
    const targetMoves = op.movement.filter(
      (m) => normalizeSymbol(m.symbol) === target && m.amount > 0,
    );
    if (targetMoves.length === 0) continue;

    const ins = targetMoves.filter((m) => m.direction === "in");
    const outs = targetMoves.filter((m) => m.direction === "out");
    const inAmount = ins.reduce((s, m) => s + m.amount, 0);
    const outAmount = outs.reduce((s, m) => s + m.amount, 0);

    // Market price targetSymbol на момент op.time через DefiLlama hist —
    // показывается рядом с cost basis для прозрачности (важно для
    // swap_from_token где WAC отданного токена может расходиться с market).
    const targetMove = targetMoves[0]!;
    const targetCoin = isStableSymbol(targetMove.symbol)
      ? null
      : defillamaCoinKey(op.chain, targetMove.tokenId, targetMove.symbol);
    const marketPriceAtOp =
      targetCoin && histPrices
        ? priceFromMap(histPrices, targetCoin, op.time) ?? undefined
        : isStableSymbol(targetMove.symbol)
          ? 1
          : undefined;

    // Other movements в op'е (без targetSymbol).
    const otherMoves = op.movement.filter(
      (m) => normalizeSymbol(m.symbol) !== target,
    );
    const meaningfulOtherOuts = otherMoves.filter(
      (m) =>
        m.direction === "out" &&
        m.amount > 0 &&
        !m.isProtocolToken &&
        !(
          (m.symbol === "ETH" || m.symbol === "WETH") &&
          m.amount < 0.01 &&
          (m.usd ?? 0) < 100
        ),
    );
    const meaningfulOtherIns = otherMoves.filter(
      (m) =>
        m.direction === "in" &&
        m.amount > 0 &&
        !m.isProtocolToken,
    );

    // ─── IN events ──────────────────────────────────────────────
    if (inAmount > 0) {
      const otherStableOuts = meaningfulOtherOuts.filter((m) =>
        isStableSymbol(m.symbol),
      );
      const otherNonStableOuts = meaningfulOtherOuts.filter(
        (m) => !isStableSymbol(m.symbol),
      );

      let kind: PurchaseEventKind;
      let costUsd = 0;
      let counterpart: PurchaseEvent["counterpart"] | undefined;
      let affectsWac = false;

      if (op.type === "lp_remove") {
        // Возврат из LP — cost basis attributed через cost_basis_tracker
        // (lpCloseCost). UI показывает как информационный; tracker внутри
        // знает корректный WAC.
        kind = "lp_close_attribution";
        const wacAt = tracker.avgAt(target, op.time);
        costUsd = wacAt != null ? wacAt * inAmount : 0;
        affectsWac = false; // attribution делается tracker'ом отдельно
      } else if (
        op.type === "lp_add" &&
        ins.some((m) => m.isProtocolToken)
      ) {
        // GMX V2 / Aave / Compound: receipt-token IN (GLV/aToken/cToken).
        // Cost basis underlying flows to receipt — это покупка receipt'а.
        kind = "swap_from_token";
        affectsWac = true;
        if (meaningfulOtherOuts.length > 0) {
          // Single-tx lp_add (Uni V3 style) — есть out underlying в этом же tx
          let totalOutCost = 0;
          for (const m of meaningfulOtherOuts) {
            if (isStableSymbol(m.symbol)) {
              totalOutCost += m.amount;
              continue;
            }
            const wac = tracker.avgAt(m.symbol, op.time);
            totalOutCost +=
              wac != null && wac > 0
                ? m.amount * wac
                : m.usd != null && m.usd > 0
                  ? m.usd
                  : 0;
          }
          costUsd = totalOutCost;
          counterpart =
            meaningfulOtherOuts.length > 0
              ? {
                  symbol: meaningfulOtherOuts[0]!.symbol,
                  amount: meaningfulOtherOuts.reduce((s, m) => s + m.amount, 0),
                }
              : undefined;
        } else if (op.linkedCostBasisUsd != null && op.linkedCostBasisUsd > 0) {
          // Async-deposit (GMX V2): underlying ушло в linked Tx A, cost
          // basis уже вычислен в classifier'е через `linkedCostBasisUsd`.
          costUsd = op.linkedCostBasisUsd;
          counterpart = op.linkedLpSymbol
            ? { symbol: op.linkedLpSymbol, amount: 0 }
            : undefined;
        } else {
          // Нет cost basis info — не считаем покупкой.
          kind = "transfer_in";
          affectsWac = false;
        }
      } else if (
        otherStableOuts.length > 0 &&
        otherNonStableOuts.length === 0
      ) {
        // Чистый swap from stable → ПОКУПКА.
        kind = "swap_from_stable";
        costUsd = otherStableOuts.reduce((s, m) => s + m.amount, 0); // stable = $1
        counterpart = {
          symbol: otherStableOuts[0]!.symbol,
          amount: costUsd,
        };
        affectsWac = true;
      } else if (otherNonStableOuts.length > 0) {
        // Swap from non-stable token → ПОКУПКА с использованием НАШЕЙ WAC
        // отдаваемого токена (не market hist price).
        kind = "swap_from_token";
        let totalOutCost = 0;
        for (const m of meaningfulOtherOuts) {
          if (isStableSymbol(m.symbol)) {
            totalOutCost += m.amount;
            continue;
          }
          const wac = tracker.avgAt(m.symbol, op.time);
          if (wac != null && wac > 0) {
            totalOutCost += m.amount * wac;
          } else if (m.usd != null && m.usd > 0) {
            // Fallback на DeBank m.usd (может быть current spot — не идеально).
            totalOutCost += m.usd;
          }
        }
        costUsd = totalOutCost;
        counterpart = {
          symbol: otherNonStableOuts[0]!.symbol,
          amount: meaningfulOtherOuts.reduce((s, m) => s + m.amount, 0),
        };
        affectsWac = true;
      } else if (meaningfulOtherOuts.length === 0) {
        // Только in — это transfer_in или airdrop. НЕ покупка.
        kind = "transfer_in";
        // Цена для информационного отображения через hist price (если есть).
        const wacAt = tracker.avgAt(target, op.time);
        if (wacAt != null && wacAt > 0) {
          costUsd = wacAt * inAmount; // показываем по нашей avg
        }
        affectsWac = false;
      } else {
        kind = "other";
        affectsWac = false;
      }

      out.push({
        time: op.time,
        hash: op.hash,
        kind,
        amount: inAmount,
        costUsd,
        pricePerUnit: inAmount > 0 ? costUsd / inAmount : 0,
        ...(counterpart && { counterpart }),
        ...(marketPriceAtOp != null && { marketPriceAtOp }),
        affectsWac,
        chain: op.chain,
      });
    }

    // ─── OUT events ──────────────────────────────────────────────
    if (outAmount > 0) {
      const otherStableIns = meaningfulOtherIns.filter((m) =>
        isStableSymbol(m.symbol),
      );
      const otherNonStableIns = meaningfulOtherIns.filter(
        (m) => !isStableSymbol(m.symbol),
      );

      let kind: PurchaseEventKind;
      let counterpart: PurchaseEvent["counterpart"] | undefined;

      if (op.type === "lp_add" || op.type === "lend_supply") {
        kind = "deploy";
      } else if (
        otherStableIns.length > 0 &&
        otherNonStableIns.length === 0
      ) {
        kind = "sell_to_stable";
        counterpart = {
          symbol: otherStableIns[0]!.symbol,
          amount: otherStableIns.reduce((s, m) => s + m.amount, 0),
        };
      } else if (otherNonStableIns.length > 0) {
        kind = "sell_to_token";
        counterpart = {
          symbol: otherNonStableIns[0]!.symbol,
          amount: otherNonStableIns.reduce((s, m) => s + m.amount, 0),
        };
      } else {
        kind = "transfer_out";
      }

      // Cost basis (informational): WAC × outAmount = "стоимость того что ушло".
      const wacAt = tracker.avgAt(target, op.time);
      const costUsd = wacAt != null && wacAt > 0 ? wacAt * outAmount : 0;

      out.push({
        time: op.time,
        hash: op.hash,
        kind,
        amount: -outAmount, // negative = расход
        costUsd,
        pricePerUnit: outAmount > 0 ? costUsd / outAmount : 0,
        ...(counterpart && { counterpart }),
        ...(marketPriceAtOp != null && { marketPriceAtOp }),
        affectsWac: false, // продажи / переводы НЕ меняют WAC в кумулятивном режиме
        chain: op.chain,
      });
    }
  }
  return out;
}

export interface WacSummary {
  /** Σ amount по purchase events (только affectsWac=true). */
  totalAmountBought: number;
  /** Σ cost USD по purchase events. */
  totalCostUsd: number;
  /** Weighted average cost per unit = totalCostUsd / totalAmountBought. */
  wac: number;
  /** Кол-во ивентов покупок. */
  purchasesCount: number;
  /** Кол-во ивентов продаж/переводов out. */
  sellsCount: number;
  /** Кол-во transfer_in (informational). */
  transfersInCount: number;
  /**
   * Текущий WAC из cost_basis_tracker (после всех событий) — это
   * authoritative source. Может отличаться от `wac` если были lp_remove
   * с inherited cost basis или другие edge cases.
   */
  currentTrackerWac: number | null;
}

export function summarizeWac(
  events: PurchaseEvent[],
  ops: ClassifiedOp[],
  targetSymbol: string,
  histPrices?: Map<string, number>,
): WacSummary {
  const purchases = events.filter((e) => e.affectsWac);
  const sells = events.filter(
    (e) =>
      e.kind === "sell_to_stable" ||
      e.kind === "sell_to_token" ||
      e.kind === "transfer_out" ||
      e.kind === "deploy",
  );
  const transfersIn = events.filter((e) => e.kind === "transfer_in");
  const totalAmountBought = purchases.reduce((s, e) => s + e.amount, 0);
  const totalCostUsd = purchases.reduce((s, e) => s + e.costUsd, 0);
  const tracker = buildCostBasisTracker(ops, histPrices ?? new Map());
  const target = normalizeSymbol(targetSymbol);
  return {
    totalAmountBought,
    totalCostUsd,
    wac: totalAmountBought > 0 ? totalCostUsd / totalAmountBought : 0,
    purchasesCount: purchases.length,
    sellsCount: sells.length,
    transfersInCount: transfersIn.length,
    currentTrackerWac: tracker.currentAvg(target),
  };
}
