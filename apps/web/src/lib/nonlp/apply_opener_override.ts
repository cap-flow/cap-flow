/**
 * Pure override: проставляет `openedAt` / `ageDays` (и пересчитывает APR)
 * для НЕ-LP позиций, у которых UCB/DeBank дал `openedAt === null`, используя
 * Etherscan-detected дату открытия (см. `use_opener_detector.ts`).
 *
 * Stage 1 scope — ТОЛЬКО дата + производные (ageDays, feeApr, feeAprLifetime).
 * startUsd / cost basis НЕ трогаем (это Stage 2, OUT-side tracing).
 *
 * Защитные guards:
 *   - применяем ТОЛЬКО если `openedAt == null` (не перетираем существующие даты
 *     от UCB или Krystal — те authoritative для своих случаев)
 *   - применяем ТОЛЬКО к non-V3-LP (V3 LP идут через Krystal openedTime)
 *   - detected openedAt должен быть в прошлом и > 0
 */

import type { OpenPosition } from "../portfolio/open_positions";
import { isV3LpProtocol } from "../portfolio/open_positions";
import type { NonLpOpener } from "./opener_detector";
import { nonLpOpenerKey } from "./use_opener_detector";

export interface OpenerOverrideResult {
  positions: OpenPosition[];
  overriddenCount: number;
  warnings: string[];
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * @param openerByKey — Map keyed by `${chain}|${receiptToken}|${wallet}`
 *   (стабильный ключ, не positionId — POS-NNN переномеровываются).
 * @param walletAddressById — для построения ключа из OpenPosition.
 */
export function applyNonLpOpenerOverride(
  positions: readonly OpenPosition[],
  openerByKey: ReadonlyMap<string, NonLpOpener>,
  walletAddressById: ReadonlyMap<string, string>,
): OpenerOverrideResult {
  if (openerByKey.size === 0) {
    return { positions: positions.slice(), overriddenCount: 0, warnings: [] };
  }
  const nowSec = Date.now() / 1000;
  let overriddenCount = 0;
  const warnings: string[] = [];

  const out = positions.map((p) => {
    // Guard 1: только позиции без даты
    if (p.openedAt != null) return p;
    // Guard 2: не трогаем V3 LP (у них свой источник — Krystal)
    if (isV3LpProtocol(p.protocol.name)) return p;
    // Guard 3: нужен receipt token + wallet для ключа
    if (!p.lpTokenId) return p;
    const wallet = walletAddressById.get(p.walletId);
    if (!wallet) return p;
    const opener = openerByKey.get(
      nonLpOpenerKey(p.chain, p.lpTokenId, wallet),
    );
    if (!opener) return p;
    // Guard 4: sane timestamp
    if (!(opener.openedAt > 0) || opener.openedAt > nowSec) return p;

    const ageDays = round1(Math.max(0, (nowSec - opener.openedAt) / 86400));
    // Пересчёт APR теперь когда есть ageDays. startUsd НЕ меняем (Stage 2).
    const start = p.startUsd;
    const feeApr =
      start > 0 && ageDays > 0 && p.feesUsd != null
        ? (p.feesUsd / start) * (365 / ageDays) * 100
        : p.feeApr;
    const feeAprLifetime =
      start > 0 && ageDays > 0
        ? (p.feesLifetimeUsd / start) * (365 / ageDays) * 100
        : p.feeAprLifetime;

    overriddenCount++;
    warnings.push(
      `[NonLP opener] ${p.id} (${p.protocol.name} ${p.chain}): openedAt → ` +
        `${new Date(opener.openedAt * 1000).toISOString().slice(0, 10)} ` +
        `(${ageDays}d, tx ${opener.txHash.slice(0, 10)}…)`,
    );

    return {
      ...p,
      openedAt: opener.openedAt,
      openHash: p.openHash ?? opener.txHash,
      ageDays,
      feeApr,
      feeAprLifetime,
    };
  });

  return { positions: out, overriddenCount, warnings };
}
