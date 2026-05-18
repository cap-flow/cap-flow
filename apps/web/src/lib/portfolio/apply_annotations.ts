/**
 * UCB A4: apply server-side annotations to ClassifiedOp[] before the
 * cost-basis pipeline.
 *
 * Текущая реализация — minimal but сильно полезная:
 *   - `manualOpType` → переписывает `op.type`, что меняет которая handler
 *     fired в `buildLotTrackerFromOps` (swap → bridge_in, например).
 *     Это самый частый need: классификатор не понял природу tx.
 *
 * НЕ применяется (намеренно отложено в A4.2):
 *   - `manualCostBasisUsd` — требует прокинуть отдельный hint через
 *     handlers (handleTransferIn / handleBridgeIn) чтобы вместо derived
 *     histPrice использовался override. Скоуп больше.
 *   - `isInternalTransfer` — уже применяется выше в `internalHashes`
 *     (не нужно дублировать здесь).
 *
 * Возвращает НОВЫЙ массив (не мутирует input). Шейп ClassifiedOp[]
 * сохраняется — downstream code не подозревает об overrides.
 */

import type { ClassifiedOp, OpType } from "./types";
import type { ResolvedAnnotation } from "@/features/chain-ops/api";

// Server позволяет лишь whitelisted op_type — это subset нашего OpType
// (`failed` / `gas_topup` / `perp_*` не в server-allowed list). Safe cast.
const OP_TYPE_WHITELIST = new Set<string>([
  "transfer_in",
  "transfer_out",
  "bridge_in",
  "bridge_out",
  "deposit_fiat",
  "withdraw_fiat",
  "swap",
  "lend_supply",
  "lend_withdraw",
  "borrow",
  "repay",
  "lp_add",
  "lp_remove",
  "claim_rewards",
  "approve",
  "unknown",
]);

/**
 * Берёт ops одного wallet'а + annotations того же user'а (resolved через
 * composite key) и возвращает преобразованную копию с overrides.
 *
 * Match по `(walletId, txHash, logIndex=0)` — logIndex пока всегда 0
 * (multi-event tx не поддержан в A3 v1), будет расширено в A4.3.
 *
 * UCB D8: ops с `annotation.excluded === true` отфильтровываются —
 * cost basis pipeline, position tracker, asset rollup, realized PnL —
 * НИЧЕГО их не видит. Эффект как будто tx никогда не было.
 */
export function applyAnnotationsToOps(
  ops: readonly ClassifiedOp[],
  walletId: string,
  annotationsByKey: ReadonlyMap<string, ResolvedAnnotation>,
): ClassifiedOp[] {
  if (annotationsByKey.size === 0) return [...ops];

  const result: ClassifiedOp[] = [];
  for (const op of ops) {
    const k = `${walletId}|${op.hash.toLowerCase()}|0`;
    const a = annotationsByKey.get(k);
    if (!a) {
      result.push(op);
      continue;
    }
    // UCB D8: soft-delete — полностью убираем op из пайплайна.
    if (a.excluded === true) {
      continue;
    }
    // UCB A4.1: manualOpType override. Остальные поля
    // (manualCostBasisUsd) — применяются ниже через costBasisOverrideByHash.
    if (
      a.manualOpType &&
      OP_TYPE_WHITELIST.has(a.manualOpType) &&
      a.manualOpType !== op.type
    ) {
      result.push({ ...op, type: a.manualOpType as OpType });
    } else {
      result.push(op);
    }
  }
  return result;
}
