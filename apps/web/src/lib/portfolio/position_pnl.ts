/**
 * Сводит live-позиции (текущее состояние из DeBank/Vybe) с их cost basis
 * (что было вложено по истории операций) → даёт PnL и информацию о
 * заёмной/собственной составляющей.
 */

import type { ManualOp } from "../ledger/types";
import type { LiveProtocolPosition } from "./live";

export interface PositionEnrichment {
  costBasisOwnUsd: number;      // сколько своих ушло в эту позицию (по open price)
  costBasisBorrowedUsd: number; // сколько заёмных ушло (по open price)
  costBasisTotalUsd: number;
  pnlUsd: number;               // currentNet − costBasisOwnUsd (равноcity)
  pnlPct: number;
  borrowedShare: number;        // 0..1
  borrowSource: string | null;
  matchedOpenIds: string[];
}

/**
 * Строит индекс «cost basis по протоколу+сети» из ManualOp[].
 *
 * Ключ: первое слово протокола в lower-case + "@" + сеть в lower-case.
 * Это позволяет сопоставлять `Aave V3` (live) с `Aave` (генератор) и
 * `Marinade Finance` (Vybe) с `Marinade` (наш реестр).
 */
export function buildPositionCostBasis(ops: ManualOp[]): Map<
  string,
  {
    own: number;
    borrowed: number;
    openIds: string[];
    closedIds: string[];
    borrowSource: string | null;
  }
> {
  const map = new Map<
    string,
    {
      own: number;
      borrowed: number;
      openIds: string[];
      closedIds: string[];
      borrowSource: string | null;
    }
  >();

  for (const op of ops) {
    if (op.type !== "open") continue;
    if (!op.to) continue;
    const key = makeKey(op.to, op.network);
    const cur = map.get(key) ?? {
      own: 0,
      borrowed: 0,
      openIds: [] as string[],
      closedIds: [] as string[],
      borrowSource: null as string | null,
    };
    const usd = op.price ?? 0;
    const share = op.borrowedShare ?? (op.funds === "borrowed" ? 1 : 0);
    cur.own += usd * (1 - share);
    cur.borrowed += usd * share;
    cur.openIds.push(op.id);
    if (!cur.borrowSource && op.loanFrom) cur.borrowSource = op.loanFrom;
    map.set(key, cur);
  }

  // close — обнуляем cost basis для закрытых.
  // Мэтчим по from (close.from = протокол) + network.
  for (const op of ops) {
    if (op.type !== "close" || !op.from) continue;
    const key = makeKey(op.from, op.network);
    const bucket = map.get(key);
    if (!bucket) continue;
    // Закрытие тушит самую раннюю open.
    const closedId = bucket.openIds.shift();
    if (closedId) bucket.closedIds.push(closedId);
    // Cost basis тоже уменьшаем (грубо — поделить пополам по доле):
    // НО точнее — уменьшать на ту же сумму, что была в openOp. Без NN-связки
    // позиций close→open, делаем простой fallback: при первом close
    // обнуляем всё, если openIds опустел.
    if (bucket.openIds.length === 0) {
      bucket.own = 0;
      bucket.borrowed = 0;
    }
  }

  return map;
}

function makeKey(name: string, network: string | null): string {
  const proto = name.split(/\s+/)[0]?.toLowerCase() ?? name.toLowerCase();
  const net = (network ?? "").toLowerCase();
  return `${proto}@${net}`;
}

/** Для live-позиции возвращает enrichment по индексу cost basis. */
export function enrichPosition(
  pos: LiveProtocolPosition,
  index: ReturnType<typeof buildPositionCostBasis>,
): PositionEnrichment | null {
  // chain в LiveProtocolPosition — это "eth"/"arb"/"sol"/etc.
  // А в network у нас "Ethereum", "Arbitrum", "Solana"…
  const networkAliases: Record<string, string> = {
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
  const network = networkAliases[pos.chain] ?? pos.chain;
  const key = makeKey(pos.protocolName, network);
  let bucket = index.get(key);
  // Fallback: попробуем без сети (для редких случаев).
  if (!bucket) {
    for (const [k, b] of index.entries()) {
      if (k.startsWith(makeKey(pos.protocolName, null))) {
        bucket = b;
        break;
      }
    }
  }
  if (!bucket) return null;

  const total = bucket.own + bucket.borrowed;
  if (total <= 0.01) return null;

  // PnL = currentNet − own (заёмное вычитается потому что оно — не наш капитал).
  // Это самая консервативная и понятная метрика для пользователя:
  // «сколько я заработал на этом своими деньгами».
  const pnlUsd = pos.netUsd - bucket.own;
  const pnlPct = bucket.own > 0 ? (pnlUsd / bucket.own) * 100 : 0;

  return {
    costBasisOwnUsd: bucket.own,
    costBasisBorrowedUsd: bucket.borrowed,
    costBasisTotalUsd: total,
    pnlUsd,
    pnlPct,
    borrowedShare: total > 0 ? bucket.borrowed / total : 0,
    borrowSource: bucket.borrowSource,
    matchedOpenIds: bucket.openIds,
  };
}
