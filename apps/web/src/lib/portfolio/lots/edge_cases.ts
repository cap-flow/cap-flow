/**
 * Edge cases для cost basis.
 *
 * 1. **Airdrops** — `transfer_in` от известных airdrop-токенов с
 *    cost = $0 (по умолчанию) или market price (опция в Settings).
 * 2. **Rebases** (stETH, AMPL, OHM) — supply changes без on-chain transfer.
 *    Snapshot-diff между балансами в разные моменты.
 * 3. **Token migrations** (LEND → AAVE 1:100) — таблица миграций,
 *    лоты перемещаются с пересчётом amount × ratio.
 * 4. **Stablecoin depegs** — swap по non-$1 цене → realized PnL на разнице.
 */

import type { LotTracker } from "./lot_tracker";

/** Известные миграции токенов. */
export interface TokenMigration {
  fromSymbol: string;
  fromTokenId: string; // contract address (lowercase)
  toSymbol: string;
  toTokenId: string;
  /** new_amount = old_amount × ratio. */
  ratio: number;
  /** Дата миграции (unix sec). После этой даты `from` становится недействительным. */
  migrationTime: number;
  chain: string;
}

const KNOWN_MIGRATIONS: readonly TokenMigration[] = [
  // LEND → AAVE: 100:1 swap (Aug 2020). Не должно встречаться на новых
  // кошельках, но для full coverage храним.
  {
    fromSymbol: "LEND",
    fromTokenId: "0x80fb784b7ed66730e8b1dbd9820afd29931aab03",
    toSymbol: "AAVE",
    toTokenId: "0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9",
    ratio: 0.01, // 100 LEND → 1 AAVE
    migrationTime: 1602115200, // Oct 2020
    chain: "eth",
  },
  // Дополнить по мере появления migration-кейсов.
];

/**
 * Применить migration к LotTracker'у. Все лоты `from`-токена с amount > 0
 * на момент `migrationTime` конвертируются в лоты `to`-токена.
 */
export function applyTokenMigration(
  lots: LotTracker,
  walletId: string,
  migration: TokenMigration,
): { migrated: number; totalAmount: number } {
  const fromLots = lots.getLots(walletId, migration.fromSymbol);
  let migrated = 0;
  let totalAmount = 0;
  for (const lot of fromLots) {
    if (lot.amount <= 0) continue;
    if (lot.acquiredAt > migration.migrationTime) continue;
    if (
      lot.tokenId &&
      lot.tokenId.toLowerCase() !== migration.fromTokenId.toLowerCase()
    )
      continue;
    const newAmount = lot.amount * migration.ratio;
    const newCostPerUnit = lot.costPerUnitUsd / migration.ratio;
    // Consume старого лота полностью.
    lots.consume({
      symbol: migration.fromSymbol,
      tokenId: lot.tokenId,
      chain: migration.chain,
      amount: lot.amount,
      consumedAt: migration.migrationTime,
      walletId,
    });
    // Создать новый лот.
    lots.acquire({
      symbol: migration.toSymbol,
      tokenId: migration.toTokenId,
      chain: migration.chain,
      amount: newAmount,
      costPerUnitUsd: newCostPerUnit,
      acquiredAt: migration.migrationTime,
      acquiredVia: "transfer_in",
      sourceHash: `migration:${migration.fromSymbol}:${migration.toSymbol}`,
      walletId,
    });
    migrated++;
    totalAmount += newAmount;
  }
  return { migrated, totalAmount };
}

/**
 * Применить ВСЕ известные миграции к трекеру.
 */
export function applyAllKnownMigrations(
  lots: LotTracker,
  walletId: string,
): void {
  for (const migration of KNOWN_MIGRATIONS) {
    applyTokenMigration(lots, walletId, migration);
  }
}

/**
 * **Rebase tokens** — protocol balance changes без emit'а Transfer event.
 *
 * Для stETH/wstETH/cToken/aToken/AMPL/OHM/etc. — баланс пользователя
 * растёт не через transfer, а через index update в контракте. DeBank
 * не отдаёт это как op, поэтому если просто суммировать transfers получится
 * меньше чем live balance.
 *
 * Стратегия: для известных rebase-токенов делаем snapshot diff:
 *   live.amount - sum(net_transfers) = accrued_yield
 *
 * Этот yield добавляется как synthetic `claim_rewards` lot в LotTracker
 * с cost = 0 (не было покупки, это yield).
 */
export const REBASE_TOKENS = new Set<string>([
  "STETH",
  "WSTETH",
  "AETH",
  "AETHB",
  "AAVE-WETH",
  "AAVE-USDC",
  "RETH",
  "EETH",
  "WEETH",
  "EZETH",
  "RSETH",
  "AMPL",
  "OHM",
  "GOHM",
]);

/**
 * Применить rebase-yield для токена в (walletId, symbol):
 * вычисляет diff между live amount и tracker amount, добавляет synthetic lot.
 */
export function applyRebaseYield(
  lots: LotTracker,
  walletId: string,
  symbol: string,
  liveAmount: number,
  asOfTime: number,
  chain: string,
  tokenId: string,
): number {
  const trackerAmount = lots.currentAmount(walletId, symbol);
  const diff = liveAmount - trackerAmount;
  if (diff <= 0) return 0; // не растёт или уменьшился (rebase down)
  // UCB D6: rebase yield = reward с cost basis $0.
  // FMV нам не известен без spot price → не заполняем
  // fmvAtAcquisitionUsd (best-effort: rebase aggregator может позже).
  lots.acquire({
    symbol,
    tokenId,
    chain,
    amount: diff,
    costPerUnitUsd: 0,
    acquiredAt: asOfTime,
    acquiredVia: "received_as_reward",
    sourceHash: `rebase:${symbol}:${asOfTime}`,
    walletId,
  });
  return diff;
}
