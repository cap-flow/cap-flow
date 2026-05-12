/**
 * Cost-basis computation from the user-entered `operations` ledger.
 *
 * NOT a port of the chain-classifier-based tracker (apps/web/src/lib/
 * portfolio/cost_basis_tracker.ts) — that one operates on
 * `ClassifiedOp` rows produced by on-chain decoding, which depends on
 * the full protocol/junk/role pipeline. Porting that pipeline is a
 * separate, much larger slice (would land as Phase 5).
 *
 * Here we use the much simpler input the server already has: rows from
 * the `operations` table where the user has explicitly recorded
 * `(type, cur1, amount1, cur2, amount2, price_usd)`. We compute a
 * weighted-average cost basis per `cur1` symbol using the same
 * cumulative formula:
 *
 *   avg = Σ paid_usd / Σ bought_amount
 *
 * Inputs (one `OperationRow`):
 *   buy   :  bought `amount1` of `cur1` for `amount2` of `cur2` (or
 *            `price_usd` per unit if `cur2` is unset)
 *   sell  :  sold `amount1` of `cur1` for `amount2` of `cur2` → consume
 *   swap  :  if `cur2` is a stable, treat like a buy of `cur1`; if `cur1`
 *            is a stable, treat like a sell of `cur2`; otherwise crossed
 *            (consume out, no avg update on in)
 *   deposit/withdraw/transfer/fee/etc. : ignored for cost basis.
 *
 * Cumulative semantics: spend operations don't reset paid_usd. This
 * matches the frontend tracker's "Σ всех заплаченных стейблов / Σ всех
 * купленных amount" model.
 */

const STABLE_SYMBOLS = new Set([
  "USDT",
  "USDC",
  "DAI",
  "BUSD",
  "TUSD",
  "USDP",
  "FRAX",
  "LUSD",
  "USDD",
  "GUSD",
  "USDC.E",
]);

export function isStableSymbol(sym: string | null | undefined): boolean {
  if (!sym) return false;
  return STABLE_SYMBOLS.has(sym.toUpperCase().trim());
}

function normalizeSymbol(s: string): string {
  const u = s.toUpperCase().trim();
  if (u === "WETH") return "ETH";
  return u;
}

