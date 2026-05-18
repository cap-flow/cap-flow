/**
 * UCB B3: normalization helpers для CCXT `fetchTransfers` (internal
 * CEX transfers: Spot ↔ Funding ↔ Earn ↔ Sub-account).
 *
 * CCXT shape варьируется по exchange:
 *
 *   {
 *     id:        exchange-side transfer id
 *     timestamp: ms-since-epoch
 *     currency:  asset code
 *     amount:    decimal
 *     fromAccount: "spot" / "funding" / "earn" / "sub:<name>"
 *     toAccount:   ditto
 *     status:    "ok" | "pending" | "failed" | "canceled"
 *     info:      raw exchange-specific payload
 *   }
 *
 * Несколько exchanges (bingx, bitget) НЕ возвращают canonical CCXT shape
 * — приходится парсить из `info` (raw payload).
 */

export interface CexInternalTransferLine {
  readonly id: string;
  readonly asset: string;
  readonly amount: number;
  readonly fromAccount: string;
  readonly toAccount: string;
  readonly status: string;
  readonly executedAtMs: number;
  /** Сырой CCXT response — для debugging / re-classify. */
  readonly raw: unknown;
}

interface CcxtTransferRaw {
  readonly id?: string;
  readonly timestamp?: string | number;
  readonly datetime?: string;
  readonly currency?: string;
  readonly code?: string;
  readonly amount?: string | number;
  readonly fromAccount?: string;
  readonly toAccount?: string;
  readonly status?: string;
  readonly info?: Record<string, unknown>;
}

function toNum(v: string | number | undefined | null): number {
  if (v === undefined || v === null) return NaN;
  return typeof v === "string" ? Number(v) : v;
}

function normalizeAccountType(s: string | undefined): string {
  if (!s) return "unknown";
  const u = s.toLowerCase().trim();
  // Common aliases → canonical names. Sub-accounts (e.g. "sub-001")
  // оставляем как есть.
  if (u === "main" || u === "trade" || u === "trading") return "spot";
  if (u === "future" || u === "futures" || u === "swap" || u === "linear")
    return "futures";
  if (u === "savings" || u === "earn" || u === "flexible" || u === "lock")
    return "earn";
  if (u === "wallet" || u === "fund" || u === "funding") return "funding";
  return u;
}

/**
 * Принимает row из CCXT `fetchTransfers`, возвращает canonical line
 * либо `null` если row невалиден (missing id / amount / accounts).
 */
export function normalizeCcxtInternalTransfer(
  raw: CcxtTransferRaw,
): CexInternalTransferLine | null {
  const id = raw.id;
  if (!id) return null;

  const asset = (raw.currency ?? raw.code ?? "").toString().toUpperCase();
  if (!asset) return null;

  const amount = toNum(raw.amount);
  if (!Number.isFinite(amount) || amount <= 0) return null;

  const ts = toNum(raw.timestamp);
  let executedAtMs: number;
  if (Number.isFinite(ts) && ts > 0) {
    executedAtMs = ts;
  } else if (raw.datetime) {
    const iso = Date.parse(raw.datetime);
    if (!Number.isFinite(iso) || iso <= 0) return null;
    executedAtMs = iso;
  } else {
    return null;
  }

  const fromAccount = normalizeAccountType(raw.fromAccount);
  const toAccount = normalizeAccountType(raw.toAccount);
  if (fromAccount === toAccount && fromAccount === "unknown") {
    // Если оба unknown — никакой полезной информации не имеем.
    return null;
  }

  return {
    id: String(id),
    asset,
    amount,
    fromAccount,
    toAccount,
    status: (raw.status ?? "ok").toString().toLowerCase(),
    executedAtMs,
    raw,
  };
}
