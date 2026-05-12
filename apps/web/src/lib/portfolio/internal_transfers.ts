/**
 * Парный детектор «перевод между своими кошельками».
 *
 * Зачем: когда пользователь переводит USDT с Arbitrum на Solana через мост,
 * EVM-сторона видит `0x…` адрес отправителя/получателя, а Solana-сторона —
 * base58-адрес. Они разные → проверка `ownAddresses.has(counterparty)`
 * не сработает.
 *
 * Решение: ищем пары `out` ↔ `in` в окне ±60 минут с одинаковым символом
 * токена и близкой суммой (±5% для волатильных, ±10% для стейблов —
 * комиссии моста бывают существенными).
 *
 * Обе стороны такой пары помечаются как «internal» и убираются из
 * списка «требуется разметка».
 */

import type { ClassifiedOp } from "./types";
import { tokenFamily } from "./protocols";

const TIME_WINDOW_SEC = 60 * 60;        // ±60 минут на матчинг по времени
const AMOUNT_TOLERANCE_VOLATILE = 0.05; // ±5%
const AMOUNT_TOLERANCE_STABLE = 0.10;   // ±10% (для стейблов, чтобы покрыть мосты с большой комиссией)

const STABLE_SYMBOLS = new Set([
  "USDT", "USDC", "USDC.E", "DAI", "PYUSD", "FDUSD",
  "USDP", "TUSD", "LUSD", "BUSD", "FRAX", "CRVUSD",
]);

export interface InternalPair {
  outHash: string;
  inHash: string;
  symbol: string;
  outAmount: number;
  inAmount: number;
  fromWalletId: string;
  toWalletId: string;
  feeApprox: number; // USDish: out - in (если есть)
}

export interface OpWithWalletId {
  op: ClassifiedOp;
  walletId: string;
}

interface OutCandidate {
  op: ClassifiedOp;
  walletId: string;
  symbol: string;
  amount: number;
  usdPerUnit: number | null;
}

const OUT_TYPES = new Set(["transfer_out", "withdraw_fiat", "bridge_out"]);
const IN_TYPES = new Set(["transfer_in", "deposit_fiat", "bridge_in"]);

export function findInternalTransferPairs(
  items: OpWithWalletId[],
): { matchedHashes: Set<string>; pairs: InternalPair[] } {
  const matched = new Set<string>();
  const pairs: InternalPair[] = [];

  // Индекс OUT-движений: для быстрого поиска кандидатов.
  const outs: OutCandidate[] = [];
  for (const { op, walletId } of items) {
    if (!OUT_TYPES.has(op.type)) continue;
    for (const m of op.movement) {
      if (m.direction !== "out" || m.amount <= 0) continue;
      outs.push({
        op,
        walletId,
        symbol: m.symbol,
        amount: m.amount,
        usdPerUnit: m.usd != null && m.amount > 0 ? m.usd / m.amount : null,
      });
    }
  }

  for (const { op: inOp, walletId: inWalletId } of items) {
    if (!IN_TYPES.has(inOp.type)) continue;
    if (matched.has(inOp.hash)) continue;

    for (const inMov of inOp.movement) {
      if (inMov.direction !== "in" || inMov.amount <= 0) continue;

      const isStable = STABLE_SYMBOLS.has(inMov.symbol.toUpperCase());
      const tolerance = isStable ? AMOUNT_TOLERANCE_STABLE : AMOUNT_TOLERANCE_VOLATILE;

      const inFamily = tokenFamily(inMov.symbol);
      const candidate = outs.find((o) => {
        if (o.walletId === inWalletId) return false;
        if (matched.has(o.op.hash)) return false;
        if (Math.abs(o.op.time - inOp.time) > TIME_WINDOW_SEC) return false;
        // Сравниваем по нормализованному «семейству» токена — USDT ↔ USD₮0,
        // ETH ↔ WETH через мост это один и тот же актив.
        if (tokenFamily(o.symbol) !== inFamily) return false;
        const diff = Math.abs(o.amount - inMov.amount) / Math.max(o.amount, 1e-9);
        return diff <= tolerance;
      });

      if (!candidate) continue;

      matched.add(inOp.hash);
      matched.add(candidate.op.hash);
      const feeApprox =
        candidate.usdPerUnit != null
          ? (candidate.amount - inMov.amount) * candidate.usdPerUnit
          : 0;
      pairs.push({
        outHash: candidate.op.hash,
        inHash: inOp.hash,
        symbol: inMov.symbol,
        outAmount: candidate.amount,
        inAmount: inMov.amount,
        fromWalletId: candidate.walletId,
        toWalletId: inWalletId,
        feeApprox,
      });
      break; // одна in-tx — одна пара
    }
  }

  return { matchedHashes: matched, pairs };
}