/** Safe numeric parse — Drizzle returns `numeric` as strings. */
function num(v: string | null | undefined): number {
  if (v == null || v === "") return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export interface CostBasisInputOp {
  readonly date: string; // YYYY-MM-DD
  readonly type: string;
  readonly cur1: string | null;
  readonly amount1: string | null;
  readonly cur2: string | null;
  readonly amount2: string | null;
  readonly priceUsd: string | null;
}

export interface SymbolCostBasis {
  readonly symbol: string;
  readonly avgUsd: number;
  readonly totalBoughtAmount: number;
  readonly totalPaidUsd: number;
  readonly runningAmount: number;
  readonly lastUpdate: string | null; // YYYY-MM-DD
}

interface MutAccum {
  symbol: string;
  totalBought: number;
  totalPaid: number;
  running: number;
  lastUpdate: string | null;
}

function getOrInit(map: Map<string, MutAccum>, sym: string): MutAccum {
  const existing = map.get(sym);
  if (existing) return existing;
  const fresh: MutAccum = {
    symbol: sym,
    totalBought: 0,
    totalPaid: 0,
    running: 0,
    lastUpdate: null,
  };
  map.set(sym, fresh);
  return fresh;
}

/** Resolve USD paid for a buy: prefer cur2-stable*amount2, else price_usd*amount1. */
function paidUsdFor(op: CostBasisInputOp, amount1: number): number {
  const amount2 = num(op.amount2);
  if (op.cur2 && isStableSymbol(op.cur2) && amount2 > 0) {
    return amount2;
  }
  const pu = num(op.priceUsd);
  if (pu > 0 && amount1 > 0) return pu * amount1;
  return 0;
}

export function computeCostBasis(
  ops: readonly CostBasisInputOp[]
): SymbolCostBasis[] {
  const acc = new Map<string, MutAccum>();
  // Sort by date asc (replay chronologically). Stable sort preserves insertion
  // order on ties — repo layer is expected to provide (date, createdAt) order.
  const sorted = [...ops].sort((a, b) => a.date.localeCompare(b.date));

  for (const op of sorted) {
    const t = op.type;

    if (t === "buy") {
      if (!op.cur1) continue;
      const amount1 = num(op.amount1);
      if (amount1 <= 0) continue;
      const paid = paidUsdFor(op, amount1);
      if (paid <= 0) continue;
      const sym = normalizeSymbol(op.cur1);
      const a = getOrInit(acc, sym);
      a.totalBought += amount1;
      a.totalPaid += paid;
      a.running += amount1;
      a.lastUpdate = op.date;
      continue;
    }

    if (t === "sell") {
      if (!op.cur1) continue;
      const amount1 = num(op.amount1);
      if (amount1 <= 0) continue;
      const sym = normalizeSymbol(op.cur1);
      const a = getOrInit(acc, sym);
      a.running -= amount1;
      a.lastUpdate = op.date;
      continue;
    }

    if (t === "swap") {
      // cur1=in, cur2=out (user-side convention in the legacy ledger).
      const amount1 = num(op.amount1);
      const amount2 = num(op.amount2);
      if (op.cur2 && isStableSymbol(op.cur2) && op.cur1 && amount1 > 0 && amount2 > 0) {
        // Stable → asset: treat as buy of cur1.
        const sym = normalizeSymbol(op.cur1);
        const a = getOrInit(acc, sym);
        a.totalBought += amount1;
        a.totalPaid += amount2;
        a.running += amount1;
        a.lastUpdate = op.date;
        continue;
      }
      if (op.cur1 && isStableSymbol(op.cur1) && op.cur2 && amount2 > 0) {
        // Asset → stable: sell of cur2.
        const sym = normalizeSymbol(op.cur2);
        const a = getOrInit(acc, sym);
        a.running -= amount2;
        a.lastUpdate = op.date;
        continue;
      }
      // Crossed swap (asset → asset). Consume the out side; we don't
      // synthesize a fresh cost-basis for the in side (would require a
      // hist-price lookup, which is Phase 4d wiring).
      if (op.cur2 && amount2 > 0) {
        const sym = normalizeSymbol(op.cur2);
        const a = getOrInit(acc, sym);
        a.running -= amount2;
        a.lastUpdate = op.date;
      }
      continue;
    }

    if (t === "transfer" || t === "withdraw" || t === "fee") {
      // Outflow without realising PnL — only adjusts running balance.
      if (!op.cur1) continue;
      const amount1 = num(op.amount1);
      if (amount1 <= 0) continue;
      const sym = normalizeSymbol(op.cur1);
      const a = getOrInit(acc, sym);
      a.running -= amount1;
      a.lastUpdate = op.date;
      continue;
    }

    if (t === "deposit") {
      // Inflow without a buy event (e.g. funding wallet). Treat like a
      // running-only credit; cost basis is unknown here.
      if (!op.cur1) continue;
      const amount1 = num(op.amount1);
      if (amount1 <= 0) continue;
      const sym = normalizeSymbol(op.cur1);
      const a = getOrInit(acc, sym);
      a.running += amount1;
      a.lastUpdate = op.date;
      continue;
    }
    // open/close/loan*/div/other — out of scope for the simple ledger
    // tracker. Position-level cost basis (open=lock, close=realise) is
    // covered by `position_meta` joins, which is Phase 5 territory.
  }

  const out: SymbolCostBasis[] = [];
  for (const a of acc.values()) {
    const avg = a.totalBought > 0 ? a.totalPaid / a.totalBought : 0;
    out.push({
      symbol: a.symbol,
      avgUsd: avg,
      totalBoughtAmount: a.totalBought,
      totalPaidUsd: a.totalPaid,
      runningAmount: a.running,
      lastUpdate: a.lastUpdate,
    });
  }
  return out.sort((a, b) => a.symbol.localeCompare(b.symbol));
}
