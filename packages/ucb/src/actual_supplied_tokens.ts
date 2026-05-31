/**
 * Определяет реально задепонированные токены для lending позиции через
 * анализ ops истории.
 *
 * **Зачем**: DeBank возвращает supply_token_list декомпозированно для
 * receipt-tokens. Например, если в Morpho лежит GLV [WETH-USDC],
 * supply_token_list покажет `3.8 WETH + 8.8k USDC` (декомпозиция),
 * хотя реально user задепонировал GLV (basket-token).
 *
 * Для cost basis нужно отслеживать **реальный задепонированный токен**
 * (GLV в этом примере), потому что его cost basis формируется через цепочку
 * GMX V2 lp_add (where USDC+ETH → GLV).
 *
 * Алгоритм:
 *   1. Найти все ops протокола+chain'а
 *   2. lend_supply / lp_add: out non-stable non-gas → суммируем как
 *      «supplied»
 *   3. lend_withdraw / lp_remove: in non-stable non-gas → вычитаем
 *   4. Net amount > 0 = реально лежит в позиции
 */

import type { ClassifiedOp, TokenMovement } from "./types.js";
import { isStableSymbol } from "./protocols.js";

function isGas(m: TokenMovement): boolean {
  if (m.symbol !== "ETH" && m.symbol !== "WETH") return false;
  return m.amount < 0.01 && (m.usd ?? 0) < 100;
}

export interface SuppliedTokenInfo {
  symbol: string;
  tokenId: string;
  /** Net amount currently in position (supplied - withdrawn). */
  netAmount: number;
  /** Это receipt-token (GLV/aToken/cToken)? */
  isReceiptToken: boolean;
}

/**
 * Возвращает реально задепонированные токены для позиции (по ops).
 *
 * Для receipt-token позиций (Morpho c GLV, Aave c aToken collateral)
 * вернёт сам receipt вместо underlying decomposition.
 *
 * `positionSupplySymbols` — текущие supply tokens позиции (decomposed
 * underlying от DeBank). Используется для фильтрации: если в Morpho/Aave
 * есть несколько разных markets (одна с GLV, другая с WBTC), нужно
 * выбрать только те ops которые относятся к ЭТОЙ конкретной позиции.
 *
 * Match heuristic:
 *   - Plain token (не receipt): symbol совпадает с одним из supply tokens
 *   - Receipt token: содержит ХОТЯ БЫ ОДИН из supply token symbols в имени
 *     (например "GLV [WETH-USDC]" содержит "WETH" → match для позиции с
 *     WETH+USDC supply).
 */
export function getActualSuppliedTokens(
  ops: ClassifiedOp[],
  protocolId: string,
  chain: string,
  positionSupplySymbols?: readonly string[],
): SuppliedTokenInfo[] {
  // Map symbol → aggregated info
  const supplied = new Map<string, SuppliedTokenInfo>();

  for (const op of ops) {
    if (op.status !== "ok") continue;
    if (op.protocol?.id !== protocolId) continue;
    if (op.chain !== chain) continue;

    if (op.type === "lp_add" || op.type === "lend_supply") {
      for (const m of op.movement) {
        if (m.direction !== "out" || m.amount <= 0) continue;
        if (isStableSymbol(m.symbol)) continue;
        if (isGas(m)) continue;
        const cur = supplied.get(m.symbol) ?? {
          symbol: m.symbol,
          tokenId: m.tokenId,
          netAmount: 0,
          isReceiptToken: m.isProtocolToken,
        };
        cur.netAmount += m.amount;
        supplied.set(m.symbol, cur);
      }
    } else if (op.type === "lp_remove" || op.type === "lend_withdraw" || op.type === "unstake") {
      for (const m of op.movement) {
        if (m.direction !== "in" || m.amount <= 0) continue;
        if (isStableSymbol(m.symbol)) continue;
        if (isGas(m)) continue;
        const cur = supplied.get(m.symbol);
        if (cur) cur.netAmount -= m.amount;
      }
    }
  }

  let result = [...supplied.values()].filter((v) => v.netAmount > 1e-9);

  // Фильтр: оставляем только токены которые относятся к ЭТОЙ конкретной
  // позиции (не к другим markets того же протокола).
  if (positionSupplySymbols && positionSupplySymbols.length > 0) {
    const supplySet = new Set(
      positionSupplySymbols.map((s) => s.toUpperCase()),
    );
    result = result.filter((v) => {
      const sym = v.symbol.toUpperCase();
      // Plain token: symbol совпадает с supply
      if (supplySet.has(sym)) return true;
      // Receipt-token: имя содержит хотя бы один из supply symbols
      if (v.isReceiptToken) {
        for (const s of supplySet) {
          if (sym.includes(s)) return true;
        }
      }
      return false;
    });
  }

  return result;
}
