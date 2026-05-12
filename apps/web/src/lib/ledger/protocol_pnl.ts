/**
 * Cost basis per (protocol, token).
 *
 * Идея: проходим по ManualOp[] хронологически, для каждой `open` (внесли
 * токен в протокол) аккумулируем bucket {amount, costUsd}. Для каждого
 * `loan_return collateral` / `close` (вывели токен из протокола) вычитаем
 * по weighted-average bucket'а.
 *
 * На выходе для каждой пары (`Fluid@Arbitrum`, `ETH`) знаем:
 *   - текущий объём токена в позиции (по нашей реконструкции)
 *   - средневзвешенный USD cost basis
 *   - avg cost per unit
 *
 * UI потом сравнивает это с актуальной ценой (DeBank/Vybe) и считает PnL.
 */

import type { ManualOp } from "./types";

export interface ProtocolTokenSlot {
  symbol: string;
  amount: number;        // остаток токена в протоколе
  costUsd: number;       // суммарный USD cost basis
  avgCost: number;       // costUsd / amount
}

const KEY_SEP = "@";

function makeKey(protocol: string, network: string | null): string {
  // Берём первое слово, нижний регистр, чтобы матчить "Fluid" и "Fluid Lending".
  const proto = (protocol.split(/\s+/)[0] ?? protocol).toLowerCase();
  const net = (network ?? "").toLowerCase();
  return `${proto}${KEY_SEP}${net}`;
}

export function buildProtocolTokenSlots(
  ops: ManualOp[],
): Map<string, Map<string, ProtocolTokenSlot>> {
  const result = new Map<string, Map<string, ProtocolTokenSlot>>();

  function getBucket(protoKey: string, symbol: string): ProtocolTokenSlot {
    let m = result.get(protoKey);
    if (!m) {
      m = new Map();
      result.set(protoKey, m);
    }
    let b = m.get(symbol);
    if (!b) {
      b = { symbol, amount: 0, costUsd: 0, avgCost: 0 };
      m.set(symbol, b);
    }
    return b;
  }

  const sorted = [...ops].sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    return a.id < b.id ? -1 : 1;
  });

  for (const op of sorted) {
    /* ---------- INCREASE: open / stake / lp_add ------------------------- */
    if (
      op.type === "open" &&
      op.to &&
      op.cur1 &&
      op.amount1 != null &&
      op.amount1 > 0
    ) {
      const k = makeKey(op.to, op.network);
      const b = getBucket(k, op.cur1);
      b.amount += op.amount1;
      // price = USD-cost basis (генератор вычисляет через CostBasis tracker).
      b.costUsd += op.price ?? 0;
      b.avgCost = b.amount > 0 ? b.costUsd / b.amount : 0;
    }

    /* ---------- DECREASE: loan_return collateral / close ---------------- */
    const isWithdrawal =
      (op.type === "loan_return" && op.returnType === "collateral") ||
      op.type === "close";

    if (
      isWithdrawal &&
      op.from &&
      op.cur1 &&
      op.amount1 != null &&
      op.amount1 > 0
    ) {
      const k = makeKey(op.from, op.network);
      const m = result.get(k);
      if (!m) continue;
      const b = m.get(op.cur1);
      if (!b || b.amount <= 0) continue;

      // Снимаем по средневзвешенной цене bucket'а — пропорциональный
      // подход (не FIFO, не LIFO; нейтральный для большинства задач).
      const portion = Math.min(op.amount1, b.amount);
      const portionCost = b.avgCost * portion;
      b.amount -= portion;
      b.costUsd -= portionCost;
      if (b.amount < 1e-9) {
        b.amount = 0;
        b.costUsd = 0;
      }
      b.avgCost = b.amount > 0 ? b.costUsd / b.amount : 0;
    }
  }

  return result;
}

/** Lookup для матчинга live-позиции (chain="arb"/"sol") с нашей картой. */
const NETWORK_ALIAS: Record<string, string> = {
  eth: "ethereum",
  arb: "arbitrum",
  op: "optimism",
  matic: "polygon",
  bsc: "bnb chain",
  base: "base",
  avax: "avalanche",
  ftm: "fantom",
  sol: "solana",
};

export function findSlotsFor(
  protocolName: string,
  chain: string,
  index: Map<string, Map<string, ProtocolTokenSlot>>,
): Map<string, ProtocolTokenSlot> | null {
  const network = NETWORK_ALIAS[chain] ?? chain;
  const key = makeKey(protocolName, network);
  if (index.has(key)) return index.get(key)!;
  // Fallback: любая запись, начинающаяся с того же proto-prefix.
  const protoOnly = makeKey(protocolName, null).split(KEY_SEP)[0];
  for (const [k, v] of index.entries()) {
    if (k.startsWith(`${protoOnly}${KEY_SEP}`)) return v;
  }
  return null;
}
