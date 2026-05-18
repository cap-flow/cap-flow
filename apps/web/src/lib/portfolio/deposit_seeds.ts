/**
 * UCB C1 S5: client-side deposit-seed extraction.
 *
 * Берёт sorted ops + filled LotTracker + set известных CEX-deposit
 * tx hashes (server возвращает их через `transfers-with-hash` route),
 * формирует `{ txHash, chain, costBasisUsd }` для каждой
 * `transfer_out` / `bridge_out` чей hash совпал.
 *
 * Cost basis logic: `wacAt(walletId, symbol, op.time)` × movement.amount.
 * Если WAC null или 0 (нет prior lots) — seed = $0 (explicit zero).
 *
 * Multi-token tx → суммируем cost по всем out-movements в один seed.
 */
import { buildLotTrackerFromOps } from "./lots/build";
import type { LotTracker } from "./lots/lot_tracker";
import type { ClassifiedOp } from "./types";

/** Что отправляем server-у в `POST /v1/cex/deposit-seeds`. */
export interface DepositSeedInput {
  readonly txHash: string;
  readonly chain: string;
  readonly costBasisUsd: number;
  /** UI provenance — какой wallet был source. */
  readonly walletId: string | null;
  readonly note: string | null;
}

/**
 * Eligible op types для seed-generation. transfer_out + bridge_out —
 * единственные направления "out of user's on-chain wallet". Bridges
 * formally стоят между wallet'ами user'а, но если client (после A1/A2
 * matcher'а) уверен что bridge_out пошёл на CEX hop — тоже seed.
 *
 * NOT eligible: withdraw_fiat (это продажа), transfer_out на собственный
 * wallet (handled через A1 internal pairs).
 */
const SEED_ELIGIBLE_TYPES = new Set(["transfer_out", "bridge_out"]);

/**
 * Принимает либо `lotTracker` (для backward compat / тестов которые
 * хотят явный контроль), либо ops-only — тогда строит fresh per-seed
 * tracker внутренне. Важно: внутренний tracker строится **инкрементно**,
 * snapshot'ит WAC ДО консумирования transfer_out, чтобы получить
 * правильную cost basis (иначе `wacAt(time)` возвращает 0 после того
 * как handleTransferOut уже истратил весь lot).
 *
 * Argument `lotTracker` deprecated в этой версии — оставлен в signature
 * для совместимости вызовов, фактически игнорируется.
 */
export function computeDepositSeedsFromOps(
  ops: readonly ClassifiedOp[],
  walletId: string,
  chain: string,
  _lotTracker: LotTracker | null,
  cexDepositHashes: ReadonlySet<string>,
): DepositSeedInput[] {
  if (cexDepositHashes.size === 0) return [];

  // Сортируем по времени для инкрементного pass'а.
  const sorted = [...ops].sort((a, b) => a.time - b.time);
  const eligibleHashes = new Set<string>();
  const opByHash = new Map<string, ClassifiedOp>();
  for (const op of sorted) {
    if (op.status === "failed") continue;
    if (!SEED_ELIGIBLE_TYPES.has(op.type)) continue;
    const hashLower = op.hash.toLowerCase();
    if (cexDepositHashes.has(hashLower)) {
      eligibleHashes.add(op.hash);
      opByHash.set(op.hash, op);
    }
  }
  if (eligibleHashes.size === 0) return [];

  // Build incrementally: для каждой eligible op строим tracker до
  // (но не включая) её — затем читаем wacAt(time) — это дает WAC
  // ровно перед consume. O(n × M) где M = число seed ops. Для типичных
  // M < 50 и n < 5000 — manageable (~250k op-walks).
  //
  // Для маленьких wallets faster path: один tracker через все ops,
  // но это даст 0 (см. test failure). Поэтому всегда incremental.
  const out: DepositSeedInput[] = [];
  for (const op of sorted) {
    if (!eligibleHashes.has(op.hash)) continue;

    // Build tracker через все ops ДО `op` (exclusive по time, но в
    // случае same-time — exclusive по seq).
    const priorOps = sorted.filter((o) => {
      if (o.time < op.time) return true;
      if (o.time === op.time && o.seq < op.seq) return true;
      return false;
    });
    const tracker = buildLotTrackerFromOps(priorOps, { walletId });

    let totalCostUsd = 0;
    for (const m of op.movement) {
      if (m.direction !== "out" || m.amount <= 0) continue;
      const wac = tracker.wacAt(walletId, m.symbol, op.time);
      if (wac != null && wac > 0) {
        totalCostUsd += wac * m.amount;
      }
    }

    out.push({
      txHash: op.hash.toLowerCase(),
      chain,
      costBasisUsd: Math.max(0, totalCostUsd),
      walletId,
      note: null,
    });
  }
  return out;
}
