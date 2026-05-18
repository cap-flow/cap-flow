/**
 * UCB Bob-test fix #4: untracked CEX withdrawal destinations detector.
 *
 * Surface scenarios where user withdrew crypto from CEX to an address
 * НЕ connected в Capflow — cost basis trail обрывается там. Hint user
 * подключить cold wallet чтобы follow дальше.
 *
 * Pure function. Caller fetches both inputs separately:
 *   - withdrawals: `CexRepository.listAllTransfersWithHashForUser` filtered to direction='withdrawal'
 *   - tracked hashes: chain_operations.tx_hash для всех user's wallets
 */

export interface WithdrawalRow {
  readonly txHash: string;
  readonly asset: string;
  readonly amount: number;
  readonly exchange: string;
  readonly executedAt: Date;
}

export function detectUntrackedDestinations(
  withdrawals: ReadonlyArray<WithdrawalRow>,
  trackedHashes: ReadonlySet<string>,
): WithdrawalRow[] {
  // Normalize tracked set to lowercase для consistent matching.
  const tracked = new Set<string>();
  for (const h of trackedHashes) {
    if (h) tracked.add(h.toLowerCase());
  }

  const out: WithdrawalRow[] = [];
  for (const w of withdrawals) {
    if (!w.txHash) continue;
    if (tracked.has(w.txHash.toLowerCase())) continue;
    out.push(w);
  }
  return out.sort(
    (a, b) => b.executedAt.getTime() - a.executedAt.getTime(),
  );
}
