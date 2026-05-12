/**
 * Линкер async-deposit/withdraw пар (GMX V2, GMSOL, Flash Trade, Adrena…).
 *
 * Эти протоколы исполняются в ДВУХ атомарных транзакциях:
 *   Tx A: пользователь отправляет underlying (USDC/ETH) — sends only.
 *   Tx B: keeper в следующем блоке выдаёт LP-receipt (GM/GLV/GLP) — receives only.
 *
 * Без линкования:
 *   1. `posKey` для LP не содержит mint receipt'а → разные market-позиции
 *      одного протокола (GM[BTC] vs GM[ETH] vs GLV[WETH-USDC]) сливаются в одну.
 *   2. Cost basis для GM = m.usd рыночной цены DeBank, а не реально оплаченные
 *      USDC/ETH → завышенный startUsd, фантомная прибыль на момент открытия.
 *
 * Логика линкера:
 *   - Считаем "Tx A" — lp_add с notes ['*-deposit'] (от классификатора, sends only).
 *   - Считаем "Tx B" — lp_add с notes ['*-deposit-fill'] (receives only с protocol-token).
 *   - Для каждого Tx B ищем ближайший по времени НЕ ИСПОЛЬЗОВАННЫЙ Tx A в окне ±30 сек
 *     с теми же `protocol.id`, `chain`, `walletId` (через address не хранится в op,
 *     но same wallet — это same ops list).
 *   - При нахождении пары:
 *     * Tx A.linkedHash = Tx B.hash; Tx B.linkedHash = Tx A.hash.
 *     * Tx A.linkedLpTokenId = receipt.tokenId; Tx A.linkedLpSymbol = receipt.symbol.
 *     * Tx B.linkedCostBasisUsd = Σ outgoing.usd из Tx A.
 *
 * Аналогично для withdraw: Tx A (sends only с protocol-token) ↔ Tx B (receives
 * only underlying), но эта ветка реже встречается в наших данных. Реализуем
 * сразу обе для симметрии.
 */

import type { ClassifiedOp, TokenMovement } from "./types";

/** Окно поиска парной tx в секундах (Δt). */
const PAIR_WINDOW_SEC = 30;

interface MutableOp extends ClassifiedOp {
  linkedHash?: string;
  linkedLpTokenId?: string;
  linkedLpSymbol?: string;
  linkedCostBasisUsd?: number;
}

function hasNote(op: ClassifiedOp, note: string): boolean {
  return op.notes?.includes(note) === true;
}

function findProtocolToken(
  movement: TokenMovement[],
  direction: "in" | "out",
): TokenMovement | undefined {
  return movement.find((m) => m.direction === direction && m.isProtocolToken);
}

function sumOutgoingUsd(op: ClassifiedOp): number {
  return op.movement
    .filter((m) => m.direction === "out")
    .reduce((s, m) => s + (m.usd ?? 0), 0);
}

/**
 * Главная функция: проходит по операциям одного кошелька и связывает
 * парные async-deposit / async-withdraw транзакции. Возвращает новый
 * массив ClassifiedOp с проставленными `linked*` полями. Исходные op'ы
 * не мутируем (immutable update).
 */
