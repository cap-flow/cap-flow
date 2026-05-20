/**
 * Position cost-basis aggregator.
 *
 * Берёт `PurchaseEvent[]` для одного targetSymbol + карту CEX-withdrawal
 * cost-basis (по tx-hash) → раскладывает покрытие позиции на 4 bucket'а:
 *
 *  1. **directBuy** — `affectsWac=true` события (swap_from_stable /
 *     swap_from_token / fiat_buy). Cost basis вычислен через
 *     `cost_basis_tracker.ts` или прямо из stable-out USD.
 *  2. **cexInheritance** — `transfer_in` события, у которых tx-hash
 *     совпадает с CEX-withdrawal-ом текущего пользователя, и asset биржи
 *     совпадает с targetSymbol (с WETH↔ETH normalization). Cost basis
 *     вычислен в `CexCostBasisService.computeForUser()` через WAC-пул
 *     P2P → trades → withdrawals.
 *  3. **lpUnwind** — `lp_close_attribution` события (lp_remove с
 *     inherited cost basis от lp_add через tracker).
 *  4. **unknown** — остальные `transfer_in`-ивенты без атрибуции (внутренние
 *     переводы между нашими кошельками без CEX-следа, airdrops, …).
 *
 * Результат — `coveragePct` от 0 до 100, `wac` (USD/unit) по покрытой
 * части, и breakdown для отображения в UI карточки позиции.
 *
 * **Что НЕ делает:**
 *   - Не вычитает sells / transfer_out / deploy — это purchase-side агрегатор.
 *     Если нужен текущий cost basis для оставшегося amount после продаж —
 *     это работа `cost_basis_tracker.ts` (он уже умеет).
 *   - Не нормализует USDC.e ↔ USDC ↔ USDC.b и тому подобное. Стейблы и
 *     так не должны попадать сюда (lending позиции в стейблах cost basis-ом
 *     не нуждаются — он $1).
 */

import type { PurchaseEvent } from "./purchase_history";
import { canonicalSymbol as normalizeSymbol } from "./wrapped_symbols";

/**
 * Расширенный PurchaseEvent с пометкой источника cost basis — для
 * отображения в popup'е истории покупок. CEX-обогащённые ивенты несут
 * server-side WAC, а не нулевой costUsd как в исходном PurchaseEvent.
 */
export interface EnrichedPurchaseEvent extends PurchaseEvent {
  /**
   * Откуда взялся cost basis в этом ивенте.
   * - 'direct'  — on-chain покупка (swap_from_stable / swap_from_token / fiat_buy)
   * - 'cex'     — transfer_in matched к CEX-withdrawal, cost из биржевого WAC-пула
   * - 'lp'      — lp_close_attribution, cost унаследован от lp_add через tracker
   * - 'unknown' — transfer_in без атрибуции (показывается только в debug-режиме)
   */
  readonly costSource: "direct" | "cex" | "lp" | "unknown";
  /**
   * Только для costSource='cex': пометка точности атрибуции с биржи
   * ("fiat-direct" / "fiat-stable" / "inherited" / "unknown"). Нужна для
   * UI-tooltip'а — позволяет отличить "точную" цифру (был фиат-leg в
   * P2P) от приближённой (cost унаследован через chain trade'ов).
   */
  readonly inheritanceSource?: string;
}

export interface EnrichOptions {
  /**
   * Если `true` — `transfer_in` ивенты без CEX-match'а возвращаются с
   * `costSource: 'unknown'` и `costUsd=0` (вместо отбрасывания).
   * Используется для **debug-режима в popup'е** чтобы пользователь видел
   * сами hash'и непокрытых переводов и понимал почему cost-basis-coverage
   * низкое (например ожидаемого CEX-withdrawal'а нет, потому что биржа
   * не подключена).
   *
   * Out-events (sells / transfer_out / deploy) всё равно отбрасываются —
   * их роль чисто негативная для cost basis.
   */
  readonly includeUnmatched?: boolean;
}

export interface CexCostBasisMatch {
  /** Cost basis в USD, посчитанный сервером через WAC-пул на бирже. */
  readonly costBasisUsd: number;
  /**
   * Точность атрибуции — нужна для UI-tooltip ("из фиата", "унаследовано").
   * Строкой (не union) чтобы Map с RegistryPage передавалась без cast.
   */
  readonly source: string;
  /** Asset который CEX отдавал (для guard против ложных matches). */
  readonly asset: string;
}

