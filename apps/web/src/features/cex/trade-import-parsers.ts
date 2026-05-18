/**
 * UCB B6: парсеры trade-history-выгрузок с бирж в нормализованный
 * shape для POST `/v1/cex/:id/trades/import-csv`. Биржи отдают разный
 * формат — здесь auto-detect + per-exchange parser.
 *
 * Поддерживается:
 *   - **Bybit CSV** — header «Uid,Spot Pairs,Order Type,Direction,…»,
 *     timezone UTC+0, side BUY/SELL caps. Символ слитный (`BTCUSDT`)
 *     → конвертим в `BTC/USDT` через quote-strip.
 *   - **BingX XLSX** — header `UID,Order No.,Time(UTC+8),Pair,Type,…`,
 *     timezone UTC+8 (offset в ISO-дате), side Buy/Sell title-case.
 *     Символ уже как `BTC/USDT`.
 *
 * Расширения для других бирж (OKX/MEXC/Bitget) — добавлять через
 * separate detect/parse function pair.
 */

import * as XLSX from "xlsx";

/** Stable-quote candidates для де-конкатенации символа (BTCUSDT → BTC/USDT). */
const QUOTES = ["USDT", "USDC", "USD", "BTC", "ETH", "DAI", "BNB"] as const;

export type ImportSource = "bybit_csv" | "bingx_xlsx" | "unknown";

export interface ParsedTradeRow {
  readonly exchangeTradeId: string;
  readonly symbol: string; // canonical `BASE/QUOTE`
  readonly side: "buy" | "sell";
  readonly amount: number;
  readonly price: number;
  readonly cost: number;
  readonly feeCurrency: string | null;
  readonly feeAmount: number | null;
  readonly executedAt: string; // ISO 8601
}

export interface ParseResult {
  readonly source: ImportSource;
  readonly rows: readonly ParsedTradeRow[];
  /** Сколько строк было в файле минус валидные — UI показывает «X пропущено». */
  readonly skipped: number;
  /** Ошибка парсинга — UI surface'ит. */
  readonly error?: string;
}

/**
 * Главная точка входа: получает File (из <input type=file>) и
 * auto-detect'ит формат. Возвращает нормализованные rows.
 */
export async function parseTradeImportFile(file: File): Promise<ParseResult> {
  const lowerName = file.name.toLowerCase();
  if (lowerName.endsWith(".xlsx") || lowerName.endsWith(".xls")) {
    return parseBingxXlsx(file);
  }
  if (lowerName.endsWith(".csv")) {
    const text = await file.text();
    return parseBybitCsv(text);
  }
  return {
    source: "unknown",
    rows: [],
    skipped: 0,
    error: "Поддерживаются файлы CSV (Bybit) и XLSX (BingX). Другой формат — пока не реализован.",
  };
}

/* ─── Bybit CSV parser ─── */

/**
 * Bybit CSV format (Trade History Statement Spot):
 *
 *   UID: 281915315,Company Name: ,Country:
 *   Uid,Spot Pairs,Order Type,Direction,Filled Value,Filled Price,Filled Quantity,Fees,Transaction ID,Order No.,Timestamp (UTC+0)
 *   281915315,BTCUSDT,LIMIT,BUY,4478.057,97100.0,0.046118,0.0000461,2290000000522832993,1836393090823494400,2024-12-09 19:48:23
 *
 * Первая строка — мета (UID/Company/Country) → пропускаем. Вторая — header.
 */
