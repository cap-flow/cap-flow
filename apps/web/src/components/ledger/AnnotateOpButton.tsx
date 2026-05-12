import { useState } from "react";
import { Banknote, EyeOff, Save, Trash2 } from "lucide-react";

import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label, Textarea } from "@/components/ui/label";
import { useT, useI18n } from "@/i18n/I18nProvider";
import { formatNumber } from "@/i18n/format";
import {
  useOpAnnotations,
  type OpAnnotation,
  type EnrichedOp,
} from "@/lib/ledger/annotations";

interface Props {
  op: EnrichedOp;
}

const RUB_SOURCES = ["P2P", "Bank", "Cash", "Salary", "Friend", "Other"];

/**
 * Кнопка «₽» рядом с операцией. По клику открывается диалог,
 * где пользователь проставляет: сколько ₽ потратил, источник,
 * комментарий, или отмечает «скрыть из учёта».
 *
 * Аннотация сохраняется по txHash в localStorage и автоматически
 * подмешивается в ManualOp при следующем enrichOps().
 */
export function AnnotateOpButton({ op }: Props) {
  const t = useT();
  const { locale } = useI18n();
  const [, setAnnotations] = useOpAnnotations();
  const [open, setOpen] = useState(false);

  // У ручных операций нет txHash — кнопка не имеет смысла.
  if (!op.txHash) return null;

  const current: Partial<OpAnnotation> = op.annotation ?? {};
  const hasAny =
    Boolean(current.rubAmount) ||
    Boolean(current.rubSource) ||
    Boolean(current.customComment) ||
    Boolean(current.hidden);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={
          "inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium transition-colors " +
          (hasAny
            ? "border-brand-cyan/40 bg-brand-cyan/10 text-brand-cyan"
            : "border-border bg-secondary text-muted-foreground hover:text-foreground hover:bg-accent")
        }
        title={t("ledger.annotate.button")}
      >
        <Banknote className="h-3 w-3" />
        {hasAny && current.rubAmount
          ? `${formatNumber(current.rubAmount, locale, 0)} ₽`
          : t("ledger.annotate.short")}
      </button>

      {open && (
        <AnnotateDialog
          op={op}
          initial={current}
          onClose={() => setOpen(false)}
          onSave={(next) =>
            setAnnotations((prev) => ({
              ...prev,
              [op.txHash!]: { ...next, updatedAt: Date.now() },
            }))
          }
          onDelete={() =>
            setAnnotations((prev) => {
              const c = { ...prev };
              delete c[op.txHash!];
              return c;
            })
          }
        />
      )}
    </>
  );
}

function AnnotateDialog({
  op,
  initial,
  onClose,
  onSave,
  onDelete,
}: {
  op: EnrichedOp;
  initial: Partial<OpAnnotation>;
  onClose: () => void;
  onSave: (a: OpAnnotation) => void;
  onDelete: () => void;
}) {
  const t = useT();
  const [rubAmount, setRubAmount] = useState<string>(
    initial.rubAmount != null ? String(initial.rubAmount) : "",
  );
  const [rubSource, setRubSource] = useState<string>(initial.rubSource ?? "P2P");
  const [comment, setComment] = useState<string>(initial.customComment ?? "");
  const [hidden, setHidden] = useState<boolean>(Boolean(initial.hidden));

  const rubNum = Number.parseFloat(rubAmount.replace(",", "."));
  const usdAmount = op.amount1 ?? 0;
  const computedRate =
    rubNum > 0 && usdAmount > 0 ? rubNum / usdAmount : null;

  function save() {
    const payload: OpAnnotation = { updatedAt: Date.now() };
    if (Number.isFinite(rubNum) && rubNum > 0) payload.rubAmount = rubNum;
    if (rubSource) payload.rubSource = rubSource;
    if (comment.trim()) payload.customComment = comment.trim();
    if (hidden) payload.hidden = true;
    onSave(payload);
    onClose();
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={t("ledger.annotate.title")}
      description={`${op.id} · ${op.date} · ${op.cur1 ?? ""}`}
      size="md"
      footer={
        <>
          {(initial.rubAmount || initial.customComment || initial.hidden) && (
            <Button
              variant="ghost"
              onClick={() => {
                onDelete();
                onClose();
              }}
              className="mr-auto text-destructive hover:text-destructive"
            >
              <Trash2 />
              {t("common.delete")}
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>{t("common.cancel")}</Button>
          <Button onClick={save}>
            <Save />
            {t("common.save")}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {/* Авто-факты */}
        <div className="rounded-md border border-border bg-secondary/40 p-3 text-xs text-muted-foreground">
          <span className="text-foreground font-medium">{t("ledger.annotate.detected")}:</span>{" "}
          {op.amount1 != null && op.cur1
            ? `+${op.amount1} ${op.cur1}`
            : "—"}
        </div>

        {/* RUB-сумма */}
        <div className="space-y-1.5">
          <Label htmlFor="ann-rub">{t("ledger.annotate.rub")}</Label>
          <div className="relative">
            <Input
              id="ann-rub"
              inputMode="decimal"
              value={rubAmount}
              onChange={(e) => setRubAmount(e.target.value)}
              placeholder="100000"
              className="pr-12 font-mono"
            />
            <span className="absolute inset-y-0 right-3 flex items-center text-sm text-muted-foreground">
              ₽
            </span>
          </div>
          {computedRate && (
            <p className="text-xs text-muted-foreground">
              {t("ledger.annotate.rate")}:{" "}
              <span className="font-medium text-foreground">
                {computedRate.toFixed(4)} ₽ / {op.cur1}
              </span>
            </p>
          )}
        </div>

        {/* Источник средств */}
        <div className="space-y-1.5">
          <Label htmlFor="ann-source">{t("ledger.annotate.source")}</Label>
          <select
            id="ann-source"
            value={rubSource}
            onChange={(e) => setRubSource(e.target.value)}
            className="flex h-10 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground"
          >
            {RUB_SOURCES.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </div>

        {/* Комментарий */}
        <div className="space-y-1.5">
          <Label htmlFor="ann-comment">{t("ledger.annotate.comment")}</Label>
          <Textarea
            id="ann-comment"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            rows={2}
          />
        </div>

        {/* Скрыть из учёта */}
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={hidden}
            onChange={(e) => setHidden(e.target.checked)}
            className="mt-0.5"
          />
          <span className="flex items-center gap-1.5">
            <EyeOff className="h-3.5 w-3.5 text-muted-foreground" />
            <span>
              {t("ledger.annotate.hide")}{" "}
              <span className="block text-xs text-muted-foreground">
                {t("ledger.annotate.hide.hint")}
              </span>
            </span>
          </span>
        </label>
      </div>
    </Dialog>
  );
}
