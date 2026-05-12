/**
 * Ручные аннотации операций в реестре. Один и тот же tx может быть размечен
 * как:
 *  - **Покупка за фиат** (`fiatPurchase`) — указать сколько потрачено в фиате
 *  - **Кредитный актив** (`creditAsset`) — пометить пришедшие токены как
 *    купленные на кредитные средства (учитываются отдельно от своего капитала)
 *
 * Хранится в `localStorage` под ключом `capflow.op_annotations`.
 * Ключ записи — стабильный `walletId|chain|hash` (как у остальных).
 *
 * Для обратной совместимости: старые записи в `capflow.fiat_purchases`
 * читаются как `{ fiatPurchase: ... }`.
 */

import { useCallback, useMemo } from "react";

import { useLocalStorage } from "@/lib/useLocalStorage";

export type FiatCurrency =
  | "RUB" | "USD" | "EUR" | "GBP" | "KZT" | "UAH"
  | "TRY" | "VND" | "BYN" | "PLN" | "CNY" | "JPY"
  | "CHF" | "AED" | "INR" | "BRL" | "ARS" | "MXN"
  | string; // допускаем произвольный код для «другой фиат»

export const COMMON_FIAT_CURRENCIES: { code: FiatCurrency; symbol: string; label: string }[] = [
  { code: "RUB", symbol: "₽", label: "Рубли" },
  { code: "USD", symbol: "$", label: "Доллары" },
  { code: "EUR", symbol: "€", label: "Евро" },
  { code: "GBP", symbol: "£", label: "Фунты" },
  { code: "KZT", symbol: "₸", label: "Тенге" },
  { code: "UAH", symbol: "₴", label: "Гривны" },
  { code: "TRY", symbol: "₺", label: "Лиры" },
  { code: "VND", symbol: "₫", label: "Донги" },
  { code: "BYN", symbol: "Br", label: "Бел. рубли" },
  { code: "CNY", symbol: "¥", label: "Юани" },
];

export function fiatSymbol(code: FiatCurrency): string {
  const fixed = COMMON_FIAT_CURRENCIES.find((f) => f.code === code);
  if (fixed) return fixed.symbol;
  return code; // для custom-кодов символ = сам код
}

export interface FiatPurchaseAnnotation {
  /** Сумма в фиате. */
  fiatAmount: number;
  /** Валюта (ISO-код или произвольный). */
  fiatCurrency: FiatCurrency;
  /** Заметка пользователя. */
  note?: string;
}

export interface CreditAssetAnnotation {
  /** Заметка (например источник кредита). */
  note?: string;
}

export interface OpAnnotation {
  fiatPurchase?: FiatPurchaseAnnotation;
  credit?: CreditAssetAnnotation;
}

export type OpAnnotations = Record<string, OpAnnotation>;

const KEY_NEW = "capflow.op_annotations";
const KEY_LEGACY = "capflow.fiat_purchases";

/** Стабильный ключ записи: `walletId|chain|hash`. */
export function annotationKey(args: {
  walletId: string;
  chain: string;
  hash: string;
}): string {
  return `${args.walletId}|${args.chain}|${args.hash}`;
}

// Одноразовая миграция legacy → новый ключ, выполняется при первом импорте
// модуля. Без useEffect внутри хука (чтобы избежать циклов в strict-mode).
if (typeof window !== "undefined") {
  try {
    const legacy = window.localStorage.getItem(KEY_LEGACY);
    if (legacy) {
      const parsed = JSON.parse(legacy) as Record<string, FiatPurchaseAnnotation>;
      const existingRaw = window.localStorage.getItem(KEY_NEW);
      const existing: OpAnnotations = existingRaw ? JSON.parse(existingRaw) : {};
      let changed = false;
      for (const [k, v] of Object.entries(parsed)) {
        if (!existing[k]?.fiatPurchase) {
          existing[k] = { ...(existing[k] ?? {}), fiatPurchase: v };
          changed = true;
        }
      }
      if (changed) window.localStorage.setItem(KEY_NEW, JSON.stringify(existing));
      window.localStorage.removeItem(KEY_LEGACY);
    }
  } catch {
    /* ignore */
  }
}

/** Хук для чтения/записи аннотаций. */
export function useOpAnnotations(): [
  OpAnnotations,
  (
    update: OpAnnotations | ((prev: OpAnnotations) => OpAnnotations),
  ) => void,
] {
  return useLocalStorage<OpAnnotations>(KEY_NEW, {});
}

/** Удобный хук: setter для одной записи + helper'ы. */
export function useAnnotateOp(args: {
  walletId: string;
  chain: string;
  hash: string;
}) {
  const [annotations, setAnnotations] = useOpAnnotations();
  const key = useMemo(() => annotationKey(args), [args.walletId, args.chain, args.hash]);
  const value = annotations[key];

  const setFiatPurchase = useCallback(
    (p: FiatPurchaseAnnotation | null) => {
      setAnnotations((prev) => {
        const next = { ...prev };
        const cur: OpAnnotation = { ...(next[key] ?? {}) };
        if (p == null) delete cur.fiatPurchase;
        else cur.fiatPurchase = p;
        if (Object.keys(cur).length === 0) {
          delete next[key];
        } else {
          next[key] = cur;
        }
        return next;
      });
    },
    [key, setAnnotations],
  );

  const setCredit = useCallback(
    (c: CreditAssetAnnotation | null) => {
      setAnnotations((prev) => {
        const next = { ...prev };
        const cur: OpAnnotation = { ...(next[key] ?? {}) };
        if (c == null) delete cur.credit;
        else cur.credit = c;
        if (Object.keys(cur).length === 0) {
          delete next[key];
        } else {
          next[key] = cur;
        }
        return next;
      });
    },
    [key, setAnnotations],
  );

  return {
    value,
    setFiatPurchase,
    setCredit,
  };
}

/** Форматировать фиат-сумму. Для нестандартных кодов — упрощённо. */
export function formatFiat(
  amount: number,
  currency: FiatCurrency,
  locale: "en" | "ru" = "ru",
): string {
  // Известные ISO-коды — через Intl.
  try {
    return new Intl.NumberFormat(locale === "ru" ? "ru-RU" : "en-US", {
      style: "currency",
      currency,
      maximumFractionDigits: 0,
    }).format(amount);
  } catch {
    // Произвольный код (например, выдуманная аббревиатура) — показываем как есть.
    const formatted = new Intl.NumberFormat(
      locale === "ru" ? "ru-RU" : "en-US",
      { maximumFractionDigits: 0 },
    ).format(amount);
    return `${formatted} ${currency}`;
  }
}
