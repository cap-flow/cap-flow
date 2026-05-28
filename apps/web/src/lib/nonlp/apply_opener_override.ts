/**
 * Pure override для НЕ-LP позиций на основе Etherscan/Alchemy-детекта
 * (см. `use_opener_detector.ts`). Применяет ДВА независимых патча:
 *
 *   1. openedAt / ageDays — ТОЛЬКО если `openedAt == null` (не перетираем
 *      даты от UCB / Krystal — они authoritative).
 *   2. startUsd / netStartUsd / netPnl + openedInTokens — из OUT-side
 *      («потрачено при открытии», см. cost_basis.ts) НЕЗАВИСИМО от наличия
 *      даты. UCB decomposition для receipt-токенов часто врёт (GMX V2 GLV:
 *      cross-pollution + wrong startUsd), поэтому OUT-side authoritative
 *      когда надёжен (весь OUT в USD-стейблах, Σ > 0).
 *
 * APR (feeApr / feeAprLifetime) пересчитывается на эффективных значениях.
 *
 * Защитные guards:
 *   - применяем ТОЛЬКО к non-V3-LP (V3 LP идут через Krystal openedTime)
 *   - startUsd перетираем ТОЛЬКО валидной суммой (>0), не валидным нулём
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
    // Guard 1: не трогаем V3 LP (у них свой источник — Krystal)
    if (isV3LpProtocol(p.protocol.name)) return p;
    // Guard 2: нужен receipt token + wallet для ключа
    if (!p.lpTokenId) return p;
    const wallet = walletAddressById.get(p.walletId);
    if (!wallet) return p;
    const opener = openerByKey.get(
      nonLpOpenerKey(p.chain, p.lpTokenId, wallet),
    );
    if (!opener) return p;

    const patch: Partial<OpenPosition> = {};
    const notes: string[] = [];

    // ── Дата: ставим ТОЛЬКО если её нет (не перетираем UCB/Krystal). ──
    // Guard: sane timestamp (в прошлом и > 0).
    const dateApplicable =
      p.openedAt == null && opener.openedAt > 0 && opener.openedAt <= nowSec;
    if (dateApplicable) {
      const ageDays = round1(Math.max(0, (nowSec - opener.openedAt) / 86400));
      patch.openedAt = opener.openedAt;
      patch.openHash = p.openHash ?? opener.txHash;
      patch.ageDays = ageDays;
      notes.push(
        `openedAt → ${new Date(opener.openedAt * 1000)
          .toISOString()
          .slice(0, 10)} (${ageDays}d, tx ${opener.txHash.slice(0, 10)}…)`,
      );
    }

    // ── startUsd: OUT-side стейблы → перетираем UCB/fallback НЕЗАВИСИМО от ──
    // наличия даты (GMX V2 GLV имеет UCB-дату, но wrong startUsd). Только
    // если получили валидную сумму (>0) — валидным нулём не перетираем.
    const newStartUsd =
      opener.startUsd != null && opener.startUsd > 0 ? opener.startUsd : null;
    if (newStartUsd != null && newStartUsd !== p.startUsd) {
      patch.startUsd = newStartUsd;
      patch.netStartUsd = newStartUsd;
      patch.netPnlUsd = p.currentUsd - newStartUsd;
      patch.netPnlPct =
        newStartUsd > 0 ? ((p.currentUsd - newStartUsd) / newStartUsd) * 100 : 0;
      notes.push(`startUsd → $${newStartUsd.toFixed(2)} (OUT-side stable)`);
    }

    // ── openedInTokens: OUT-side underlying → перетираем UCB decomposition ──
    // (чинит GMX GLV cross-pollution где UCB показывал токены обоих vault'ов).
    if (opener.openedInTokens.length > 0) {
      const mapped = opener.openedInTokens.map((t) => ({
        symbol: t.symbol,
        amount: t.amount,
        tokenId: t.address,
      }));
      patch.openedInTokens = mapped;
      notes.push(
        `openedInTokens → ${mapped.map((t) => t.symbol).join("+")} (OUT-side)`,
      );
    }

    if (notes.length === 0) return p; // нечего применять

    // APR: пересчитываем на эффективных startUsd + ageDays (после patch'а).
    const effStartUsd = patch.startUsd ?? p.startUsd;
    const effAgeDays = patch.ageDays ?? p.ageDays;
    if (effAgeDays != null && effAgeDays > 0 && effStartUsd > 0) {
      if (p.feesUsd != null) {
        patch.feeApr = (p.feesUsd / effStartUsd) * (365 / effAgeDays) * 100;
      }
      patch.feeAprLifetime =
        (p.feesLifetimeUsd / effStartUsd) * (365 / effAgeDays) * 100;
    }

    overriddenCount++;
    warnings.push(
      `[NonLP opener] ${p.id} (${p.protocol.name} ${p.chain}): ` +
        notes.join(" · "),
    );

    return { ...p, ...patch };
  });

  return { positions: out, overriddenCount, warnings };
}
