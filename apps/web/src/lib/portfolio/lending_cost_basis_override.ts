/**
 * Override startUsd для lending позиций по WAC методологии:
 *
 *   newStartUsd = Σ (supply_token.amount × WAC_of_token)
 *
 * где `WAC_of_token` — наша средневзвешенная цена покупки этого токена
 * (из cost_basis_tracker — обновляется только true purchases:
 * swap_from_stable, swap_from_token, fiat_buy; transfer_in / sell — нет).
 *
 * Methodology configurable: FIFO (default), LIFO, WAC.
 */

import type { OpenPosition } from "./open_positions";
import type { ClassifiedOp } from "./types";
import { getPositionLotCostBasis } from "./position_lot_cost_basis";
import { getActualSuppliedTokens } from "./actual_supplied_tokens";
import type { LotMethodology } from "./lots/types";

export interface LendingOverrideResult {
  positions: OpenPosition[];
  overriddenCount: number;
  warnings: string[];
}

export function applyLendingCostBasisOverride(
  positions: readonly OpenPosition[],
  opsByWallet: Map<string, ClassifiedOp[]>,
  histPrices?: Map<string, number>,
  methodology: LotMethodology = "FIFO",
): LendingOverrideResult {
  const result: OpenPosition[] = positions.map((p) => p);
  const warnings: string[] = [];
  let overriddenCount = 0;

  for (let idx = 0; idx < result.length; idx++) {
    const p = result[idx]!;
    if (p.kind !== "lending") continue;
    if (p.supplyTokens.length === 0) continue;
    const ops = opsByWallet.get(p.walletId);
    if (!ops || ops.length === 0) continue;

    // Реально задепонированные токены (для receipt-token позиций — это
    // GLV/aToken/cToken, а не decomposed underlying WETH+USDC). Если их
    // нет — fallback на DeBank supplyTokens.
    const actualSupplied = getActualSuppliedTokens(
      ops,
      p.protocol.id,
      p.chain,
      p.supplyTokens.map((t) => t.symbol),
    );
    const tokensToProcess: { symbol: string; amount: number }[] =
      actualSupplied.length > 0
        ? actualSupplied.map((s) => ({ symbol: s.symbol, amount: s.netAmount }))
        : p.supplyTokens.map((t) => ({ symbol: t.symbol, amount: t.amount }));

    let wacBasedStartUsd = 0;
    let allTokensHaveData = true;
    const perTokenUsd: {
      symbol: string;
      amount: number;
      effectiveWac: number;
      usd: number;
      uncovered: number;
    }[] = [];
    for (const t of tokensToProcess) {
      const r = getPositionLotCostBasis({
        ops,
        walletId: p.walletId,
        protocolId: p.protocol.id,
        chain: p.chain,
        symbol: t.symbol,
        currentAmount: t.amount,
        ...(methodology && { methodology }),
        ...(histPrices && { histPrices }),
      });
      if (r.totalAmountSupplied <= 0 || r.totalCostUsd <= 0) {
        allTokensHaveData = false;
        break;
      }
      const wac = r.effectiveWac;
      const usd = t.amount * wac;
      wacBasedStartUsd += usd;
      perTokenUsd.push({
        symbol: t.symbol,
        amount: t.amount,
        effectiveWac: wac,
        usd,
        uncovered: r.uncoveredAmount,
      });
    }
    if (!allTokensHaveData || wacBasedStartUsd <= 0) continue;

    const oldStartUsd = p.startUsd;
    if (oldStartUsd > 0 && Math.abs(wacBasedStartUsd - oldStartUsd) / oldStartUsd < 0.005) {
      continue;
    }

    const next: OpenPosition = { ...p };
    next.startUsd = wacBasedStartUsd;
    // Если actualSupplied (e.g. GLV) совпадает с одним из supplyTokens
    // (e.g. WETH/USDC из decomposed) — обновляем startUsd. Иначе
    // pro-rata по currentUsd чтобы UI выглядел согласованно.
    const totalCurrentUsd = p.supplyTokens.reduce((s, t) => s + t.currentUsd, 0);
    next.supplyTokens = p.supplyTokens.map((t) => {
      const direct = perTokenUsd.find((x) => x.symbol === t.symbol);
      if (direct) return { ...t, startUsd: direct.usd };
      // Fallback pro-rata по currentUsd для receipt-token decomposition
      const proRata =
        totalCurrentUsd > 0
          ? wacBasedStartUsd * (t.currentUsd / totalCurrentUsd)
          : 0;
      return { ...t, startUsd: proRata };
    });
    next.netPnlUsd = next.currentUsd - next.startUsd - next.currentDebtUsd;
    next.netPnlPct =
      next.startUsd > 0 ? (next.netPnlUsd / next.startUsd) * 100 : 0;
    result[idx] = next;
    overriddenCount++;

    warnings.push(
      `[Lending ${methodology} override] ${p.id} (${p.protocol.name}): ` +
        `$${oldStartUsd.toFixed(2)} → $${wacBasedStartUsd.toFixed(2)} ` +
        `(${perTokenUsd
          .map(
            (t) =>
              `${t.amount.toFixed(4)} ${t.symbol} × $${t.effectiveWac.toFixed(2)}`,
          )
          .join(" + ")})`,
    );
  }

  return { positions: result, overriddenCount, warnings };
}
