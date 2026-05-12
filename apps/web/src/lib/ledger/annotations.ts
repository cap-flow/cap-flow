/**
 * Аннотации к авто-сгенерированным операциям из блокчейна.
 *
 * Зачем: некоторые важные данные блокчейн в принципе не видит —
 *   - купил USDT за рубли через P2P → блокчейн видит только приход USDT,
 *     не видит сумму ₽ и курс;
 *   - вывел USDT на наличные → блокчейн видит уход USDT, не видит куда;
 *   - перевёл другу → нужно подписать «friend transfer».
 *
 * Аннотации хранятся в localStorage по tx-hash и накладываются поверх
 * `ManualOp`, превращая `buy(cur1=USDT)` в полноценный `buy(RUB→USDT)` с курсом.
 */

import { useLocalStorage } from "@/lib/useLocalStorage";

export interface OpAnnotation {
  /** Если auto-buy из CEX — сколько ₽ ты на это потратил. */
  rubAmount?: number;
  /** Источник средств: P2P / Bank / Cash / Salary / Friend / … */
  rubSource?: string;
  /** Произвольный комментарий, который заменит/дополнит auto-комментарий. */
  customComment?: string;
  /** Скрыть операцию из учёта (если auto сгенерил лишнее). */
  hidden?: boolean;
  updatedAt: number;
}

export type AnnotationsMap = Record<string, OpAnnotation>;

const STORAGE_KEY = "capflow.opAnnotations";

export function useOpAnnotations() {
  return useLocalStorage<AnnotationsMap>(STORAGE_KEY, {});
}

/** Helper: применяет аннотацию к ManualOp, возвращая обогащённую копию. */
import type { ManualOp } from "./types";

export interface EnrichedOp extends ManualOp {
  txHash: string | null;
  annotation: OpAnnotation | null;
}

export function enrichOps(
  ops: ManualOp[],
  hashByManualId: Record<string, string>,
  annotations: AnnotationsMap,
): EnrichedOp[] {
  return ops.map((op) => {
    const txHash = hashByManualId[op.id] ?? null;
    const annotation = txHash ? annotations[txHash] ?? null : null;
    return applyAnnotation(op, txHash, annotation);
  });
}

function applyAnnotation(
  op: ManualOp,
  txHash: string | null,
  annotation: OpAnnotation | null,
): EnrichedOp {
  if (!annotation) return { ...op, txHash, annotation: null };

  const merged: EnrichedOp = { ...op, txHash, annotation };

  // Если задан RUB и есть amount1 (например, пришло 1500 USDT) —
  // дописываем RUB-сторону: cur2/amount2 → перевод "RUB → token".
  if (
    annotation.rubAmount &&
    annotation.rubAmount > 0 &&
    op.amount1 != null &&
    op.amount1 > 0 &&
    op.cur1 // у нас должна быть валюта 1
  ) {
    // Имитируем структуру ручного учёта пользователя: cur1=RUB, amount1=₽,
    // cur2=token, amount2=кол-во токена, rate=cur1/cur2.
    const tokenSymbol = op.cur1;
    const tokenAmount = op.amount1;
    const rubAmount = annotation.rubAmount;
    merged.cur1 = "RUB";
    merged.amount1 = rubAmount;
    merged.cur2 = tokenSymbol;
    merged.amount2 = tokenAmount;
    merged.rate = tokenAmount > 0 ? rubAmount / tokenAmount : null;
    if (annotation.rubSource) {
      merged.from = annotation.rubSource;
    }
  }

  if (annotation.customComment) {
    merged.comment = annotation.customComment;
  }

  return merged;
}
