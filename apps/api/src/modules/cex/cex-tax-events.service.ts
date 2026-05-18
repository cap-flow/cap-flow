/**
 * Tax T4: CEX-side tax events generator.
 *
 * Walks p2p + trades + transfers chronologically с собственным pool
 * tracker (WAC). Emit'ит TaxEvent для каждой disposition:
 *   - P2P sell crypto → fiat: 'sale' event.
 *   - Trade non-stable base → stable quote (sell): 'sale'.
 *   - Trade base → non-stable quote (sell): 'exchange' (token-to-token).
 *   - Trade buy / P2P buy / deposit: acquisition, no event.
 *
 * Pool methodology — WAC: каждый дисposed amount берёт cost через
 * running average. FIFO/LIFO/HIFO для CEX-side в backlog T4.1.
 *
 * Не интегрирует deposit seeds (C1) — CEX side полностью server-side
 * trail. Withdrawals тоже не emit events: они = move, реализация ловится
 * либо on-chain (если withdraw на свой wallet), либо в P2P sell stage.
 */
import { isStableSymbol as isStable } from "../classifier/protocols.js";
import { tokenFamily } from "../chain-ops/internal-transfer-matcher.js";

import type { CexAccountRow, CexP2pOrderRow, CexRepository, CexTradeRow } from "./cex.repository.js";

const DAY_SEC = 24 * 60 * 60;
const LONG_TERM_THRESHOLD_DAYS = 365;

export type CexTaxEventType = "sale" | "exchange" | "income";
export type CexTaxTerm = "short" | "long";

export interface CexTaxEvent {
  readonly cexAccountId: string;
  readonly exchange: string;
  readonly label: string | null;
  readonly disposedAt: Date;
  readonly acquiredAt: Date;
  readonly holdingPeriodDays: number;
  readonly term: CexTaxTerm;
  readonly eventType: CexTaxEventType;
  readonly asset: string;
  readonly assetFamily: string;
  readonly amount: number;
  readonly proceedsUsd: number;
  readonly costBasisUsd: number;
  readonly gainUsd: number;
  readonly source: "p2p" | "trade";
  readonly sourceId: string;
}

interface PoolState {
  totalAmount: number;
  totalCostUsd: number;
  // Earliest acquisition for holding-period estimate. CEX-side WAC
  // doesn't track per-lot — use first acquisition as approximation.
  firstAcquiredAt: Date | null;
}

function newPool(): PoolState {
  return { totalAmount: 0, totalCostUsd: 0, firstAcquiredAt: null };
}

function add(
  pools: Map<string, PoolState>,
  asset: string,
  amount: number,
  costUsd: number,
  at: Date,
): void {
  const p = pools.get(asset) ?? newPool();
  p.totalAmount += amount;
  p.totalCostUsd += costUsd;
  if (!p.firstAcquiredAt || at < p.firstAcquiredAt) {
    p.firstAcquiredAt = at;
  }
  pools.set(asset, p);
}

interface ConsumeResult {
  costUsd: number;
  acquiredAt: Date | null;
}

function consume(
  pools: Map<string, PoolState>,
  asset: string,
  amount: number,
): ConsumeResult {
  const p = pools.get(asset);
  if (!p || p.totalAmount <= 0) {
    return { costUsd: 0, acquiredAt: null };
  }
  const fraction = Math.min(1, amount / p.totalAmount);
  const costUsd = p.totalCostUsd * fraction;
  const acquiredAt = p.firstAcquiredAt;
  p.totalAmount -= amount;
  p.totalCostUsd -= costUsd;
  if (p.totalAmount <= 1e-12) {
    pools.delete(asset);
  }
  return { costUsd, acquiredAt };
}

function computeTerm(
  acquiredAt: Date | null,
  disposedAt: Date,
): { holdingPeriodDays: number; term: CexTaxTerm; acquiredAt: Date } {
  const acq = acquiredAt ?? disposedAt;
  const days = Math.max(
    0,
    Math.floor((disposedAt.getTime() - acq.getTime()) / 1000 / DAY_SEC),
  );
  return {
    holdingPeriodDays: days,
    term: days >= LONG_TERM_THRESHOLD_DAYS ? "long" : "short",
    acquiredAt: acq,
  };
}

type Event =
  | { kind: "p2p"; ts: number; row: CexP2pOrderRow }
  | { kind: "trade"; ts: number; row: CexTradeRow };

export class CexTaxEventsService {
  constructor(private readonly cexRepo: CexRepository) {}

  async generateForUser(userId: string): Promise<CexTaxEvent[]> {
    const accounts = await this.cexRepo.listActiveForUser(userId);
    const out: CexTaxEvent[] = [];
    for (const acc of accounts) {
      const events = await this.generateForAccount(acc);
      out.push(...events);
    }
    return out.sort(
      (a, b) => a.disposedAt.getTime() - b.disposedAt.getTime(),
    );
  }

