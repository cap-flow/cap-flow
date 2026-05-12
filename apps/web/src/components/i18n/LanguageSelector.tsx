import { LOCALE_LABELS, useI18n, type Locale } from "@/i18n/I18nProvider";

const LOCALES: Locale[] = ["en", "ru"];

export function LanguageSelector() {
  const { locale, setLocale } = useI18n();
  return (
    <div
      className="inline-flex rounded-md border border-border bg-secondary p-1"
      role="radiogroup"
      aria-label="Language"
    >
      {LOCALES.map((l) => {
        const active = locale === l;
        return (
          <button
            key={l}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => setLocale(l)}
            className={
              "rounded px-3 py-1.5 text-sm font-medium transition-colors " +
              (active
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground")
            }
          >
            {LOCALE_LABELS[l]}
          </button>
        );
      })}
    </div>
  );
}
