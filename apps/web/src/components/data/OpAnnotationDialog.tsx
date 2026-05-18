/**
 * UCB A3: editor для per-op annotations (override classifier'а).
 *
 * Открывается из строки RawOpsTable, позволяет:
 *   - Установить флаг "internal transfer" (yes / no / auto)
 *   - Override op_type (e.g. неверно классифицированный swap → transfer_in)
 *   - Override cost basis (USD)
 *   - Оставить note для самого себя
 *
 * Caller передаёт `chainOpId` (UUID из chain_operations). Если op ещё НЕ
 * запушен на server (Phase 1 push асинхронный), `chainOpId` будет null и
 * мы показываем disabled-состояние "wait for sync".
 */
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import {
  useDeleteAnnotation,
  useUpsertAnnotation,
  useUpsertAnnotationByKey,
} from "@/features/chain-ops/hooks";
import type { ResolvedAnnotation } from "@/features/chain-ops/api";

interface Props {
  open: boolean;
  onClose: () => void;
  /** Server `chain_operations.id` — null если annotation ещё не создан. */
  chainOpId: string | null;
  /** Composite key для first-create case. */
  walletId: string;
  txHash: string;
  logIndex: number;
  opType: string;
  /** Текущая аннотация (если есть) — pre-fill формы. */
  current: ResolvedAnnotation | null;
}

const OP_TYPE_OPTIONS = [
  "transfer_in",
  "transfer_out",
  "bridge_in",
  "bridge_out",
  "deposit_fiat",
  "withdraw_fiat",
  "swap",
  "lend_supply",
  "lend_withdraw",
  "borrow",
  "repay",
  "lp_add",
  "lp_remove",
  "claim_rewards",
  "approve",
  "unknown",
] as const;

type InternalChoice = "auto" | "yes" | "no";

function asInternalChoice(v: boolean | null): InternalChoice {
  if (v === true) return "yes";
  if (v === false) return "no";
  return "auto";
}

function fromInternalChoice(c: InternalChoice): boolean | null {
  if (c === "yes") return true;
  if (c === "no") return false;
  return null;
}

