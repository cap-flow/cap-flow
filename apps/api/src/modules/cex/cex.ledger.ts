/**
 * UCB B4: CCXT `fetchLedger` normalization — master record of all
 * balance-affecting entries на бирже.
 *
 * fetchLedger возвращает comprehensive stream:
 *   - trades (spot/futures fills)
 *   - deposits + withdrawals (transactions)
 *   - internal transfers (sub-account, spot↔funding)
 *   - fees (separate entries, not just trade.fee)
 *   - rebates / cashback (maker fees, referral bonuses)
 *   - interest / staking rewards (earn products)
 *   - funding rates (perp positions)
 *
 * Зачем отдельная нормализация (вместо использования только
 * fetchMyTrades + fetchDeposits): некоторые типы income/expense ЕСТЬ
 * только в ledger (e.g. staking rewards, interest, fee rebates).
 * Без ledger UCB cost basis может пропускать значимые движения капитала.
 *
 * Storage: `cex_ledger` table. Idempotent через unique
 * (cex_account_id, exchange_entry_id).
 *
 * Types normalization:
 *   CCXT type → our type
 *   - "trade"        → trade
 *   - "transaction"  → deposit (if direction=in) | withdrawal (out)
 *   - "transfer"     → transfer
 *   - "fee"          → fee
 *   - "rebate" | "cashback" → rebate
 *   - "interest"     → interest
 *   - "staking" | "yield" → staking
 *   - "funding"      → funding (perp funding rate)
 *   - other          → other
 */

export type CexLedgerType =
  | "trade"
  | "deposit"
  | "withdrawal"
  | "transfer"
  | "fee"
  | "rebate"
  | "interest"
  | "staking"
  | "funding"
  | "other";

export interface CexLedgerLine {
  readonly exchangeEntryId: string;
  readonly account: string | null;
  readonly asset: string;
  /** Always positive. Sign captured in `direction`. */
  readonly amount: number;
  readonly direction: "in" | "out";
  readonly type: CexLedgerType;
  /** Linking ID — order_id, transfer_id, deposit_id. */
  readonly referenceId: string | null;
  readonly feeAmount: number | null;
  readonly feeCurrency: string | null;
  readonly status: string;
  readonly executedAtMs: number;
  /** Raw CCXT entry — для debugging / re-classify. */
  readonly raw: unknown;
}

interface CcxtLedgerRaw {
  readonly id?: string;
  readonly timestamp?: number | string;
  readonly datetime?: string;
  readonly direction?: "in" | "out";
  readonly account?: string;
  readonly referenceId?: string;
  readonly referenceAccount?: string;
  readonly type?: string;
  readonly currency?: string;
  readonly code?: string;
  readonly amount?: number | string;
  readonly status?: string;
  readonly fee?: { cost?: number | string; currency?: string };
  readonly info?: unknown;
}

function toNum(v: unknown): number {
  if (v === null || v === undefined) return NaN;
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : NaN;
  }
  return NaN;
}

function classifyType(
  rawType: string | undefined,
  direction: "in" | "out",
): CexLedgerType {
  const t = (rawType ?? "").toLowerCase().trim();
  switch (t) {
    case "trade":
    case "spot_trade":
    case "futures_trade":
      return "trade";
    case "transaction":
    case "deposit":
      return direction === "in" ? "deposit" : "withdrawal";
    case "withdrawal":
    case "withdraw":
      return "withdrawal";
    case "transfer":
    case "internal_transfer":
      return "transfer";
    case "fee":
    case "trading_fee":
      return "fee";
    case "rebate":
    case "cashback":
    case "referral":
      return "rebate";
    case "interest":
    case "lending_interest":
    case "borrow_interest":
      return "interest";
    case "staking":
    case "staking_reward":
    case "yield":
    case "savings":
      return "staking";
    case "funding":
    case "funding_fee":
    case "funding_rate":
      return "funding";
    default:
      return "other";
  }
}

/**
 * Нормализует array CCXT ledger entries в `CexLedgerLine[]`.
 *
 * Skip rules:
 *   - missing/empty id
 *   - missing currency (asset)
 *   - amount == 0 или NaN
 *   - missing timestamp AND datetime
 *
 * Direction derivation:
 *   - explicit `direction` field (preferred)
 *   - fallback: `amount > 0 → in`, `amount < 0 → out`
 */
export function normalizeCcxtLedger(entries: unknown[]): CexLedgerLine[] {
  const out: CexLedgerLine[] = [];
  for (const raw of entries) {
    if (!raw || typeof raw !== "object") continue;
    const e = raw as CcxtLedgerRaw;

    const id = (e.id ?? "").toString().trim();
    if (!id) continue;

    const asset = (e.currency ?? e.code ?? "").toString().trim().toUpperCase();
    if (!asset) continue;

    const rawAmt = toNum(e.amount);
    if (!Number.isFinite(rawAmt) || rawAmt === 0) continue;

    // Direction: prefer explicit, fall back to amount sign
    let direction: "in" | "out";
    if (e.direction === "in" || e.direction === "out") {
      direction = e.direction;
    } else {
      direction = rawAmt > 0 ? "in" : "out";
    }

    const amount = Math.abs(rawAmt);
    const type = classifyType(e.type, direction);

    // Timestamp: prefer ms, fall back to datetime
    let executedAtMs: number;
    if (typeof e.timestamp === "number") {
      executedAtMs = e.timestamp;
    } else if (typeof e.timestamp === "string") {
      executedAtMs = Number(e.timestamp);
    } else if (e.datetime) {
      executedAtMs = new Date(e.datetime).getTime();
    } else {
      continue;
    }
    if (!Number.isFinite(executedAtMs)) continue;

    const feeCost = e.fee?.cost != null ? toNum(e.fee.cost) : NaN;
    const feeAmount = Number.isFinite(feeCost) && feeCost > 0 ? feeCost : null;
    const feeCurrency = feeAmount != null && e.fee?.currency
      ? e.fee.currency.toString().toUpperCase()
      : null;

    out.push({
      exchangeEntryId: id,
      account: e.account ? e.account.toString() : null,
      asset,
      amount,
      direction,
      type,
      referenceId: e.referenceId ? e.referenceId.toString() : null,
      feeAmount,
      feeCurrency,
      status: (e.status ?? "ok").toString(),
      executedAtMs,
      raw: e.info ?? e,
    });
  }
  return out;
}
