/**
 * PR-K2: cross-validation Capflow OpenPosition vs Krystal V3 summary.
 *
 * Krystal — gold standard для V3 LP current state (Uniswap UI parity).
 * Для каждой V3 NFT матчим OpenPosition.matchedV3TokenId → Krystal summary
 * и проверяем расхождения на critical fields:
 *
 *   - `currentUsd` — live position value
 *   - `feesUsd` (pending) — real-time uncollected
 *   - `feesClaimedUsd` — cumulative collected (catches Bug #1
 *     collect-vs-decrease misclassification)
 *
 * Tolerance: max(5% relative, $1 absolute). Игнорируем oracle micro-drift,
 * ловим только existential bugs.
 */

import type { OpenPosition } from "../portfolio/open_positions";
import type { KrystalV3Summary } from "./adapter";

const RELATIVE_TOLERANCE = 0.05; // 5%
const ABSOLUTE_TOLERANCE_USD = 1; // $1

export interface KrystalDivergence {
  posId: string;
  matchedV3TokenId: string;
  /** Какие поля разошлись > tolerance. */
  fields: ("currentUsd" | "pendingFeeUsd" | "feesClaimedUsd")[];
  /** Detail per field — для console.warn UX. */
  details: {
    currentUsd?: { capflow: number; krystal: number; diff: number; pct: number };
    pendingFeeUsd?: { capflow: number; krystal: number; diff: number; pct: number };
    feesClaimedUsd?: { capflow: number; krystal: number; diff: number; pct: number };
  };
}

function isDivergent(a: number, b: number): boolean {
  const diff = Math.abs(a - b);
  if (diff < ABSOLUTE_TOLERANCE_USD) return false;
  const base = Math.max(Math.abs(a), Math.abs(b), 1);
  return diff / base > RELATIVE_TOLERANCE;
}

function diffDetail(a: number, b: number): {
  capflow: number;
  krystal: number;
  diff: number;
  pct: number;
} {
  const diff = a - b;
  const base = Math.max(Math.abs(a), Math.abs(b), 1);
  return {
    capflow: a,
    krystal: b,
    diff,
    pct: (diff / base) * 100,
  };
}

/**
 * Возвращает массив divergences. Для каждой OpenPosition с
 * `matchedV3TokenId` → если Krystal'овский summary существует и хоть одно
 * поле выходит за tolerance, генерируется divergence entry со списком
 * проблемных полей + детальными числами.
 */
export function findKrystalDivergences(
  positions: readonly OpenPosition[],
  krystalByTokenId: ReadonlyMap<string, KrystalV3Summary>,
): KrystalDivergence[] {
  const out: KrystalDivergence[] = [];
  for (const p of positions) {
    if (!p.matchedV3TokenId) continue;
    const k = krystalByTokenId.get(p.matchedV3TokenId);
    if (!k) continue;

    const fields: KrystalDivergence["fields"] = [];
    const details: KrystalDivergence["details"] = {};

    if (isDivergent(p.currentUsd, k.currentUsd)) {
      fields.push("currentUsd");
      details.currentUsd = diffDetail(p.currentUsd, k.currentUsd);
    }
    const ourPending = p.feesUsd ?? 0;
    if (isDivergent(ourPending, k.pendingFeeUsd)) {
      fields.push("pendingFeeUsd");
      details.pendingFeeUsd = diffDetail(ourPending, k.pendingFeeUsd);
    }
    if (isDivergent(p.feesClaimedUsd, k.claimedFeeUsd)) {
      fields.push("feesClaimedUsd");
      details.feesClaimedUsd = diffDetail(p.feesClaimedUsd, k.claimedFeeUsd);
    }
    if (fields.length === 0) continue;

    out.push({
      posId: p.id,
      matchedV3TokenId: p.matchedV3TokenId,
      fields,
      details,
    });
  }
  return out;
}

/**
 * UX helper: вывести divergences через `console.warn` в одну строку
 * per position с компактным breakdown. Безопасно вызывать каждый render
 * (no-op если массив пустой).
 */
export function logKrystalDivergences(divergences: KrystalDivergence[]): void {
  if (divergences.length === 0 || typeof window === "undefined") return;
  for (const d of divergences) {
    const parts: string[] = [];
    for (const f of d.fields) {
      const dt = d.details[f];
      if (!dt) continue;
      parts.push(
        `${f}: cap=$${dt.capflow.toFixed(2)} vs krystal=$${dt.krystal.toFixed(2)} (Δ=${dt.diff >= 0 ? "+" : ""}$${dt.diff.toFixed(2)}, ${dt.pct >= 0 ? "+" : ""}${dt.pct.toFixed(1)}%)`,
      );
    }
    console.warn(
      `[Krystal cross-validate] ${d.posId} (NFT #${d.matchedV3TokenId}): ${parts.join(" | ")}`,
    );
  }
}
