/**
 * Stage 2 cost basis для non-LP позиций — по правилу OUT-side:
 * startUsd = стоимость ПОТРАЧЕННОГО при открытии (underlying tokens OUT),
 * НЕ оценка receipt-токена.
 *
 * Пример (verified): IPOR — отдал 100 USDC → получил 91.3 ipsrUSDfusion →
 * startUsd = $100 (не текущие $104 у receipt'а). GMX — отдал 1000 USDC →
 * получил 875 GM → startUsd = $1000.
 *
 * Stage 2a (этот файл): только OUT-side в СТЕЙБЛАХ → startUsd = Σ × $1.
 * Точно и без historical-price API. Покрывает большинство non-LP депозитов
 * (lending USDC, yield-вклады, IPOR, Avantis, LAGOON, Extra Finance).
 * Volatile OUT (ETH/BTC vaults) — Stage 2b через DefiLlama historical.
 */

export interface OpenedInToken {
  /** Token contract address (lowercase). */
  address: string;
  symbol: string;
  /** Human-units amount (decimal-shifted). */
  amount: number;
}

/**
 * Известные USD-стейблы (по symbol, case-insensitive). Для них historical
 * price ≈ $1 в любой момент → startUsd = amount без обращения к price API.
 * EUR-стейблы НЕ включаем (их курс ≠ $1, нужен DefiLlama — Stage 2b).
 */
const USD_STABLES = new Set([
  "USDC",
  "USDC.E",
  "USDBC",
  "USDT",
  "USD₮0",
  "USDT0",
  "USD0",
  "DAI",
  "FRAX",
  "LUSD",
  "GUSD",
  "USDP",
  "TUSD",
  "USDD",
  "USDE",
  "SUSDE",
  "RUSD",
  "SRUSD",
  "CRVUSD",
  "GHO",
  "DOLA",
  "MIM",
  "ALUSD",
  "BUSD",
  "FDUSD",
  "PYUSD",
  "USDX",
]);

export function isUsdStable(symbol: string): boolean {
  return USD_STABLES.has(symbol.toUpperCase().trim());
}

/**
 * startUsd из OUT-side если ВСЕ потраченные токены — USD-стейблы.
 * Возвращает null если есть non-stable OUT (тогда нужен Stage 2b / fallback)
 * или OUT пустой.
 *
 * Почему "все должны быть стейблами": если депозит был USDC + ETH, то ETH
 * нужно оценить historical (Stage 2b). Частичная оценка (только стейбл-часть)
 * занизит startUsd. Лучше отдать null и оставить fallback, чем врать.
 */
export function startUsdFromStableOut(
  openedInTokens: readonly OpenedInToken[],
): number | null {
  if (openedInTokens.length === 0) return null;
  let sum = 0;
  for (const t of openedInTokens) {
    if (!isUsdStable(t.symbol)) return null; // non-stable → bail to Stage 2b
    sum += t.amount;
  }
  return sum > 0 ? sum : null;
}