export interface CoverageBreakdown {
  /** Total position amount, на который мы пытаемся натянуть cost basis. */
  readonly totalAmount: number;
  readonly directBuy: {
    readonly amount: number;
    readonly usd: number;
    readonly count: number;
  };
  readonly cexInheritance: {
    readonly amount: number;
    readonly usd: number;
    readonly matchedHashes: readonly string[];
  };
  readonly lpUnwind: {
    readonly amount: number;
    readonly usd: number;
    readonly count: number;
  };
  readonly unknown: {
    readonly amount: number;
    readonly count: number;
  };
  /** Σ(direct + cex + lp).amount */
  readonly coveredAmount: number;
  /** Σ(direct + cex + lp).usd */
  readonly coveredUsd: number;
  /** clamp(coveredAmount / totalAmount × 100, 0, 100). */
  readonly coveragePct: number;
  /** coveredUsd / coveredAmount (0 если ничего не покрыто). */
  readonly wac: number;
}

export interface ComputePositionCoverageInput {
  readonly totalAmount: number;
  readonly events: readonly PurchaseEvent[];
  readonly cexCostBasisByHash: ReadonlyMap<string, CexCostBasisMatch>;
  readonly targetSymbol: string;
}

/**
 * UCB D4 client mirror: `normalizeSymbol` использует общий wrapped-token
 * map (`canonicalSymbol`), чтобы withdrawal `WBTC` мог быть сопоставлен
 * с on-chain `transfer_in` `BTC` (и наоборот). НЕ переиспользуется
 * функция из purchase_history/lot_tracker — там нормализация WETH→ETH
 * применима к on-chain группировке lot'ов; расширение map'ой может
 * изменить tracking. Поэтому помимо `normalizeSymbol` используем только
 * для CEX↔on-chain matching по symbol'у в `computePositionCoverage`.
 */

export function computePositionCoverage(
  input: ComputePositionCoverageInput,
): CoverageBreakdown {
  const target = normalizeSymbol(input.targetSymbol);

  let directAmount = 0;
  let directUsd = 0;
  let directCount = 0;

  let cexAmount = 0;
  let cexUsd = 0;
  const cexHashes: string[] = [];

  let lpAmount = 0;
  let lpUsd = 0;
  let lpCount = 0;

  let unknownAmount = 0;
  let unknownCount = 0;

  for (const e of input.events) {
    // 1. Direct buy: affectsWac=true И кинд именно покупочный (не
    //    lp_close_attribution, у которого affectsWac=false по дефолту).
    if (
      e.affectsWac &&
      (e.kind === "swap_from_stable" ||
        e.kind === "swap_from_token" ||
        e.kind === "fiat_buy")
    ) {
      directAmount += e.amount;
      directUsd += e.costUsd;
      directCount += 1;
      continue;
    }

    // 2. LP unwind: lp_close_attribution с непустым costUsd.
    if (e.kind === "lp_close_attribution") {
      if (e.costUsd > 0) {
        lpAmount += e.amount;
        lpUsd += e.costUsd;
        lpCount += 1;
      }
      // Если cost=0 — tracker не знал WAC, не атрибутируем (но и в
      // unknown не складываем, т.к. это уже атрибуция-попытка).
      continue;
    }

    // 3. Transfer-in: пытаемся match'нуть в CEX-карту.
    if (e.kind === "transfer_in" && e.amount > 0) {
      const match = input.cexCostBasisByHash.get(e.hash.toLowerCase());
      const assetMatches =
        !!match && normalizeSymbol(match.asset) === target;
      if (match && assetMatches && match.costBasisUsd > 0) {
        cexAmount += e.amount;
        cexUsd += match.costBasisUsd;
        cexHashes.push(e.hash.toLowerCase());
      } else {
        unknownAmount += e.amount;
        unknownCount += 1;
      }
      continue;
    }

    // Всё остальное (sells, transfer_out, deploy, other) — НЕ покрытие,
    // игнорируем.
  }

  const coveredAmount = directAmount + cexAmount + lpAmount;
  const coveredUsd = directUsd + cexUsd + lpUsd;
  const rawPct =
    input.totalAmount > 0 ? (coveredAmount / input.totalAmount) * 100 : 0;
  const coveragePct = Math.min(100, Math.max(0, rawPct));
  const wac = coveredAmount > 0 ? coveredUsd / coveredAmount : 0;

  return {
    totalAmount: input.totalAmount,
    directBuy: { amount: directAmount, usd: directUsd, count: directCount },
    cexInheritance: {
      amount: cexAmount,
      usd: cexUsd,
      matchedHashes: cexHashes,
    },
    lpUnwind: { amount: lpAmount, usd: lpUsd, count: lpCount },
    unknown: { amount: unknownAmount, count: unknownCount },
    coveredAmount,
    coveredUsd,
    coveragePct,
    wac,
  };
}

