/**
 * Ручная разметка операции в реестре. Заменяет старый FiatPurchaseCell.
 *
 * Поддерживает два независимых типа разметки (можно поставить оба сразу):
 *  1. **Покупка крипты за фиат** — указать сколько потрачено + валюта.
 *     Используется в «Стартовый капитал» на дашборде.
 *  2. **Кредитный актив** — пометить пришедший токен как купленный
 *     на кредитные средства. Учитывается отдельно в аналитике.
 *
 * Кнопки появляются только для `transfer_in` ops. После разметки на
 * соответствующем типе показывается зелёный/жёлтый бейдж.
 */

import { useState } from "react";
import {
  Banknote,
  Landmark,
  Pencil,
  Search,
  X,
} from "lucide-react";

import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  COMMON_FIAT_CURRENCIES,
  fiatSymbol,
  formatFiat,
  useAnnotateOp,
  type FiatCurrency,
  type FiatPurchaseAnnotation,
  type CreditAssetAnnotation,
} from "@/lib/portfolio/manual_annotations";
import { isStableSymbol } from "@/lib/portfolio/protocols";
import { formatNumber } from "@/i18n/format";
import { useI18n } from "@/i18n/I18nProvider";
import { cn } from "@/lib/utils";

interface ManualAnnotationCellProps {
  walletId: string;
  chain: string;
  hash: string;
  /** Главный токен в op'е — для расчёта курса. */
  primaryToken?: { symbol: string; amount: number };
}

type View = "menu" | "fiat" | "credit";

export function ManualAnnotationCell({
  walletId,
  chain,
  hash,
  primaryToken,
}: ManualAnnotationCellProps) {
  const { locale } = useI18n();
  const { value, setFiatPurchase, setCredit } = useAnnotateOp({
    walletId,
    chain,
    hash,
  });
  const [view, setView] = useState<View | null>(null);

  const hasFiat = !!value?.fiatPurchase;
  const hasCredit = !!value?.credit;

  const fiatRate =
    value?.fiatPurchase && primaryToken && primaryToken.amount > 0
      ? value.fiatPurchase.fiatAmount / primaryToken.amount
      : null;

  return (
    <>
      <div className="mt-1 flex flex-wrap items-center gap-1.5">
        {/* Бейджи активных разметок */}
        {hasFiat && value?.fiatPurchase && (
          <span className="inline-flex items-center gap-1 rounded border border-emerald-500/40 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] text-emerald-400">
            <Banknote className="h-3 w-3" />
            <span className="font-semibold tabular-nums">
              {formatFiat(
                value.fiatPurchase.fiatAmount,
                value.fiatPurchase.fiatCurrency,
                locale === "en" ? "en" : "ru",
              )}
            </span>
            {fiatRate != null && primaryToken && (
              <span className="text-emerald-400/70">
                · {formatNumber(fiatRate, locale, 2)}{" "}
                {fiatSymbol(value.fiatPurchase.fiatCurrency)}/{primaryToken.symbol}
              </span>
            )}
            <button
              type="button"
              onClick={() => setView("fiat")}
              aria-label="Изменить"
              className="ml-1 rounded p-0.5 hover:bg-emerald-500/20"
            >
              <Pencil className="h-2.5 w-2.5" />
            </button>
            <button
              type="button"
              onClick={() => setFiatPurchase(null)}
              aria-label="Убрать"
              className="rounded p-0.5 hover:bg-destructive/20 hover:text-destructive"
            >
              <X className="h-2.5 w-2.5" />
            </button>
          </span>
        )}
        {hasCredit && (
          <span className="inline-flex items-center gap-1 rounded border border-warning/50 bg-warning/15 px-1.5 py-0.5 text-[10px] text-warning">
            <Landmark className="h-3 w-3" />
            <span className="font-semibold uppercase">Кредит</span>
            <button
              type="button"
              onClick={() => setView("credit")}
              aria-label="Изменить"
              className="ml-1 rounded p-0.5 hover:bg-warning/20"
            >
              <Pencil className="h-2.5 w-2.5" />
            </button>
            <button
              type="button"
              onClick={() => setCredit(null)}
              aria-label="Убрать"
              className="rounded p-0.5 hover:bg-destructive/20 hover:text-destructive"
            >
              <X className="h-2.5 w-2.5" />
            </button>
          </span>
        )}

        {/* Кнопка ручной разметки */}
        {!hasFiat && !hasCredit && (
          <button
            type="button"
            onClick={() => setView("menu")}
            className="inline-flex items-center gap-1 rounded border border-dashed border-muted-foreground/40 bg-transparent px-1.5 py-0.5 text-[10px] text-muted-foreground hover:border-emerald-500/40 hover:bg-emerald-500/10 hover:text-emerald-400 transition-colors"
          >
            <Pencil className="h-3 w-3" />
            ручная разметка
          </button>
        )}
        {(hasFiat || hasCredit) && !(hasFiat && hasCredit) && (
          <button
            type="button"
            onClick={() => setView("menu")}
            className="rounded border border-dashed border-muted-foreground/40 bg-transparent px-1.5 py-0.5 text-[10px] text-muted-foreground hover:border-brand-cyan/40 hover:text-brand-cyan transition-colors"
          >
            + ещё разметка
          </button>
        )}
      </div>

      {view === "menu" && (
        <MenuDialog
          onClose={() => setView(null)}
          onPick={(v) => setView(v)}
        />
      )}
      {view === "fiat" && (
        <FiatPurchaseDialog
          initial={value?.fiatPurchase}
          primaryToken={primaryToken}
          onClose={() => setView(null)}
          onSave={(p) => {
            setFiatPurchase(p);
            setView(null);
          }}
        />
      )}
      {view === "credit" && (
        <CreditDialog
          initial={value?.credit}
          onClose={() => setView(null)}
          onSave={(c) => {
            setCredit(c);
            setView(null);
          }}
        />
      )}
    </>
  );
}

