/**
 * Ручные метки «эта позиция куплена на кредитные».
 *
 * Хранятся в localStorage как `Record<positionKey, boolean>`. Если позиция
 * помечена вручную, её `creditFundedUsd` приравнивается к `currentUsd`
 * (полностью кредитная) — независимо от автоматического алгоритма.
 *
 * Ключ позиции стабильный: `${walletId}|${chain}|${protocolId}|${sortedSymbols}`.
 * Это позволяет менять название позиции / id (`POS-NNN`) между загрузками,
 * но переключатель остаётся.
 */

import { useLocalStorage } from "@/lib/useLocalStorage";

export type CreditOverrides = Record<string, boolean>;

const KEY = "capflow.credit_overrides";

export function positionCreditKey(args: {
  walletId: string;
  chain: string;
  protocolId: string;
  symbols: readonly string[];
  /**
   * Дискриминатор для inferred-позиций (несколько разных позиций с одинаковым
   * `(wallet, chain, protocolId, symbols)`). Передаём `openHash` исходного
   * lp_add — стабилен между перезагрузками. Для live — пусто.
   */
  instanceId?: string;
}): string {
  const sym = [...args.symbols].map((s) => s.toUpperCase()).sort().join("+");
  const base = `${args.walletId}|${args.chain}|${args.protocolId}|${sym}`;
  return args.instanceId ? `${base}|${args.instanceId}` : base;
}

export function useCreditOverrides() {
  return useLocalStorage<CreditOverrides>(KEY, {});
}
