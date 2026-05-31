/**
 * Override `startUsd` для позиций, у которых underlying tokens пришли
 * НЕ через on-chain покупку — а через withdrawal с CEX (по матчевому
 * tx-hash) или через `lp_unwind` от закрытой LP-позиции.
 *
 * Зачем это нужно
 * ────────────────
 * `applyLendingCostBasisOverride` работает поверх lot-tracker'а — он
 * знает только ON-CHAIN покупки текущего кошелька. Если WBTC пришло из
 * BingX (купил за USDT на бирже → вывел on-chain), у tracker'а нет ни
 * lot'а, ни WAC — он выдаёт `effectiveWac = 0` и lending override
 * скипается. В результате `startUsd` остаётся приближением (`amount ×
 * current_price` или прежний DeBank-fallback) и сильно искажает PnL.
 *
 * Этот override закрывает разрыв: берёт `cexCostBasisByHash` (server
 * посчитал WAC P2P → trades → withdrawal на бирже) + `lp_close_attribution`
 * events (cost basis унаследован от lp_add через tracker) и вычисляет
 * **blended WAC по ВСЕМ известным источникам**:
 *
 *   blendedWac = (direct.usd + cex.usd + lp.usd) / (direct.amt + cex.amt + lp.amt)
 *   newStartUsd_token = token.amount × blendedWac
 *   newStartUsd_position = Σ newStartUsd_token
 *
 * Когда применяется
 * ─────────────────
 *   - inheritance > 0 (есть cex.usd + lp.usd, иначе нечего добавлять)
 *   - direct buy < 95% покрытия позиции (иначе lending FIFO уже хорош)
 *   - |new - old| / old ≥ 0.5% (иначе noise — не шумим в warnings)
 *
 * Cascade
 * ───────
 *   1. V3 override (точный cost через Etherscan) ─┐
 *   2. Lending FIFO/LIFO override                 │ применяются ДО
 *   3. **CEX inheritance override (этот файл)**   ◄┘ нас
 *
 * Не перезаписываем supplyTokens которые не покрыты ни одним источником —
 * для них сохраняется prior `startUsd`. Это важно для multi-token LP
 * позиций (ETH+USDC): если ETH пришло с CEX, а USDC куплено on-chain,
 * override обновит только ETH-leg.
 */

import type { OpenPosition, OpenPositionToken } from "./open_positions.js";
import type { ClassifiedOp } from "./types.js";
import { getActualSuppliedTokens } from "./actual_supplied_tokens.js";
import {
  computePositionCoverage,
  type CexCostBasisMatch,
} from "./position_coverage.js";
import { getPurchaseHistory } from "./purchase_history.js";

/** Минимальное direct-buy покрытие, при котором мы НЕ вмешиваемся. */
const DIRECT_COVERAGE_SUFFICIENT = 0.95;
/** Порог изменения startUsd (relative) — ниже считается noise. */
const CHANGE_THRESHOLD = 0.005;

export interface CexInheritanceOverrideResult {
  readonly positions: OpenPosition[];
  readonly overriddenCount: number;
  readonly warnings: string[];
}

interface PerTokenResult {
  readonly symbol: string;
  readonly amount: number;
  /** Новый startUsd для этого токена (-1 если не обновляем). */
  readonly newStartUsd: number;
  readonly blendedWac: number;
  readonly cexUsd: number;
  readonly lpUsd: number;
}

