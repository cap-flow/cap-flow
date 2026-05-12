/**
 * Средневзвешенная цена покупки актива по истории операций кошелька.
 *
 * Методика пользователя:
 *   - Берём все swap'ы, где
 *       OUT-движения содержат стейблкоины (USDC / USDT / DAI / USD₮0 / …),
 *       IN-движения содержат целевой токен (например, ETH или WETH).
 *   - totalStables += Σ amount стейблов из OUT
 *     totalAsset   += Σ amount целевого токена из IN
 *   - avgPrice = totalStables / totalAsset
 *
 * Это «реальная цена», по которой пользователь покупал актив за фиатные
 * стейблы — без зависимости от DeFiLlama / DeBank-цен.
 *
 * Покупки за **не-стейбл** (ETH ← BTC, ETH ← bridge_in, deposit_fiat без
 * стейбла) намеренно НЕ учитываются — пользователь хочет именно «сколько
 * фиата я потратил на актив». Если нужно учитывать и эти приходы — это
 * отдельная функция.
 */

import type { ClassifiedOp } from "./types";

function normalizeSymbol(s: string): string {
  const u = s.toUpperCase();
  if (u === "WETH") return "ETH";
  return u;
}

export interface WeightedAvg {
  /** totalStables / totalAsset — средняя цена в USD за единицу актива. */
  avgUsd: number;
  /** Σ полученного целевого токена. */
  totalAmount: number;
  /** Σ потраченных стейблов. */
  totalUsd: number;
  /** Кол-во swap'ов, попавших в подсчёт. */
  count: number;
}

export function weightedAvgPurchase(
  ops: ClassifiedOp[],
  symbol: string,
): WeightedAvg | null {
  const target = normalizeSymbol(symbol);
  let totalStables = 0;
  let totalAsset = 0;
  let count = 0;

  for (const op of ops) {
    if (op.status === "failed") continue;
    if (op.type !== "swap") continue;

    const targetIns = op.movement.filter(
      (m) =>
        m.direction === "in" &&
        normalizeSymbol(m.symbol) === target &&
        Number.isFinite(m.amount) &&
        m.amount > 0,
    );
    if (targetIns.length === 0) continue;

    const stableOuts = op.movement.filter(
      (m) =>
        m.direction === "out" &&
        m.isStable &&
        Number.isFinite(m.amount) &&
        m.amount > 0,
    );
    if (stableOuts.length === 0) continue;

    const stableSum = stableOuts.reduce((s, m) => s + m.amount, 0);
    const assetSum = targetIns.reduce((s, m) => s + m.amount, 0);

    totalStables += stableSum;
    totalAsset += assetSum;
    count++;
  }

  if (totalAsset <= 0) return null;
  return {
    avgUsd: totalStables / totalAsset,
    totalAmount: totalAsset,
    totalUsd: totalStables,
    count,
  };
}