export function linkAsyncDeposits(ops: ClassifiedOp[]): ClassifiedOp[] {
  if (ops.length === 0) return ops;

  // Сортируем по времени (на всякий случай — обычно ops уже отсортированы).
  const sorted = [...ops].sort((a, b) => a.time - b.time);
  const result: MutableOp[] = sorted.map((o) => ({ ...o }));

  // Индексируем для быстрого матчинга: для каждой пары (protocol, chain)
  // храним список индексов "Tx A"-кандидатов (deposit) и "Tx A"-кандидатов вывода.
  // Ключ: `${protocol.id}@${chain}`.
  type Slot = { idx: number; used: boolean };
  const depositCreators = new Map<string, Slot[]>();
  const withdrawCreators = new Map<string, Slot[]>();

  for (let i = 0; i < result.length; i++) {
    const op = result[i]!;
    if (op.type !== "lp_add") continue;
    if (!op.protocol) continue;
    const key = `${op.protocol.id}@${op.chain}`;
    if (
      hasNote(op, "yield-deposit") ||
      hasNote(op, "perp-deposit")
    ) {
      const arr = depositCreators.get(key) ?? [];
      arr.push({ idx: i, used: false });
      depositCreators.set(key, arr);
    }
  }
  // Симметрично — для lp_remove (withdraw): "Tx A" уносит protocol-токен.
  for (let i = 0; i < result.length; i++) {
    const op = result[i]!;
    if (op.type !== "lp_remove") continue;
    if (!op.protocol) continue;
    if (op.protocol.category !== "yield" && op.protocol.category !== "perp") continue;
    const sentProto = op.movement.some(
      (m) => m.direction === "out" && m.isProtocolToken,
    );
    if (!sentProto) continue;
    const key = `${op.protocol.id}@${op.chain}`;
    const arr = withdrawCreators.get(key) ?? [];
    arr.push({ idx: i, used: false });
    withdrawCreators.set(key, arr);
  }

  // Теперь матчим "Tx B" — lp_add с note '*-deposit-fill' с ближайшим
  // НЕ использованным Tx A в окне ±PAIR_WINDOW_SEC.
  for (let i = 0; i < result.length; i++) {
    const fill = result[i]!;
    if (fill.type !== "lp_add") continue;
    if (!fill.protocol) continue;
    const isFill =
      hasNote(fill, "yield-deposit-fill") ||
      hasNote(fill, "perp-deposit-fill");
    if (!isFill) continue;

    const key = `${fill.protocol.id}@${fill.chain}`;
    const candidates = depositCreators.get(key) ?? [];
    let best: Slot | undefined;
    let bestΔ = Infinity;
    for (const c of candidates) {
      if (c.used) continue;
      const creator = result[c.idx]!;
      const Δ = Math.abs(creator.time - fill.time);
      if (Δ > PAIR_WINDOW_SEC) continue;
      // Берём ближайший по времени, и предпочитаем тот что РАНЬШЕ fill (Tx A < Tx B).
      const score = creator.time <= fill.time ? Δ : Δ + 1000;
      if (score < bestΔ) {
        bestΔ = score;
        best = c;
      }
    }
    if (!best) continue;

    const creator = result[best.idx]!;
    const recvProto = findProtocolToken(fill.movement, "in");
    if (!recvProto) continue;

    creator.linkedHash = fill.hash;
    creator.linkedLpTokenId = recvProto.tokenId;
    creator.linkedLpSymbol = recvProto.symbol;

    fill.linkedHash = creator.hash;
    fill.linkedLpTokenId = recvProto.tokenId;
    fill.linkedLpSymbol = recvProto.symbol;
    fill.linkedCostBasisUsd = sumOutgoingUsd(creator);

    best.used = true;
  }

  // Симметрично для withdraw: Tx A (lp_remove sentProto) ↔ Tx B (lp_remove receives only underlying).
  for (let i = 0; i < result.length; i++) {
    const fill = result[i]!;
    if (fill.type !== "lp_remove") continue;
    if (!fill.protocol) continue;
    if (fill.protocol.category !== "yield" && fill.protocol.category !== "perp") continue;
    const sentProto = fill.movement.some(
      (m) => m.direction === "out" && m.isProtocolToken,
    );
    if (sentProto) continue; // это Tx A withdrawer, не Tx B
    const recvOnly =
      fill.movement.some((m) => m.direction === "in" && !m.isProtocolToken) &&
      !fill.movement.some((m) => m.direction === "out");
    if (!recvOnly) continue;

    const key = `${fill.protocol.id}@${fill.chain}`;
    const candidates = withdrawCreators.get(key) ?? [];
    let best: Slot | undefined;
    let bestΔ = Infinity;
    for (const c of candidates) {
      if (c.used) continue;
      const creator = result[c.idx]!;
      const Δ = Math.abs(creator.time - fill.time);
      if (Δ > PAIR_WINDOW_SEC) continue;
      const score = creator.time <= fill.time ? Δ : Δ + 1000;
      if (score < bestΔ) {
        bestΔ = score;
        best = c;
      }
    }
    if (!best) continue;

    const creator = result[best.idx]!;
    const sentLp = findProtocolToken(creator.movement, "out");
    if (!sentLp) continue;

    creator.linkedHash = fill.hash;
    creator.linkedLpTokenId = sentLp.tokenId;
    creator.linkedLpSymbol = sentLp.symbol;

    fill.linkedHash = creator.hash;
    fill.linkedLpTokenId = sentLp.tokenId;
    fill.linkedLpSymbol = sentLp.symbol;
    // Для withdraw cost basis обратной стороны не критичен в этом сценарии:
    // протокол-токен уже списан в Tx A (lp_remove with sent proto-token),
    // а здесь только underlying приходит — он получает обычный m.usd.

    best.used = true;
  }

  return result;
}

/**
 * Достаёт уникальный идентификатор LP-маркета для операции (для использования
 * в `posKey`). Учитывает:
 *   1. Прямой protocol-token в movement (классический Uniswap V3-style: send
 *      underlying + receive LP-receipt в одной tx).
 *   2. `linkedLpTokenId` из линкера (для async-deposit пар).
 * Возвращает `null` если LP-mint не определён — тогда posKey уходит в fallback.
 */
export function getLpMarketKey(op: ClassifiedOp): {
  tokenId: string;
  symbol: string;
} | null {
  // 1. Прямой protocol-token в movement (in или out — для add/remove соответственно).
  for (const m of op.movement) {
    if (m.isProtocolToken && m.tokenId) {
      return { tokenId: m.tokenId, symbol: m.symbol };
    }
  }
  // 2. Через линк.
  if (op.linkedLpTokenId) {
    return {
      tokenId: op.linkedLpTokenId,
      symbol: op.linkedLpSymbol ?? "?",
    };
  }
  return null;
}