export function applyCexInheritanceCostBasisOverride(
  positions: readonly OpenPosition[],
  opsByWallet: ReadonlyMap<string, readonly ClassifiedOp[]>,
  cexCostBasisByHash: ReadonlyMap<string, CexCostBasisMatch>,
  histPrices?: Map<string, number>,
): CexInheritanceOverrideResult {
  const result: OpenPosition[] = positions.slice();
  const warnings: string[] = [];
  let overriddenCount = 0;

  // Если у нас нет ни одного CEX-cost-basis-entry — нет смысла перебирать
  // позиции (lp_close_attribution считаются изнутри getPurchaseHistory и
  // НЕ зависят от cexCostBasisByHash, но текущая политика: модуль
  // активируется только когда есть хотя бы один CEX-источник; чистый
  // lp_unwind override — отдельная задача, имеет смысл если будет спрос).
  if (cexCostBasisByHash.size === 0) {
    return { positions: result, overriddenCount: 0, warnings };
  }

  for (let idx = 0; idx < result.length; idx++) {
    const p = result[idx]!;
    if (p.supplyTokens.length === 0) continue;
    const ops = opsByWallet.get(p.walletId);
    if (!ops || ops.length === 0) continue;

    // Реально задепонированные токены (для receipt-token позиций — GLV/aToken).
    const actualSupplied = getActualSuppliedTokens(
      [...ops],
      p.protocol.id,
      p.chain,
      p.supplyTokens.map((t) => t.symbol),
    );
    const tokensToProcess: { symbol: string; amount: number }[] =
      actualSupplied.length > 0
        ? actualSupplied.map((s) => ({ symbol: s.symbol, amount: s.netAmount }))
        : p.supplyTokens.map((t) => ({ symbol: t.symbol, amount: t.amount }));

    const perToken: PerTokenResult[] = [];
    let anyOverridden = false;

    for (const t of tokensToProcess) {
      const events = getPurchaseHistory([...ops], t.symbol, histPrices);
      const coverage = computePositionCoverage({
        totalAmount: t.amount,
        events,
        cexCostBasisByHash,
        targetSymbol: t.symbol,
      });

      // UCB C6: только cexInheritance.usd считается как inherited. lp_unwind
      // уже корректно учитывается LotTracker SoT через D5 bridge inheritance +
      // handleSwap (token→token cost basis propagation via consumed lot WAC).
      // Раньше lp_unwind double-counted: LotTracker уже инкорпорировал его,
      // а этот override снова добавлял через position_coverage's legacy
      // blended_wac mechanism → стомпал корректный lending result. Для
      // via.irk POS-002: override прыгал $32,307 → $33,930 на pure lp_unwind.
      const inheritedUsd = coverage.cexInheritance.usd;
      // Нет inheritance → нечего добавлять.
      if (inheritedUsd <= 0) {
        perToken.push({
          symbol: t.symbol,
          amount: t.amount,
          newStartUsd: -1,
          blendedWac: 0,
          cexUsd: 0,
          lpUsd: 0,
        });
        continue;
      }
      // Direct buy уже покрывает почти всё → lending FIFO дал отличный
      // startUsd, не вмешиваемся.
      const directShare =
        t.amount > 0 ? coverage.directBuy.amount / t.amount : 0;
      if (directShare >= DIRECT_COVERAGE_SUFFICIENT) {
        perToken.push({
          symbol: t.symbol,
          amount: t.amount,
          newStartUsd: -1,
          blendedWac: 0,
          cexUsd: 0,
          lpUsd: 0,
        });
        continue;
      }
      // UCB B7: startUsd = РЕАЛЬНЫЕ ТРАТЫ + extrapolation только на
      // непокрытую часть. Раньше: `blendedWac × t.amount` для всего
      // amount (даже covered) → давало extrapolation $19,407 на $14,723
      // реальных. Теперь honest:
      //   covered:    coverage.coveredUsd      (sum реальных $$)
      //   uncovered:  uncoveredAmount × blendedWac (best guess)
      const blendedWac =
        coverage.coveredAmount > 0
          ? coverage.coveredUsd / coverage.coveredAmount
          : 0;
      if (blendedWac <= 0) {
        perToken.push({
          symbol: t.symbol,
          amount: t.amount,
          newStartUsd: -1,
          blendedWac: 0,
          cexUsd: 0,
          lpUsd: 0,
        });
        continue;
      }
      const uncoveredAmount = Math.max(0, t.amount - coverage.coveredAmount);
      const usd = coverage.coveredUsd + uncoveredAmount * blendedWac;
      perToken.push({
        symbol: t.symbol,
        amount: t.amount,
        newStartUsd: usd,
        blendedWac,
        cexUsd: coverage.cexInheritance.usd,
        lpUsd: coverage.lpUnwind.usd,
      });
      anyOverridden = true;
    }

    if (!anyOverridden) continue;

    // Собираем новый position startUsd: для overridden tokens — новый,
    // для остальных — сохраняем prior `t.startUsd`. Receipt-token
    // decomposition: если actualSupplied != supplyTokens (e.g. GLV vs
    // WETH+USDC), pro-rata по currentUsd как делает lending override.
    const directMatchMap = new Map<string, PerTokenResult>();
    for (const r of perToken) {
      if (r.newStartUsd > 0) directMatchMap.set(r.symbol, r);
    }

    const totalCurrentUsd = p.supplyTokens.reduce(
      (s, t) => s + t.currentUsd,
      0,
    );
    // Если нашли directMatchMap по symbol — обновляем напрямую. Иначе
    // (receipt-token decomp: actualSupplied = GLV, supplyTokens = WETH+USDC)
    // pro-rata по currentUsd.
    const totalNewByDirect = [...directMatchMap.values()].reduce(
      (s, r) => s + r.newStartUsd,
      0,
    );
    const totalAmountByDirect = [...directMatchMap.values()].reduce(
      (s, r) => s + r.amount,
      0,
    );
    const blendedAvgWac =
      totalAmountByDirect > 0 ? totalNewByDirect / totalAmountByDirect : 0;

    let positionStartUsd = 0;
    const nextSupplyTokens: OpenPositionToken[] = p.supplyTokens.map((t) => {
      const direct = directMatchMap.get(t.symbol);
      if (direct) {
        positionStartUsd += direct.newStartUsd;
        return { ...t, startUsd: direct.newStartUsd };
      }
      // Receipt-token decomp fallback: если override прошёл для GLV
      // (actualSupplied), но supplyTokens = decomposed — pro-rata.
      const supplyTokenWasOverridden =
        actualSupplied.length > 0 &&
        directMatchMap.size > 0 &&
        // supplyTokens NOT among actualSupplied → это decomposed
        !actualSupplied.some((s) => s.symbol === t.symbol);
      if (supplyTokenWasOverridden && totalCurrentUsd > 0 && blendedAvgWac > 0) {
        // pro-rata от total override по currentUsd
        const proRata =
          totalNewByDirect * (t.currentUsd / totalCurrentUsd);
        positionStartUsd += proRata;
        return { ...t, startUsd: proRata };
      }
      // Token не покрыт — сохраняем prior startUsd.
      positionStartUsd += t.startUsd;
      return t;
    });

    const oldStartUsd = p.startUsd;
    // Noise floor: если разница меньше 0.5%, не перетираем (warning-spam).
    if (
      oldStartUsd > 0 &&
      Math.abs(positionStartUsd - oldStartUsd) / oldStartUsd < CHANGE_THRESHOLD
    ) {
      continue;
    }

    const next: OpenPosition = { ...p };
    next.startUsd = positionStartUsd;
    next.supplyTokens = nextSupplyTokens;
    // Recalc PnL. H6: PnL is collateral-side only (см. lending override).
    next.netPnlUsd = next.currentUsd - next.startUsd;
    next.netPnlPct =
      next.startUsd > 0 ? (next.netPnlUsd / next.startUsd) * 100 : 0;
    result[idx] = next;
    overriddenCount++;

    const overriddenTokens = perToken.filter((r) => r.newStartUsd > 0);
    warnings.push(
      `[CEX/LP inheritance] ${p.id} (${p.protocol.name}): ` +
        `$${oldStartUsd.toFixed(2)} → $${positionStartUsd.toFixed(2)} ` +
        `(${overriddenTokens
          .map(
            (t) =>
              `${t.amount.toFixed(6)} ${t.symbol} × $${t.blendedWac.toFixed(2)}` +
              (t.cexUsd > 0 ? ` cex=$${t.cexUsd.toFixed(0)}` : "") +
              (t.lpUsd > 0 ? ` lp=$${t.lpUsd.toFixed(0)}` : ""),
          )
          .join(" + ")})`,
    );
  }

  return { positions: result, overriddenCount, warnings };
}
