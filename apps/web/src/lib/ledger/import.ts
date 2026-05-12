import type { ImportedLedger, ManualOp } from "./types";

/**
 * Парсит экспорт `capflow-export.json` в нашу типизированную модель.
 * Принимает уже разобранный JSON.
 */
export function parseLedgerExport(raw: unknown): ImportedLedger {
  if (!raw || typeof raw !== "object") {
    throw new Error("Invalid ledger file: not an object");
  }
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.operations)) {
    throw new Error("Invalid ledger file: 'operations' must be an array");
  }

  const account = (r.account as ImportedLedger["account"]) ?? {
    id: "default",
    name: "Imported portfolio",
    createdAt: Date.now(),
  };

  const operations = (r.operations as Record<string, unknown>[]).map(coerceOp);
  // Сортируем по дате+id, как в исходнике (id монотонный — просто числовая часть OP-NNN).
  operations.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    return numericIdPart(a.id) - numericIdPart(b.id);
  });

  return {
    account,
    operations,
    wallets: (r.wallets as string[]) ?? [],
    projects: (r.projects as string[]) ?? [],
    tokens: (r.tokens as string[]) ?? [],
    importedAt: Date.now(),
  };
}

function coerceOp(o: Record<string, unknown>): ManualOp {
  return {
    id: stringOr(o.id, "OP-?"),
    date: stringOr(o.date, "1970-01-01"),
    type: (o.type as ManualOp["type"]) ?? "buy",
    source: (o.source as ManualOp["source"]) ?? "manual",

    from: nullable(o.from),
    to: nullable(o.to),

    cur1: nullable(o.cur1),
    amount1: nullableNum(o.amount1),
    cur2: nullable(o.cur2),
    amount2: nullableNum(o.amount2),
    rate: nullableNum(o.rate),
    price: nullableNum(o.price),
    avgPrice: nullableNum(o.avgPrice),

    posType: nullable(o.posType),
    funds: (nullable(o.funds) as ManualOp["funds"]) ?? null,

    loanRate: nullableNum(o.loanRate),
    loanRateTake: nullableNum(o.loanRateTake),
    loanFrom: nullable(o.loanFrom),
    loanPosId: nullable(o.loanPosId),
    loanLtv: nullableNum(o.loanLtv),
    loanLiqPct: nullableNum(o.loanLiqPct),
    loanLiqPrice: nullableNum(o.loanLiqPrice),
    loanCollateralUsd: nullableNum(o.loanCollateralUsd),

    lpVersion: nullable(o.lpVersion),
    lpPair: nullable(o.lpPair),
    lpPriceLow: nullableNum(o.lpPriceLow),
    lpPriceHigh: nullableNum(o.lpPriceHigh),
    lpPriceOpen: nullableNum(o.lpPriceOpen),
    lpFeeTier: nullableNum(o.lpFeeTier),
    lpNftId: nullable(o.lpNftId),

    network: nullable(o.network),
    commissionNetwork: nullableNum(o.commissionNetwork),

    closeTokenAmount: nullableNum(o.closeTokenAmount),
    closeCur2: nullable(o.closeCur2),
    closeAmount2: nullableNum(o.closeAmount2),

    reinvestPosId: nullable(o.reinvestPosId),
    returnPosId: nullable(o.returnPosId),
    returnType: (nullable(o.returnType) as ManualOp["returnType"]) ?? null,

    direction: (nullable(o.direction) as ManualOp["direction"]) ?? null,
    comment: stringOr(o.comment, ""),
    dividendFunds: (nullable(o.dividendFunds) as ManualOp["funds"]) ?? null,
  };
}

function stringOr(v: unknown, def: string): string {
  return typeof v === "string" ? v : def;
}
function nullable(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}
function nullableNum(v: unknown): number | null {
  return typeof v === "number" && !Number.isNaN(v) ? v : null;
}
function numericIdPart(id: string): number {
  const m = id.match(/(\d+)/);
  return m ? Number(m[1]) : 0;
}
