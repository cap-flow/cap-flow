/**
 * Ручные оверрайды для значений позиций — текущая стоимость и накопленные fees.
 *
 * Используются для inferred-позиций (нет live-источника, например Flash Trade
 * в Solana) и для коррекции автоматических расчётов когда пользователь видит
 * более точные данные на стороне протокола.
 *
 * Хранение — `localStorage`, ключ позиции стабильный:
 * `${walletId}|${chain}|${protocolId}|${sortedSymbols}` (тот же формат что в
 * `credit_overrides.ts`).
 */

import { useLocalStorage } from "@/lib/useLocalStorage";

export interface PositionOverride {
  /** Текущая USD-стоимость позиции (override). */
  currentValueUsd?: number;
  /** Накопленные pending fees в USD (override). */
  feesUsd?: number;
  /**
   * Скрыта вручную пользователем — не показывать в OpenPositions / на
   * дашборде. Применяется когда live API возвращает позицию с residual
   * dust, который автоматическая эвристика не отсекла, но пользователь
   * знает что позиция закрыта.
   */
  hidden?: boolean;
}

export type PositionOverrides = Record<string, PositionOverride>;

const KEY = "capflow.position_overrides";

export function positionOverrideKey(args: {
  walletId: string;
  chain: string;
  protocolId: string;
  symbols: readonly string[];
  /**
   * Дискриминатор — нужен когда у одного и того же
   * `(wallet, chain, protocolId, symbols)` несколько отдельных позиций:
   *   - inferred-позиции (несколько `lp_add` без парных `lp_remove`) — `openHash`
   *   - **V3 LP NFTs** в одном пуле (две позиции WETH/USDC в Uniswap V3 →
   *     один pool.id, разные NFT tokenId). Для них `instanceId` = NFT tokenId
   *     (если известен через Alchemy RPC) или хеш supply-amounts (fallback).
   *
   * Без `instanceId` POS-001 и POS-002 (две WETH/USDC NFT) ШАРЯТ один override:
   * пометил POS-001 как credit → POS-002 тоже становится credit (баг 2026-05-07).
   */
  instanceId?: string;
}): string {
  const sym = [...args.symbols].map((s) => s.toUpperCase()).sort().join("+");
  const base = `${args.walletId}|${args.chain}|${args.protocolId}|${sym}`;
  return args.instanceId ? `${base}|${args.instanceId}` : base;
}

// A0: `supplyAmountsHash` moved to `@cap-flow/ucb/supply_hash` (used by the
// engine's open_positions). Re-exported here so existing import sites are
// unchanged. Used in `positionOverrideKey({ instanceId: supplyAmountsHash(...) })`
// for V3 NFTs and other multi-market protocols sharing one `pool.id`.
export { supplyAmountsHash } from "@cap-flow/ucb/supply_hash";

export function usePositionOverrides() {
  return useLocalStorage<PositionOverrides>(KEY, {});
}
