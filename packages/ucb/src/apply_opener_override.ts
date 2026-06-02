/**
 * Pure override for NON-LP positions based on Etherscan/Alchemy detection
 * (see the web `use_opener_detector.ts` / B4 server fetch service). Applies TWO
 * independent patches:
 *
 *   1. openedAt / ageDays — fill if empty, AND overwrite when the on-chain
 *      receipt-token date is LATER than the DeBank date by >1 day (DeBank hangs
 *      the first-interaction date on every sub-position of multi-market
 *      protocols like Pendle). Earlier → not touched (re-open guard).
 *   2. startUsd / netStartUsd / netPnl + openedInTokens — from the OUT-side
 *      ("spent at open", see cost_basis.ts) regardless of date. UCB
 *      receipt-token decomposition often lies (GMX V2 GLV: cross-pollution +
 *      wrong startUsd), so the OUT-side is authoritative when reliable (all OUT
 *      in USD-stables, Σ > 0).
 *
 * APR (feeApr / feeAprLifetime) is recomputed on the effective values.
 *
 *   3. coverageIncomplete — for GMX positions with an empty OUT-side, when
 *      DeBank gave no open OR it is a GLV vault (UCB cross-pollution + unreliable
 *      startUsd even with a DeBank date). Sets `coverageIncomplete=true`,
 *      `startUsd=currentUsd`, clears openedInTokens. GM (egorovfinance) is NOT
 *      affected — DeBank gives an exact deposit op.
 *
 * Guards:
 *   - applies ONLY to non-V3-LP (V3 LP goes through Krystal openedTime)
 *   - overwrites startUsd ONLY with a valid amount (>0), not a valid zero
 *   - detected openedAt must be in the past and > 0
 */

import type { OpenPosition } from "./open_positions.js";
import { isV3LpProtocol } from "./open_positions.js";
import type { NonLpOpener } from "./non_lp_opener.js";
import { nonLpOpenerKey } from "./non_lp_opener.js";

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
 *   (stable key, not positionId — POS-NNN renumbers).
 * @param walletAddressById — to build the key from an OpenPosition.
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
    // Guard 1: skip V3 LP (their source is Krystal).
    if (isV3LpProtocol(p.protocol.name)) return p;
    // Guard 2: need a receipt token + wallet for the key.
    if (!p.lpTokenId) return p;
    const wallet = walletAddressById.get(p.walletId);
    if (!wallet) return p;
    const opener = openerByKey.get(
      nonLpOpenerKey(p.chain, p.lpTokenId, wallet),
    );
    if (!opener) return p;

    const patch: Partial<OpenPosition> = {};
    const notes: string[] = [];

    // ── Open date = first on-chain IN-transfer of THIS receipt token ──
    // (authoritative per-sub-position). For multi-market protocols DeBank gives
    // the first-interaction date and hangs it on ALL sub-positions, so:
    //   - openedAt empty → fill;
    //   - detector LATER than existing by > 1 day → DeBank conflated → overwrite.
    // detector EARLIER → NOT overwritten (re-open: receipt may have minted on a
    // prior deposit; DeBank's current-open date is more reliable).
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
        `openedAt ${overwrote ? "overwritten (DeBank conflation) → " : "→ "}${new Date(
          opener.openedAt * 1000,
        )
          .toISOString()
          .slice(0, 10)} (${ageDays}d, tx ${opener.txHash.slice(0, 10)}…)`,
      );
    }

    // ── startUsd: OUT-side stables → overwrite UCB/fallback regardless of ──
    // date (GMX V2 GLV has a UCB date but a wrong startUsd). Only if we got a
    // valid amount (>0) — never overwrite with a valid zero.
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

    // ── openedInTokens: OUT-side underlying → overwrite UCB decomposition ──
    // (fixes GMX GLV cross-pollution where UCB showed both vaults' tokens).
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

    // ── coverageIncomplete: cost basis FUNDAMENTALLY unrecoverable. ──
    // Signature: receipt arrived (opener date found) but no spend is visible AT
    // ALL (openedInTokens empty) AND startUsd did not resolve (null) AND DeBank
    // gave no open (p.openedAt == null). GMX V2 async/claim, GLP→GM migration,
    // Safe-internal deposits — where both the DeBank op and our OUT-side are
    // silent. Instead of an invented startUsd/PnL we flag "⚠ cost basis
    // incomplete" (same flag as V3 orphans) and set startUsd = currentUsd.
    // Scope: only GMX (V1/V2) — the only family where the receipt (GM/GLV/GLP)
    // arrives async/claim/migration without a visible deposit.
    const isGmx = /\bgmx\b/i.test(p.protocol.name);
    const isGlv = [...p.supplyTokens, ...p.openedInTokens].some((t) =>
      /\bGLV\b/i.test(t.symbol),
    );
    const noOutSide =
      opener.startUsd == null && opener.openedInTokens.length === 0;
    const costBasisUnknown =
      isGmx && noOutSide && (p.openedAt == null || isGlv);

    if (notes.length === 0 && !costBasisUnknown) return p; // nothing to apply

    // APR: recompute on the effective startUsd + ageDays (post-patch).
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
      // Clear cross-pollution: UCB put both GLV vaults' receipt tokens in
      // openedInTokens. Cost basis unknown → "opened in" is also empty.
      patch.openedInTokens = [];
      notes.push("cost basis unknown (GMX async/claim) → ⚠ incomplete");
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