export function parseBybitCsv(text: string): ParseResult {
  const allLines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  // Найти header-строку — она начинается с "Uid,Spot Pairs," (case-insensitive)
  const headerIdx = allLines.findIndex((l) =>
    /^Uid,Spot Pairs,/i.test(l),
  );
  if (headerIdx === -1) {
    return {
      source: "unknown",
      rows: [],
      skipped: 0,
      error:
        "Не Bybit CSV: не найден заголовок «Uid,Spot Pairs,...». Проверьте что файл — Trade History Statement Spot с Bybit.",
    };
  }
  const headerCols = allLines[headerIdx]!.split(",").map((s) => s.trim());
  const idx = (name: string) =>
    headerCols.findIndex((h) => h.toLowerCase() === name.toLowerCase());
  const iPair = idx("Spot Pairs");
  const iSide = idx("Direction");
  const iValue = idx("Filled Value");
  const iPrice = idx("Filled Price");
  const iQty = idx("Filled Quantity");
  const iFees = idx("Fees");
  const iTxId = idx("Transaction ID");
  const iTs = idx("Timestamp (UTC+0)");

  if ([iPair, iSide, iValue, iPrice, iQty, iTxId, iTs].some((x) => x < 0)) {
    return {
      source: "bybit_csv",
      rows: [],
      skipped: 0,
      error:
        "Bybit CSV формат изменился — не нашёл одну из колонок (Spot Pairs / Direction / Filled Value / Filled Price / Filled Quantity / Transaction ID / Timestamp).",
    };
  }

  const out: ParsedTradeRow[] = [];
  let skipped = 0;
  for (let i = headerIdx + 1; i < allLines.length; i++) {
    const line = allLines[i]!;
    const cols = line.split(",").map((s) => s.trim());
    const sideRaw = cols[iSide]?.toUpperCase();
    const side = sideRaw === "BUY" ? "buy" : sideRaw === "SELL" ? "sell" : null;
    const amount = Number(cols[iQty]);
    const price = Number(cols[iPrice]);
    const cost = Number(cols[iValue]);
    const tradeId = cols[iTxId];
    const tsRaw = cols[iTs];
    const symbolRaw = cols[iPair];
    if (!side || !tradeId || !tsRaw || !symbolRaw) {
      skipped++;
      continue;
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      skipped++;
      continue;
    }
    if (!Number.isFinite(price) || price <= 0) {
      skipped++;
      continue;
    }
    // `2024-12-09 19:48:23` UTC+0 → ISO с Z.
    const isoTs = `${tsRaw.replace(" ", "T")}Z`;
    if (Number.isNaN(Date.parse(isoTs))) {
      skipped++;
      continue;
    }
    out.push({
      exchangeTradeId: tradeId,
      symbol: splitConcatPair(symbolRaw),
      side,
      amount,
      price,
      cost: Number.isFinite(cost) && cost > 0 ? cost : amount * price,
      feeCurrency: null, // Bybit fees колонка без явной currency
      feeAmount: cols[iFees] ? Number(cols[iFees]) : null,
      executedAt: isoTs,
    });
  }
  return { source: "bybit_csv", rows: out, skipped };
}

/* ─── BingX XLSX parser ─── */

/**
 * BingX Order History XLSX:
 *
 *   UID | Order No. | Time(UTC+8) | Pair | Type | Price | Amount | Order Value | Fee | Fee Coin | Order Type
 *
 * Time format: `2024-11-26T06:59:57.000+08:00` — нативный ISO, конвертим в UTC.
 * Side: Buy/Sell. Fee: отрицательное (BingX deduction notation) — берём абсолют.
 */
