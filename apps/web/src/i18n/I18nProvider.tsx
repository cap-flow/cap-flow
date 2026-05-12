import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
} from "react";

import { useLocalStorage } from "@/lib/useLocalStorage";
import { en, type TranslationKey } from "./locales/en";
import { ru } from "./locales/ru";

export type Locale = "en" | "ru";

const dictionaries: Record<Locale, Record<TranslationKey, string>> = {
  en,
  ru,
};

export const LOCALE_LABELS: Record<Locale, string> = {
  en: "English",
  ru: "Русский",
};

interface I18nContextValue {
  locale: Locale;
  setLocale: (l: Locale) => void;
  t: (key: TranslationKey, ...args: (string | number)[]) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

function detectInitial(): Locale {
  if (typeof navigator === "undefined") return "en";
  const lang = navigator.language?.toLowerCase() ?? "";
  return lang.startsWith("ru") ? "ru" : "en";
}

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleRaw] = useLocalStorage<Locale>(
    "capflow.locale",
    detectInitial(),
  );

  const setLocale = useCallback(
    (l: Locale) => setLocaleRaw(l),
    [setLocaleRaw],
  );

  // Поддерживаем атрибут <html lang="…"> в актуальном состоянии
  useEffect(() => {
    document.documentElement.setAttribute("lang", locale);
  }, [locale]);

  const t = useCallback(
    (key: TranslationKey, ...args: (string | number)[]): string => {
      const dict = dictionaries[locale];
      let s = dict[key] ?? en[key] ?? key;
      // Простая интерполяция {0}, {1}, …
      for (let i = 0; i < args.length; i++) {
        s = s.replace(`{${i}}`, String(args[i]));
      }
      return s;
    },
    [locale],
  );

  const value = useMemo<I18nContextValue>(
    () => ({ locale, setLocale, t }),
    [locale, setLocale, t],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be used inside <I18nProvider>");
  return ctx;
}

/** Удобный шорткат для `t` без деструктуризации. */
export function useT() {
  return useI18n().t;
}
