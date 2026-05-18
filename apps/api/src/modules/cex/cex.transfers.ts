/**
 * Normalization helpers for CCXT deposit/withdrawal records.
 *
 * CCXT exposes a unified `fetchDeposits()` / `fetchWithdrawals()` shape
 * across exchanges — far cleaner than P2P. Each entry has roughly:
 *
 *   {
 *     id:        exchange-side transfer id          (always present)
 *     txid:      on-chain hash                       (set once mined)
 *     type:      "deposit" | "withdrawal"            (set by CCXT)
 *     currency:  asset code                          ("ETH", "USDT", …)
 *     amount:    decimal                             (in `currency` units)
 *     address:   destination (for withdrawal) /
 *                source      (for deposit)
 *     network:   chain code                          ("ETH", "ARBITRUM" …)
 *     fee:       { cost: number, currency: string }
 *     status:    "ok" | "pending" | "failed" | "canceled"
 *     timestamp: ms-since-epoch
 *   }
 *
 * The exact field set varies slightly per exchange — we accept several
 * synonyms (txid vs hash, fee object vs flat number) and skip rows
 * that can't be normalized.
 */

export interface CexTransferLine {
  readonly id: string;
  readonly direction: "deposit" | "withdrawal";
  readonly asset: string;
  readonly amount: number;
  readonly feeAmount: number | null;
  readonly feeCurrency: string | null;
  readonly network: string | null;
  readonly address: string | null;
  readonly txHash: string | null;
  readonly status: string;
  readonly executedAtMs: number;
}

interface CcxtTransferRaw {
  readonly id?: string;
  readonly txid?: string;
  readonly hash?: string;
  readonly type?: string;
  readonly currency?: string;
  readonly code?: string;
  readonly amount?: string | number;
  readonly address?: string;
  readonly addressTo?: string;
  readonly addressFrom?: string;
  readonly network?: string;
  readonly chain?: string;
  readonly fee?:
    | { cost?: string | number; currency?: string }
    | string
    | number;
  readonly status?: string;
  readonly timestamp?: string | number;
  readonly datetime?: string;
}

export function normalizeCcxtTransfer(
  raw: CcxtTransferRaw,
  fallbackDirection?: "deposit" | "withdrawal"
): CexTransferLine | null {
  const id = raw.id ?? raw.txid ?? raw.hash;
  if (!id) return null;

  // type field from CCXT. Some exchanges (Bitget v2) omit it from
  // individual rows when the caller already specified deposits vs.
  // withdrawals — that's why we accept a fallback hint.
  const rawType = (raw.type ?? "").toString().toLowerCase();
  let direction: "deposit" | "withdrawal";
  if (rawType === "deposit") direction = "deposit";
  else if (rawType === "withdrawal" || rawType === "withdraw")
    direction = "withdrawal";
  else if (fallbackDirection) direction = fallbackDirection;
  else return null;

  const asset = (raw.currency ?? raw.code ?? "").toString().toUpperCase();
  if (!asset) return null;

  const amount = toNum(raw.amount);
  if (!isFinite(amount) || amount <= 0) return null;

  const ts = toNum(raw.timestamp);
  if (!isFinite(ts) || ts <= 0) {
    // Fall back to parsing ISO datetime if `timestamp` was absent.
    const fromIso = raw.datetime ? Date.parse(raw.datetime) : NaN;
    if (!isFinite(fromIso) || fromIso <= 0) return null;
    return makeLine(id, direction, asset, amount, raw, fromIso);
  }
  return makeLine(id, direction, asset, amount, raw, ts);
}

function makeLine(
  id: string,
  direction: "deposit" | "withdrawal",
  asset: string,
  amount: number,
  raw: CcxtTransferRaw,
  ts: number
): CexTransferLine {
  // Fee: prefer the object form `{ cost, currency }`. Some exchanges
  // return a flat number — assume it's denominated in `asset`.
  let feeAmount: number | null = null;
  let feeCurrency: string | null = null;
  if (raw.fee && typeof raw.fee === "object") {
    const f = raw.fee as { cost?: string | number; currency?: string };
    const n = toNum(f.cost);
    if (isFinite(n) && n > 0) {
      feeAmount = n;
      feeCurrency = (f.currency ?? asset).toString().toUpperCase();
    }
  } else if (typeof raw.fee === "number" || typeof raw.fee === "string") {
    const n = toNum(raw.fee);
    if (isFinite(n) && n > 0) {
      feeAmount = n;
      feeCurrency = asset;
    }
  }

  return {
    id: id,
    direction,
    asset,
    amount,
    feeAmount,
    feeCurrency,
    network: (raw.network ?? raw.chain ?? null)?.toString().toUpperCase() ?? null,
    // Withdrawal: `address` is the destination; deposit: it's the source.
    // CCXT keeps both forms — fall through.
    address: raw.address ?? raw.addressTo ?? raw.addressFrom ?? null,
    txHash: raw.txid ?? raw.hash ?? null,
    status: (raw.status ?? "unknown").toString().toLowerCase(),
    executedAtMs: ts,
  };
}

function toNum(v: string | number | undefined | null): number {
  if (v == null) return NaN;
  return typeof v === "number" ? v : parseFloat(v);
}