  private async generateForAccount(
    acc: CexAccountRow,
  ): Promise<CexTaxEvent[]> {
    const [p2p, trades] = await Promise.all([
      this.cexRepo.listP2pOrdersForAccountAsc(acc.id),
      this.cexRepo.listTradesForAccount(acc.id),
    ]);

    const events: Event[] = [
      ...p2p.map((r): Event => ({ kind: "p2p", ts: r.executedAt.getTime(), row: r })),
      ...trades.map((r): Event => ({ kind: "trade", ts: r.executedAt.getTime(), row: r })),
    ].sort((a, b) => a.ts - b.ts);

    const pools = new Map<string, PoolState>();
    const out: CexTaxEvent[] = [];

    for (const ev of events) {
      if (ev.kind === "p2p") {
        this.applyP2p(pools, ev.row, acc, out);
      } else {
        this.applyTrade(pools, ev.row, acc, out);
      }
    }
    return out;
  }

  private applyP2p(
    pools: Map<string, PoolState>,
    r: CexP2pOrderRow,
    acc: CexAccountRow,
    out: CexTaxEvent[],
  ): void {
    const asset = r.asset.toUpperCase();
    const amount = Number(r.amount);
    if (!Number.isFinite(amount) || amount <= 0) return;

    if (r.side === "buy") {
      // Acquisition. Cost = fiatAmount если есть.
      const cost = r.fiatAmount ? Number(r.fiatAmount) : 0;
      add(pools, asset, amount, cost, r.executedAt);
    } else if (r.side === "sell") {
      // Disposition: sale event. Proceeds = fiatAmount.
      const proceeds = r.fiatAmount ? Number(r.fiatAmount) : 0;
      const { costUsd, acquiredAt } = consume(pools, asset, amount);
      const term = computeTerm(acquiredAt, r.executedAt);
      out.push({
        cexAccountId: acc.id,
        exchange: acc.exchange,
        label: acc.label,
        disposedAt: r.executedAt,
        acquiredAt: term.acquiredAt,
        holdingPeriodDays: term.holdingPeriodDays,
        term: term.term,
        eventType: "sale",
        asset,
        assetFamily: tokenFamily(asset),
        amount,
        proceedsUsd: proceeds,
        costBasisUsd: costUsd,
        gainUsd: proceeds - costUsd,
        source: "p2p",
        sourceId: r.id,
      });
    }
  }

  private applyTrade(
    pools: Map<string, PoolState>,
    t: CexTradeRow,
    acc: CexAccountRow,
    out: CexTaxEvent[],
  ): void {
    const parts = t.symbol.split("/");
    if (parts.length !== 2) return;
    const [baseRaw, quoteRaw] = parts;
    if (!baseRaw || !quoteRaw) return;
    const base = baseRaw.toUpperCase();
    const quote = quoteRaw.toUpperCase();
    const baseAmount = Number(t.amount);
    const quoteAmount = Number(t.cost);
    if (!Number.isFinite(baseAmount) || baseAmount <= 0) return;
    if (!Number.isFinite(quoteAmount) || quoteAmount <= 0) return;

    if (t.side === "buy") {
      // Bought BASE for QUOTE. Pull cost из quote pool, push to base.
      const { costUsd: removedCost } = consume(pools, quote, quoteAmount);
      const seedCost =
        removedCost > 0
          ? removedCost
          : isStable(quote)
            ? quoteAmount
            : 0;
      add(pools, base, baseAmount, seedCost, t.executedAt);
    } else if (t.side === "sell") {
      // Sold BASE. Proceeds зависит от quote:
      //   stable quote → 'sale' event с proceedsUsd ≈ quoteAmount
      //   non-stable quote → 'exchange' event, proceeds = market USD of out
      //     (approximate via running pool of quote later — для v1 use
      //     quoteAmount × 0 fallback, OR попробуем consume и use cost)
      const { costUsd, acquiredAt } = consume(pools, base, baseAmount);
      const term = computeTerm(acquiredAt, t.executedAt);
      const isQuoteStable = isStable(quote);
      let proceedsUsd = 0;
      let eventType: CexTaxEventType = "exchange";
      if (isQuoteStable) {
        proceedsUsd = quoteAmount;
        eventType = "sale";
      } else {
        // Non-stable quote: proceedsUsd unknown точно. Approximate как
        // remaining-pool WAC × quoteAmount (best-effort). Если pool пуст,
        // proceeds = 0 (фиксируется как loss/even).
        const qp = pools.get(quote);
        if (qp && qp.totalAmount > 0) {
          const wac = qp.totalCostUsd / qp.totalAmount;
          proceedsUsd = wac * quoteAmount;
        }
        eventType = "exchange";
      }
      // Acquire quote-side с cost = proceedsUsd (carries forward).
      add(
        pools,
        quote,
        quoteAmount,
        proceedsUsd > 0 ? proceedsUsd : isQuoteStable ? quoteAmount : 0,
        t.executedAt,
      );
      out.push({
        cexAccountId: acc.id,
        exchange: acc.exchange,
        label: acc.label,
        disposedAt: t.executedAt,
        acquiredAt: term.acquiredAt,
        holdingPeriodDays: term.holdingPeriodDays,
        term: term.term,
        eventType,
        asset: base,
        assetFamily: tokenFamily(base),
        amount: baseAmount,
        proceedsUsd,
        costBasisUsd: costUsd,
        gainUsd: proceedsUsd - costUsd,
        source: "trade",
        sourceId: t.id,
      });
    }
  }
}
