import type { Locale } from "./I18nProvider";

const LOCALE_TO_INTL: Record<Locale, string> = {
  en: "en-US",
  ru: "ru-RU",
};

export function formatDate(timestamp: number, locale: Locale): string {
  return new Intl.DateTimeFormat(LOCALE_TO_INTL[locale], {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "long",
  }).format(new Date(timestamp * 1000));
}

export function formatTime(timestamp: number, locale: Locale): string {
  return new Intl.DateTimeFormat(LOCALE_TO_INTL[locale], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(timestamp * 1000));
}

/** Короткий формат DD.MM.YYYY — локально-нейтральный. */
export function formatDateShort(timestamp: number): string {
  const d = new Date(timestamp * 1000);
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  return `${dd}.${mm}.${yyyy}`;
}

/**
 * Компактный формат даты+времени в одной строке:
 * `DD.MM.YYYY в HH:MM:SS`. Используется в реестре операций.
 */
export function formatDateTime(timestamp: number): string {
  const d = new Date(timestamp * 1000);
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  const hh = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${dd}.${mm}.${yyyy} в ${hh}:${min}:${ss}`;
}

export function dateKey(timestamp: number): string {
  // YYYY-MM-DD ключ группировки в локальной TZ пользователя.
  const d = new Date(timestamp * 1000);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function formatUsd(value: number, locale: Locale): string {
  return new Intl.NumberFormat(LOCALE_TO_INTL[locale], {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(value);
}

export function formatNumber(value: number, locale: Locale, fraction = 4): string {
  return new Intl.NumberFormat(LOCALE_TO_INTL[locale], {
    maximumFractionDigits: fraction,
  }).format(value);
}

export function formatRub(value: number, locale: Locale): string {
  return new Intl.NumberFormat(LOCALE_TO_INTL[locale], {
    style: "currency",
    currency: "RUB",
    maximumFractionDigits: 0,
  }).format(value);
}

export function shortAddress(addr: string, head = 6, tail = 4): string {
  if (!addr) return "";
  if (addr.length <= head + tail + 2) return addr;
  return `${addr.slice(0, head)}…${addr.slice(-tail)}`;
}