/* ----------------------------- Диалоги ------------------------------------ */

function MenuDialog({
  onClose,
  onPick,
}: {
  onClose: () => void;
  onPick: (v: View) => void;
}) {
  return (
    <Dialog
      open
      onClose={onClose}
      size="sm"
      title="Ручная разметка"
      description="Какой тип разметки вы хотите применить к этой операции?"
    >
      <div className="grid grid-cols-1 gap-2">
        <button
          type="button"
          onClick={() => onPick("fiat")}
          className="flex items-center gap-3 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3 text-left transition-colors hover:bg-emerald-500/10"
        >
          <div className="flex h-10 w-10 items-center justify-center rounded-md bg-emerald-500/15 text-emerald-400">
            <Banknote className="h-5 w-5" />
          </div>
          <div>
            <div className="font-semibold text-foreground">
              Покупка крипты за фиат
            </div>
            <div className="text-xs text-muted-foreground">
              Указать сколько потрачено в фиате — учтётся в стартовом капитале
            </div>
          </div>
        </button>
        <button
          type="button"
          onClick={() => onPick("credit")}
          className="flex items-center gap-3 rounded-lg border border-warning/40 bg-warning/5 p-3 text-left transition-colors hover:bg-warning/10"
        >
          <div className="flex h-10 w-10 items-center justify-center rounded-md bg-warning/15 text-warning">
            <Landmark className="h-5 w-5" />
          </div>
          <div>
            <div className="font-semibold text-foreground">Кредитный актив</div>
            <div className="text-xs text-muted-foreground">
              Помечен как купленный на заёмные средства — учитывается отдельно
              от своего капитала
            </div>
          </div>
        </button>
      </div>
    </Dialog>
  );
}

