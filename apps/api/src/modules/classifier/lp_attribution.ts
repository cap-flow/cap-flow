/**
 * LP close attribution — server port of `attributeLpCloses` /
 * `computeLpCloseAttribution` from
 * `apps/web/src/lib/portfolio/cost_basis_tracker.ts` (P5.5).
 *
 * Distributes the USD value of `lp_add` deposits across subsequent
 * `lp_remove` closes within the same `(protocolId, chain)` group:
 *
 *   - depositUsd = Σ USD-cost of all out-side movements in lp_add's
 *   - closeUsd_i = Σ USD-value of in-side movements in lp_remove #i
 *   - attribution(close_i) = depositUsd × (closeUsd_i / Σ closeUsd_*)
 *   - per-symbol split inside a close = closeUsd_i × (m.usd / closeUsd_i)
 *
 * Failed and junk-tagged ops are skipped. WETH is normalized to ETH so
 * the resulting per-symbol map merges wrapped/native pairs.
 */

import { isJunkOp } from "./junk_filter.js";
import { isStableSymbol } from "./protocols.js";
import { defillamaCoinKey, priceFromMap } from "./defillama_keys.js";
import type { ClassifiedOp, TokenMovement } from "./types.js";

export interface LpCloseAttribution {
  readonly amount: number;
  readonly costUsd: number;
}

function normalizeSymbol(s: string): string {
  const u = s.toUpperCase();
  if (u === "WETH") return "ETH";
  return u;
}

/**
 * Resolve a movement's USD value using (in order):
 *   1. $1 × amount when the symbol is a known USD-stable
 *   2. DefiLlama historical price by `(chain, tokenId, symbol)` + time
 *   3. fallback to `m.usd` from the upstream provider (current spot)
 *   4. 0 — better to skip than to invent a number
 */
function movementUsd(
  m: TokenMovement,
  chain: string,
  time: number,
  histPrices: Map<string, number>
): number {
  if (m.amount <= 0) return 0;
  if (isStableSymbol(m.symbol)) return m.amount;
  const coin = defillamaCoinKey(chain, m.tokenId, m.symbol);
  if (coin) {
    const hp = priceFromMap(histPrices, coin, time);
    if (hp != null && hp > 0) return m.amount * hp;
  }
  if (m.usd != null && m.usd > 0) return m.usd;
  return 0;
}

interface CloseInfo {
  hash: string;
  time: number;
  ins: { symbol: string; amount: number; usd: number }[];
  totalUsd: number;
}

interface Group {
  depositUsd: number;
  closes: CloseInfo[];
}

function attributeLpCloses(
  sortedOps: ClassifiedOp[],
  histPrices: Map<string, number>
): Map<string, Map<string, LpCloseAttribution>> {
  const groups = new Map<string, Group>();

  function keyForOp(op: ClassifiedOp): string | null {
    if (!op.protocol) return null;
    return `${op.protocol.id}|${op.chain}`;
  }

  for (const op of sortedOps) {
    if (op.status === "failed") continue;
    if (isJunkOp(op)) continue;

    if (op.type === "lp_add") {
      const key = keyForOp(op);
      if (!key) continue;
      const usd = op.movement
        .filter((m) => m.direction === "out" && m.amount > 0)
        .reduce(
          (s, m) => s + movementUsd(m, op.chain, op.time, histPrices),
          0
        );
      if (usd <= 0) continue;
      let g = groups.get(key);
      if (!g) {
        g = { depositUsd: 0, closes: [] };
        groups.set(key, g);
      }
      g.depositUsd += usd;
      continue;
    }

    if (op.type === "lp_remove") {
      const key = keyForOp(op);
      if (!key) continue;
      const insRaw = op.movement.filter(
        (m) => m.direction === "in" && m.amount > 0
      );
      if (insRaw.length === 0) continue;
      const ins = insRaw.map((m) => ({
        symbol: m.symbol,
        amount: m.amount,
        usd: movementUsd(m, op.chain, op.time, histPrices),
      }));
      const totalUsd = ins.reduce((s, m) => s + m.usd, 0);
      let g = groups.get(key);
      if (!g) {
        g = { depositUsd: 0, closes: [] };
        groups.set(key, g);
      }
      g.closes.push({ hash: op.hash, time: op.time, ins, totalUsd });
    }
  }

  const out = new Map<string, Map<string, LpCloseAttribution>>();
  for (const g of groups.values()) {
    if (g.depositUsd <= 0 || g.closes.length === 0) continue;
    const sumCloseUsd = g.closes.reduce((s, c) => s + c.totalUsd, 0);
    for (const c of g.closes) {
      const share =
        sumCloseUsd > 0 ? c.totalUsd / sumCloseUsd : 1 / g.closes.length;
      const attributedUsd = g.depositUsd * share;
      const perSymbol = new Map<string, LpCloseAttribution>();
      for (const m of c.ins) {
        const tokenShare =
          c.totalUsd > 0 ? m.usd / c.totalUsd : 1 / c.ins.length;
        const cost = attributedUsd * tokenShare;
        const sym = normalizeSymbol(m.symbol);
        const prev = perSymbol.get(sym);
        if (prev) {
          perSymbol.set(sym, {
            amount: prev.amount + m.amount,
            costUsd: prev.costUsd + cost,
          });
        } else {
          perSymbol.set(sym, { amount: m.amount, costUsd: cost });
        }
      }
      out.set(c.hash, perSymbol);
    }
  }
  return out;
}

/**
 * Public entry: sort ops by time and run LP-close attribution. Returns
 * `Map<lp_remove.hash, Map<symbol, {amount, costUsd}>>`.
 */
export function computeLpCloseAttribution(
  ops: ClassifiedOp[],
  histPrices: Map<string, number> = new Map()
): Map<string, Map<string, LpCloseAttribution>> {
  const sorted = [...ops].sort((a, b) => a.time - b.time);
  return attributeLpCloses(sorted, histPrices);
}
