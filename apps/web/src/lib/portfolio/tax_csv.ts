/**
 * Tax T2: CSV exporter для TaxEvent[].
 *
 * RFC 4180-compliant: fields с commas/quotes/newlines → quoted, кавычки
 * внутри → escaped двойной кавычкой. ISO 8601 UTC timestamps. USD = 2
 * decimals, amount = 8 decimals (универсальная precision; больше не
 * нужно — даже WBTC округление под 8 это уже satoshi).
 *
 * Format: capflow-native columns, легко импортируется в Koinly/CoinTracker
 * через custom CSV mapping.
 */
import type { TaxEvent } from "./tax_events";

const HEADERS = [
  "date_iso",
  "event_type",
  "asset",
  "asset_family",
  "amount",
  "proceeds_usd",
  "cost_basis_usd",
  "gain_usd",
  "term",
  "holding_period_days",
  "acquired_at_iso",
  "tx_hash",
  "chain",
  "source_hash",
  "wallet_id",
] as const;

function quote(s: string): string {
  // Любое поле с запятой / кавычкой / новой строкой → quoted.
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function toIso(unixSec: number): string {
  return new Date(unixSec * 1000).toISOString();
}

function fmtUsd(n: number): string {
  // toFixed(2) round to nearest cent.
  return n.toFixed(2);
}

function fmtAmount(n: number): string {
  // 8 decimals — satoshi precision хватает для любых tokens; trailing
  // zeros для CSV consistency.
  return n.toFixed(8);
}

export function exportTaxEventsToCsv(events: readonly TaxEvent[]): string {
  const lines: string[] = [HEADERS.join(",")];
  for (const e of events) {
    const row = [
      toIso(e.disposedAt),
      e.eventType,
      e.asset,
      e.assetFamily,
      fmtAmount(e.amount),
      fmtUsd(e.proceedsUsd),
      fmtUsd(e.costBasisUsd),
      fmtUsd(e.gainUsd),
      e.term,
      String(e.holdingPeriodDays),
      toIso(e.acquiredAt),
      e.txHash,
      e.chain,
      e.sourceHash,
      e.walletId,
    ].map(quote);
    lines.push(row.join(","));
  }
  return lines.join("\n");
}

// ─── aggregate helpers (для UI summary card) ───────────────────────────

export interface TaxSummary {
  readonly totalEvents: number;
  readonly shortTermGain: number;
  readonly longTermGain: number;
  readonly incomeUsd: number; // Σ FMV at receipt (rewards)
  readonly totalProceeds: number;
  readonly totalCostBasis: number;
  readonly netGain: number;
}

export function summarizeTaxEvents(
  events: readonly TaxEvent[],
): TaxSummary {
  let shortTermGain = 0;
  let longTermGain = 0;
  let incomeUsd = 0;
  let totalProceeds = 0;
  let totalCostBasis = 0;
  for (const e of events) {
    totalProceeds += e.proceedsUsd;
    totalCostBasis += e.costBasisUsd;
    if (e.eventType === "income") {
      incomeUsd += e.proceedsUsd;
    } else if (e.term === "long") {
      longTermGain += e.gainUsd;
    } else {
      shortTermGain += e.gainUsd;
    }
  }
  return {
    totalEvents: events.length,
    shortTermGain,
    longTermGain,
    incomeUsd,
    totalProceeds,
    totalCostBasis,
    netGain: shortTermGain + longTermGain,
  };
}