export function OpAnnotationDialog({
  open,
  onClose,
  chainOpId,
  walletId,
  txHash,
  logIndex,
  opType,
  current,
}: Props) {
  const upsert = useUpsertAnnotation();
  const upsertByKey = useUpsertAnnotationByKey();
  const del = useDeleteAnnotation();

  const [internal, setInternal] = useState<InternalChoice>("auto");
  const [manualOpType, setManualOpType] = useState<string>("");
  const [manualCostBasis, setManualCostBasis] = useState<string>("");
  const [note, setNote] = useState<string>("");
  const [excluded, setExcluded] = useState<boolean>(false);

  // Re-prefill на открытие / смену current (e.g. другой op).
  useEffect(() => {
    if (!open) return;
    setInternal(asInternalChoice(current?.isInternalTransfer ?? null));
    setManualOpType(current?.manualOpType ?? "");
    setManualCostBasis(
      current?.manualCostBasisUsd != null
        ? String(current.manualCostBasisUsd)
        : "",
    );
    setNote(current?.note ?? "");
    setExcluded(current?.excluded ?? false);
  }, [open, current]);

  // Composite-key path работает всегда (server резолвит UUID), поэтому
  // dialog активен даже когда `chainOpId` null. Сервер вернёт 403 если
  // op ещё не доехал до chain_operations — UI покажет error.
  const canSave = true;
  const busy = upsert.isPending || upsertByKey.isPending;

  const handleSave = (): void => {
    const cbNum =
      manualCostBasis.trim() === "" ? null : Number(manualCostBasis);
    const body = {
      isInternalTransfer: fromInternalChoice(internal),
      manualCostBasisUsd:
        cbNum != null && Number.isFinite(cbNum) && cbNum >= 0 ? cbNum : null,
      manualOpType: manualOpType.trim() === "" ? null : manualOpType.trim(),
      note: note.trim() === "" ? null : note.trim(),
      excluded,
    };
    if (chainOpId) {
      upsert.mutate({ opId: chainOpId, body }, { onSuccess: onClose });
    } else {
      upsertByKey.mutate(
        { ...body, walletId, txHash, logIndex },
        { onSuccess: onClose },
      );
    }
  };

  const handleClear = (): void => {
    if (!chainOpId) return;
    del.mutate(chainOpId, { onSuccess: onClose });
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Аннотация операции"
      description={`Tx ${txHash.slice(0, 10)}… · auto-type: ${opType}`}
      size="md"
      footer={
        <>
          {current && (
            <Button
              variant="ghost"
              onClick={handleClear}
              disabled={!canSave || del.isPending}
            >
              Очистить
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            Отмена
          </Button>
          <Button onClick={handleSave} disabled={!canSave || busy}>
            {busy ? "Сохраняем…" : "Сохранить"}
          </Button>
        </>
      }
    >
      <div className="space-y-4 text-sm">
        <div>
          <label className="block text-xs uppercase tracking-wider text-muted-foreground mb-1">
            Internal transfer?
          </label>
          <div className="flex items-center gap-2">
            {(["auto", "yes", "no"] as InternalChoice[]).map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setInternal(c)}
                className={
                  "rounded border px-3 py-1 text-xs transition " +
                  (internal === c
                    ? "border-brand-cyan bg-brand-cyan/20 text-brand-cyan"
                    : "border-border text-muted-foreground hover:bg-accent/40")
                }
              >
                {c === "auto" ? "Auto" : c === "yes" ? "Да (force)" : "Нет (force)"}
              </button>
            ))}
          </div>
          <p className="mt-1 text-[10px] text-muted-foreground">
            Auto — detector сам решает. Yes/No — override результата A1/A2.
          </p>
        </div>

        <div>
          <label className="block text-xs uppercase tracking-wider text-muted-foreground mb-1">
            Override op_type
          </label>
          <select
            value={manualOpType}
            onChange={(e) => setManualOpType(e.target.value)}
            className="w-full rounded border border-border bg-background px-2 py-1 text-xs"
          >
            <option value="">— без override —</option>
            {OP_TYPE_OPTIONS.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-xs uppercase tracking-wider text-muted-foreground mb-1">
            Override cost basis (USD)
          </label>
          <input
            type="number"
            min={0}
            step="0.01"
            value={manualCostBasis}
            onChange={(e) => setManualCostBasis(e.target.value)}
            placeholder="например 1234.56"
            className="w-full rounded border border-border bg-background px-2 py-1 text-xs tabular-nums"
          />
        </div>

        <div>
          <label className="flex items-start gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={excluded}
              onChange={(e) => setExcluded(e.target.checked)}
              className="mt-0.5 accent-destructive"
            />
            <div>
              <span className="block text-xs font-medium text-destructive">
                Исключить из UCB-pipeline (soft-delete)
              </span>
              <p className="text-[10px] text-muted-foreground">
                Операция не повлияет на cost basis, asset rollup, realized PnL.
                Полезно для spam-airdrops или явных ошибок классификатора.
                Не удаляет данные — можно снять галку обратно.
              </p>
            </div>
          </label>
        </div>

        <div>
          <label className="block text-xs uppercase tracking-wider text-muted-foreground mb-1">
            Заметка
          </label>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            maxLength={2000}
            placeholder="Свободный текст — почему правка, контекст…"
            className="w-full rounded border border-border bg-background px-2 py-1 text-xs resize-y"
          />
        </div>

        {upsert.isError && (
          <p className="text-xs text-destructive">
            Ошибка: {(upsert.error as Error).message}
          </p>
        )}
        {upsertByKey.isError && (
          <p className="text-xs text-destructive">
            Ошибка: {(upsertByKey.error as Error).message}
          </p>
        )}
        {del.isError && (
          <p className="text-xs text-destructive">
            Ошибка удаления: {(del.error as Error).message}
          </p>
        )}
      </div>
    </Dialog>
  );
}