/**
 * Возвращает только те ивенты, которые реально вносят вклад в cost basis
 * позиции — для отображения в popup'е «История покупок underlying».
 *
 * **Разница с `events.filter(e => e.affectsWac)`** (как было раньше):
 *   - Включает `transfer_in` events, у которых tx-hash совпадает с
 *     CEX-withdrawal — server-side cost basis из P2P→trade→withdrawal
 *     пула подмешивается в `costUsd` / `pricePerUnit`. Помечается
 *     `costSource: "cex"`.
 *   - Включает `lp_close_attribution` с непустым costUsd (унаследованный
 *     cost от lp_add через tracker). Помечается `costSource: "lp"`.
 *   - Исходные direct buys (swap_from_stable / swap_from_token / fiat_buy)
 *     помечаются `costSource: "direct"`.
 *
 * Порядок сохраняется как во входном массиве (обычно по времени
 * благодаря getPurchaseHistory).
 */
export function enrichPurchaseEventsForCoverage(
  events: readonly PurchaseEvent[],
  cexCostBasisByHash: ReadonlyMap<string, CexCostBasisMatch>,
  targetSymbol: string,
  options?: EnrichOptions,
): EnrichedPurchaseEvent[] {
  const target = normalizeSymbol(targetSymbol);
  const includeUnmatched = options?.includeUnmatched === true;
  const out: EnrichedPurchaseEvent[] = [];
  for (const e of events) {
    // Direct buy.
    if (
      e.affectsWac &&
      (e.kind === "swap_from_stable" ||
        e.kind === "swap_from_token" ||
        e.kind === "fiat_buy")
    ) {
      out.push({ ...e, costSource: "direct" });
      continue;
    }
    // LP-unwind inherited cost.
    if (e.kind === "lp_close_attribution" && e.costUsd > 0) {
      out.push({ ...e, costSource: "lp" });
      continue;
    }
    // CEX-inherited cost: matched transfer_in.
    if (e.kind === "transfer_in" && e.amount > 0) {
      const match = cexCostBasisByHash.get(e.hash.toLowerCase());
      if (match && normalizeSymbol(match.asset) === target) {
        // Hash+asset match найден — это точно withdrawal с биржи.
        // costBasisUsd может быть 0 (server-side WAC-пул пустой, типично
        // когда у API-key нет permission на trade history); всё равно
        // показываем как 'cex' с пометкой `inheritanceSource`, чтобы
        // пользователь понимал что transfer — с биржи, и cost basis надо
        // достроить (sync trades / отметить P2P / manual annotation).
        const usd = match.costBasisUsd > 0 ? match.costBasisUsd : 0;
        out.push({
          ...e,
          costUsd: usd,
          pricePerUnit: e.amount > 0 && usd > 0 ? usd / e.amount : 0,
          costSource: "cex",
          inheritanceSource: match.source,
        });
        continue;
      }
      // Unmatched transfer_in (нет CEX-следа вообще, или asset-mismatch):
      // либо drop (default), либо включить с costSource='unknown' и
      // costUsd=0 для UI-дебага.
      if (includeUnmatched) {
        out.push({
          ...e,
          costUsd: 0,
          pricePerUnit: 0,
          costSource: "unknown",
        });
      }
      continue;
    }
    // Sells / transfer_out / deploy / other — не покрытие, отбрасываем.
  }
  return out;
}