export async function parseBingxXlsx(file: File): Promise<ParseResult> {
  const buffer = await file.arrayBuffer();
  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(buffer, { type: "array" });
  } catch (e) {
    return {
      source: "unknown",
      rows: [],
      skipped: 0,
      error: `XLSX не парсится: ${(e as Error).message}`,
    };
  }
  const sheetName = wb.SheetNames[0];
  if (!sheetName) {
    return { source: "unknown", rows: [], skipped: 0, error: "Нет листов в XLSX." };
  }
  const sheet = wb.Sheets[sheetName]!;
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
    defval: "",
  });
  if (rows.length === 0) {
    return { source: "bingx_xlsx", rows: [], skipped: 0 };
  }
  // Validation: headers must look like BingX
  const firstKeys = Object.keys(rows[0]!);
  const hasOrderNo = firstKeys.some((k) => /order\s*no/i.test(k));
  const hasPair = firstKeys.some((k) => k.toLowerCase() === "pair");
  const hasType = firstKeys.some((k) => k.toLowerCase() === "type");
  if (!hasOrderNo || !hasPair || !hasType) {
    return {
      source: "unknown",
      rows: [],
      skipped: 0,
      error:
        "Не BingX XLSX: ожидаются колонки Order No. / Pair / Type. Проверьте что это Order History export с BingX.",
    };
  }

  const out: ParsedTradeRow[] = [];
  let skipped = 0;
  for (const r of rows) {
    const get = (re: RegExp): string => {
      for (const [k, v] of Object.entries(r)) {
        if (re.test(k)) return String(v).trim();
      }
      return "";
    };
    const tradeId = get(/order\s*no/i);
    const tsRaw = get(/time/i);
    const pair = get(/^pair$/i);
    const sideRaw = get(/^type$/i)?.toLowerCase();
    const price = Number(get(/^price$/i));
    const amount = Number(get(/^amount$/i));
    const cost = Number(get(/order\s*value/i));
    const feeRaw = Number(get(/^fee$/i));
    const feeCoin = get(/fee\s*coin/i);

    const side =
      sideRaw === "buy" ? "buy" : sideRaw === "sell" ? "sell" : null;
    if (!tradeId || !tsRaw || !pair || !side) {
      skipped++;
      continue;
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      skipped++;
      continue;
    }
    if (!Number.isFinite(price) || price <= 0) {
      skipped++;
      continue;
    }
    // BingX header — `Time(UTC+8)`. Если в значении уже есть `+08:00`/`+0800`
    // — JS правильно преобразует. Если значение без offset
    // (`2025-09-28 23:36:25` или `2025-09-28T23:36:25`) — мы знаем что
    // это BingX local time = UTC+8 и должны вычитать. Иначе ImportService
    // в БД сохранит «UTC время» которое на 8 часов опережает реальное,
    // и event-ordering в CexCostBasisService сломается.
    const isoExecutedAt = normalizeBingxTimestamp(tsRaw);
    if (isoExecutedAt === null) {
      skipped++;
      continue;
    }
    out.push({
      exchangeTradeId: tradeId,
      symbol: pair.toUpperCase(),
      side,
      amount,
      price,
      cost: Number.isFinite(cost) && cost > 0 ? cost : amount * price,
      feeCurrency: feeCoin || null,
      feeAmount:
        Number.isFinite(feeRaw) && feeRaw !== 0 ? Math.abs(feeRaw) : null,
      executedAt: isoExecutedAt,
    });
  }
  return { source: "bingx_xlsx", rows: out, skipped };
}

/**
 * Преобразует BingX timestamp в ISO 8601 UTC.
 *
 * BingX header — `Time(UTC+8)`. Возможные форматы значения:
 *   1. `2024-11-26T06:59:57.000+08:00` — нативный ISO с offset → как есть
 *   2. `2025-09-28T23:36:25` (без offset) — это **BingX local UTC+8**,
 *      JS интерпретирует как UTC что неверно → trades окажутся на 8 часов
 *      впереди withdrawal'ов, и chain в CexCostBasisService сломается
 *   3. `2025-09-28 23:36:25` (с пробелом) — то же что #2
 *
 * Стратегия: если в строке нет timezone-indicator (Z, +HH:MM, -HH:MM,
 * +HHMM) — добавляем `+08:00` (BingX local). Иначе доверяем что строка
 * уже валидный ISO. Возвращаем null если parse fail.
 */
export function normalizeBingxTimestamp(raw: string): string | null {
  if (!raw) return null;
  const s = raw.trim();
  // Detection: есть ли явный timezone-indicator?
  const hasOffset = /Z$|[+-]\d{2}:?\d{2}$/.test(s);
  let candidate: string;
  if (hasOffset) {
    candidate = s;
  } else {
    // Заменяем " " на "T" если space-separated, добавляем +08:00
    const normalized = s.includes("T") ? s : s.replace(" ", "T");
    candidate = `${normalized}+08:00`;
  }
  const parsed = Date.parse(candidate);
  if (Number.isNaN(parsed)) return null;
  return new Date(parsed).toISOString();
}

/**
 * Разделяет concatenated pair `BTCUSDT` → `BTC/USDT` по списку
 * известных stable-quotes. Если ни один не подошёл — возвращает как
 * есть (uppercase).
 */
function splitConcatPair(s: string): string {
  const up = s.toUpperCase();
  if (up.includes("/")) return up; // уже разделён
  for (const q of QUOTES) {
    if (up.endsWith(q) && up.length > q.length) {
      return `${up.slice(0, up.length - q.length)}/${q}`;
    }
  }
  return up;
}