function FiatPurchaseDialog({
  initial,
  primaryToken,
  onClose,
  onSave,
}: {
  initial?: FiatPurchaseAnnotation;
  primaryToken?: { symbol: string; amount: number };
  onClose: () => void;
  onSave: (p: FiatPurchaseAnnotation) => void;
}) {
  const { locale } = useI18n();
  const [fiatAmount, setFiatAmount] = useState(
    initial ? String(initial.fiatAmount) : "",
  );
  const [fiatCurrency, setFiatCurrency] = useState<FiatCurrency>(
    initial?.fiatCurrency ?? "RUB",
  );
  const [showCustomCurrency, setShowCustomCurrency] = useState(
    initial != null &&
      !COMMON_FIAT_CURRENCIES.some((c) => c.code === initial.fiatCurrency),
  );
  const [customCode, setCustomCode] = useState(
    showCustomCurrency ? String(initial?.fiatCurrency ?? "") : "",
  );
  const [note, setNote] = useState(initial?.note ?? "");

  const parsedAmount = Number(
    fiatAmount.replace(/\s/g, "").replace(",", "."),
  );
  const validAmount = Number.isFinite(parsedAmount) && parsedAmount > 0;
  const effectiveCurrency = showCustomCurrency
    ? customCode.trim().toUpperCase()
    : fiatCurrency;
  const validCurrency = effectiveCurrency.length >= 2;

  const rate =
    validAmount && validCurrency && primaryToken && primaryToken.amount > 0
      ? parsedAmount / primaryToken.amount
      : null;

  // --- Зафиксированный $-эквивалент (стартовый капитал в долларах) ---
  // Owner-решение 2026-06-10: НЕ спрашиваем $ вручную и НЕ конвертируем рубли
  // по курсу ЦБ (это давало курсовую фикцию: 50 000 ₽ / 71.73 = $697 вместо
  // реально полученных $665). Купили крипту за фиат → стартовый капитал в $ =
  // СТОИМОСТЬ полученного актива:
  //   • фиат уже в USD            → сама сумма;
  //   • получен стейбл (USD₮0/…)  → номинал полученного ($1 за токен);
  //   • иначе (волатильный актив) → $ неизвестен из этого диалога → не пишем
  //     usdAmount (metrics.ts фолбэк), такие случаи размечаются отдельно.
  const isUsd = effectiveCurrency === "USD";
  const primaryIsStable =
    primaryToken != null && isStableSymbol(primaryToken.symbol);
  const usdAmountFinal = isUsd
    ? parsedAmount
    : primaryIsStable && primaryToken != null && primaryToken.amount > 0
      ? primaryToken.amount
      : null;
  // Подразумеваемый курс фиат/$ для прозрачности/аудита.
  const usdRateImplied =
    !isUsd && usdAmountFinal != null && usdAmountFinal > 0
      ? parsedAmount / usdAmountFinal
      : null;

  const valid = validAmount && validCurrency;

  return (
    <Dialog
      open
      onClose={onClose}
      size="sm"
      title={
        <span className="inline-flex items-center gap-2">
          <Banknote className="h-4 w-4 text-emerald-400" />
          Покупка крипты за фиат
        </span>
      }
      description={
        primaryToken
          ? `За эту операцию получено ${formatNumber(primaryToken.amount, locale, 6)} ${primaryToken.symbol}.`
          : "Укажи сумму в фиате, которую заплатил."
      }
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Отмена
          </Button>
          <Button
            disabled={!valid}
            onClick={() => {
              if (!valid) return;
              const p: FiatPurchaseAnnotation = {
                fiatAmount: parsedAmount,
                fiatCurrency: effectiveCurrency,
              };
              if (usdAmountFinal != null) p.usdAmount = usdAmountFinal;
              if (usdRateImplied != null) p.usdRate = usdRateImplied;
              if (note.trim()) p.note = note.trim();
              onSave(p);
            }}
          >
            Сохранить
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <div className="grid grid-cols-[1fr_auto] gap-2">
          <div>
            <Label htmlFor="fp-amount">Сумма</Label>
            <Input
              id="fp-amount"
              autoFocus
              inputMode="decimal"
              value={fiatAmount}
              onChange={(e) => setFiatAmount(e.target.value)}
              placeholder="200 000"
            />
          </div>
          <div>
            <Label htmlFor="fp-cur">Валюта</Label>
            {showCustomCurrency ? (
              <div className="flex h-10 items-center gap-1 rounded-md border border-warning/40 bg-warning/5 px-2 text-sm">
                <Search className="h-3.5 w-3.5 text-warning" />
                <input
                  id="fp-cur-custom"
                  autoFocus
                  value={customCode}
                  onChange={(e) =>
                    setCustomCode(e.target.value.replace(/[^A-Za-zА-Яа-я0-9]/g, ""))
                  }
                  placeholder="TRY / VND / BYN"
                  className="w-24 bg-transparent uppercase outline-none placeholder:text-muted-foreground/60"
                  maxLength={6}
                />
                <button
                  type="button"
                  onClick={() => {
                    setShowCustomCurrency(false);
                    setCustomCode("");
                  }}
                  className="ml-auto text-muted-foreground hover:text-foreground"
                  aria-label="Назад к списку"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ) : (
              <select
                id="fp-cur"
                value={fiatCurrency}
                onChange={(e) => {
                  if (e.target.value === "__custom__") {
                    setShowCustomCurrency(true);
                  } else {
                    setFiatCurrency(e.target.value as FiatCurrency);
                  }
                }}
                className="h-10 rounded-md border border-border bg-background px-2 text-sm"
              >
                {COMMON_FIAT_CURRENCIES.map((f) => (
                  <option key={f.code} value={f.code}>
                    {f.symbol} {f.code} — {f.label}
                  </option>
                ))}
                <option value="__custom__">— Другой фиат…</option>
              </select>
            )}
          </div>
        </div>
        {rate != null && primaryToken && (
          <div className="rounded border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-xs">
            <div className="text-muted-foreground">Расчётный курс:</div>
            <div className="font-semibold text-emerald-400 tabular-nums">
              {formatNumber(rate, locale, 4)} {fiatSymbol(effectiveCurrency)}{" "}
              за 1 {primaryToken.symbol}
            </div>
          </div>
        )}
        {/* Что зафиксируется в стартовый капитал ($). Поле ручного ввода
            убрано — для стейбла берём номинал полученного, для USD-фиата
            саму сумму (owner 2026-06-10). */}
        {usdAmountFinal != null ? (
          <p className="text-[11px] text-muted-foreground">
            В стартовый капитал:{" "}
            <span className="font-semibold text-foreground tabular-nums">
              ${formatNumber(usdAmountFinal, locale, 2)}
            </span>
            {usdRateImplied != null && !isUsd ? (
              <>
                {" "}
                · курс {formatNumber(usdRateImplied, locale, 2)}{" "}
                {fiatSymbol(effectiveCurrency)}/$
              </>
            ) : null}
          </p>
        ) : !isUsd && primaryToken != null ? (
          <p className="text-[11px] text-warning">
            {primaryToken.symbol} — не стейбл: $-эквивалент не зафиксируется
            здесь (разметьте стоимость отдельно).
          </p>
        ) : null}
        <div>
          <Label htmlFor="fp-note">
            Заметка{" "}
            <span className="text-muted-foreground text-[10px]">
              (опционально)
            </span>
          </Label>
          <Input
            id="fp-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="P2P / биржа / банк"
          />
        </div>
      </div>
    </Dialog>
  );
}

