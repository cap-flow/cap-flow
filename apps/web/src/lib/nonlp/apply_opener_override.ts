/**
 * Pure override для НЕ-LP позиций на основе Etherscan/Alchemy-детекта
 * (см. `use_opener_detector.ts`). Применяет ДВА независимых патча:
 *
 *   1. openedAt / ageDays — заполняем если пусто, А ТАКЖЕ перетираем когда
 *      on-chain дата receipt-токена ПОЗЖЕ DeBank-даты на >1 день (DeBank для
 *      multi-market протоколов типа Pendle навешивает дату первого
 *      взаимодействия на все сабпозиции). Раньше — не трогаем (re-open guard).
 *   2. startUsd / netStartUsd / netPnl + openedInTokens — из OUT-side
 *      («потрачено при открытии», см. cost_basis.ts) НЕЗАВИСИМО от наличия
 *      даты. UCB decomposition для receipt-токенов часто врёт (GMX V2 GLV:
 *      cross-pollution + wrong startUsd), поэтому OUT-side authoritative
 *      когда надёжен (весь OUT в USD-стейблах, Σ > 0).
 *
 * APR (feeApr / feeAprLifetime) пересчитывается на эффективных значениях.
 *
 *   3. coverageIncomplete — для GMX-позиций (GM/GLV/GLP), где receipt пришёл
 *      async/claim/миграцией без видимого депозита И DeBank открытия не дал И
 *      OUT-side пуст: вместо выдуманного startUsd/PnL ставим
 *      `coverageIncomplete=true` + `startUsd=currentUsd` (тот же honest-флаг,
 *      что у V3-orphan'ов). UI рисует «⚠ cost basis incomplete».
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

    // ── Дата открытия = первый on-chain IN-transfer КОНКРЕТНОГО receipt- ──
    // токена (authoritative per-sub-position). DeBank для multi-market
    // протоколов (Pendle: PT-apxUSD + PT-apyUSD в одном протоколе) отдаёт дату
    // ПЕРВОГО взаимодействия с протоколом и навешивает её на ВСЕ сабпозиции →
    // разные позиции получают одну (раннюю) дату. Поэтому:
    //   - openedAt пуст → заполняем;
    //   - detector ПОЗЖЕ существующей на > 1 дня → DeBank дал слишком раннюю
    //     (конфляция) → перетираем on-chain датой (она точнее для этой позиции).
    // detector РАНЬШЕ существующей НЕ перетираем: re-open (aToken мог минтиться
    // раньше при прошлом депозите), DeBank-дата текущего открытия надёжнее.
    const DAY = 86400;
    const detectorDateSane = opener.openedAt > 0 && opener.openedAt <= nowSec;
    const dateApplicable =
      detectorDateSane &&
      (p.openedAt == null || opener.openedAt - p.openedAt > DAY);
    if (dateApplicable) {
      const ageDays = round1(Math.max(0, (nowSec - opener.openedAt) / 86400));
      const overwrote = p.openedAt != null;
      patch.openedAt = opener.openedAt;
      patch.openHash = opener.txHash;
      patch.ageDays = ageDays;
      notes.push(
        `openedAt ${overwrote ? "перетёрт (DeBank-конфляция) → " : "→ "}${new Date(
          opener.openedAt * 1000,
        )
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

    // ── coverageIncomplete: cost basis ПРИНЦИПИАЛЬНО невосстановим. ──
    // Сигнатура: receipt пришёл (opener дату нашли), но трат не видно ВООБЩЕ
    // (openedInTokens пусто) И startUsd не вышел (null) И DeBank открытия не
    // дал (p.openedAt == null). Это GMX V2 async/claim, GLP→GM миграция,
    // Safe-internal депозиты — где и DeBank-op, и наш OUT-side молчат.
    // Вместо выдуманного startUsd/PnL помечаем «⚠ cost basis incomplete»
    // (тот же флаг, что у V3-orphan'ов) и ставим startUsd = currentUsd
    // (честно: «историю не знаем»). Aave/IPOR/Avantis ловят OUT в той же tx
    // → openedInTokens непусто → сюда не попадают. egorovfinance: DeBank дал
    // дату (openedAt != null) → не попадает.
    // Скоуп: только GMX (V1/V2) — единственное семейство, где receipt (GM/GLV/
    // GLP) приходит async/claim/миграцией без видимого депозита, а DeBank-op
    // отсутствует. Lending/staking/yield/cex могут иметь надёжный startUsd из
    // lot-трекера БЕЗ DeBank-даты — их флагать нельзя (регрессия). Расширять
    // на другие Safe-internal vault'ы (Lombard/Locus) — отдельно, с проверкой.
    const isGmx = /\bgmx\b/i.test(p.protocol.name);
    const costBasisUnknown =
      isGmx &&
      p.openedAt == null &&
      opener.startUsd == null &&
      opener.openedInTokens.length === 0;

    if (notes.length === 0 && !costBasisUnknown) return p; // нечего применять

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

    if (costBasisUnknown) {
      patch.coverageIncomplete = true;
      patch.startUsd = p.currentUsd;
      patch.netStartUsd = p.currentUsd;
      patch.netPnlUsd = 0;
      patch.netPnlPct = 0;
      patch.feeApr = null;
      patch.feeAprLifetime = null;
      notes.push("cost basis неизвестен (receipt без видимого депозита) → ⚠ incomplete");
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