function CreditDialog({
  initial,
  onClose,
  onSave,
}: {
  initial?: CreditAssetAnnotation;
  onClose: () => void;
  onSave: (c: CreditAssetAnnotation) => void;
}) {
  const [note, setNote] = useState(initial?.note ?? "");
  return (
    <Dialog
      open
      onClose={onClose}
      size="sm"
      title={
        <span className="inline-flex items-center gap-2">
          <Landmark className="h-4 w-4 text-warning" />
          Кредитный актив
        </span>
      }
      description="Эта операция получает поступление, купленное на заёмные средства. Будет отслеживаться отдельно от своего капитала."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Отмена
          </Button>
          <Button
            onClick={() => {
              const c: CreditAssetAnnotation = {};
              if (note.trim()) c.note = note.trim();
              onSave(c);
            }}
          >
            Пометить как кредит
          </Button>
        </div>
      }
    >
      <div className="space-y-2">
        <div>
          <Label htmlFor="cr-note">
            Заметка{" "}
            <span className="text-muted-foreground text-[10px]">
              (например источник кредита)
            </span>
          </Label>
          <Input
            id="cr-note"
            autoFocus
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Кредит от …"
          />
        </div>
        <div className="rounded border border-warning/30 bg-warning/5 p-2 text-[11px] text-warning">
          После пометки этот актив будет отображаться отдельным цветом в
          разделе «На балансе кошельков» и учитываться в аналитике как
          кредитный капитал.
        </div>
      </div>
    </Dialog>
  );
}
