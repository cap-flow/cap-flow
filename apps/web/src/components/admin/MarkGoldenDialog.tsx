/**
 * Admin-only dialog to mark an open position as a GOLDEN anchor or flag it as
 * WRONG (Epic A3, Q6). Both write a `golden_cases` row (kind discriminates):
 *
 *   • "Эталон"  (kind=golden) — position computes correctly → expected = the
 *     CURRENT computed startUsd, frozen. The row stays green in regression.
 *   • "Неверно" (kind=wrong)  — some metric is off. Pick WHICH (startUsd / fees
 *     / APR / PnL / current value / other). You MAY enter the correct value if
 *     you know it; if not, just flag it — the position is highlighted as
 *     suspect until the engine is fixed.
 */
import { useMemo, useState } from "react";

import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { OpenPosition } from "@/lib/portfolio/open_positions";
import type { ClassifiedOp } from "@/lib/portfolio/types";
import { buildPositionDerivation } from "@cap-flow/ucb/derivation";
import { positionKey } from "@cap-flow/ucb/identity";

import { useCreateGoldenCase } from "@/features/admin/golden/hooks";

const METHODOLOGY_VERSION = "ucb-2026-05-30";

/** Which metric is wrong (kind=wrong). */
const ISSUES: { value: string; label: string }[] = [
  { value: "start_usd", label: "Стартовая стоимость (startUsd / cost basis)" },
  { value: "current_value", label: "Текущая стоимость" },
  { value: "fees", label: "Fees / награды" },
  { value: "apr", label: "APR / доходность" },
  { value: "pnl", label: "PnL" },
  { value: "other", label: "Другое" },
];

export interface MarkGoldenDialogProps {
  open: boolean;
  onClose: () => void;
  position: OpenPosition | null;
  /** Classified ops of the position's wallet — feeds the auto-derivation. */
  walletOps: ClassifiedOp[];
  /** Engine context → authoritative lot-trace derivation (A3.6). */
  histPrices?: Map<string, number>;
  costBasisOverrideByHash?: ReadonlyMap<string, number>;
}

export function MarkGoldenDialog({
  open,
  onClose,
  position,
  walletOps,
  histPrices,
  costBasisOverrideByHash,
}: MarkGoldenDialogProps) {
  const create = useCreateGoldenCase();
  const [mode, setMode] = useState<"golden" | "wrong">("golden");
  const [issue, setIssue] = useState<string>("start_usd");
  const [expected, setExpected] = useState("");
  const [label, setLabel] = useState("");
  const [note, setNote] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const [seededFor, setSeededFor] = useState<string | null>(null);
  if (position && seededFor !== position.id) {
    setSeededFor(position.id);
    setMode("golden");
    setIssue("start_usd");
    setExpected("");
    setLabel(position.id);
    setNote("");
    setErr(null);
  }

  // A3.6: derive the cause-effect (engine lot-trace) once — used for BOTH the
  // live preview below and the saved payload. The operator reviews WHY the
  // number holds before anchoring it.
  const derivation = useMemo(
    () =>
      position
        ? buildPositionDerivation(
            position,
            walletOps,
            Math.floor(Date.now() / 1000),
            {
              ...(histPrices && { histPrices }),
              ...(costBasisOverrideByHash && { costBasisOverrideByHash }),
              // Pin WAC: the derivation must deterministically reproduce the
              // DISPLAYED startUsd (computed with WAC), not follow the page's
              // volatile FIFO/LIFO/WAC toggle.
              methodology: "WAC",
            },
          )
        : null,
    [position, walletOps, histPrices, costBasisOverrideByHash],
  );

  if (!position) return null;

  const currentStart = position.startUsd;
  const currentValue = position.supplyTokens.reduce((s, t) => s + t.currentUsd, 0);
  const hasExpected = expected.trim() !== "" && Number.isFinite(Number(expected));

  const submit = async (): Promise<void> => {
    setErr(null);
    try {
      // Golden: freeze current startUsd. Wrong: send the corrected startUsd
      // only when the issue is start_usd AND the user entered a value.
      const expectedStartUsd =
        mode === "golden"
          ? currentStart
          : issue === "start_usd" && hasExpected
            ? Number(expected)
            : null;
      await create.mutateAsync({
        walletId: position.walletId.startsWith("api:")
          ? (position.walletId.split(":")[1] ?? position.walletId)
          : position.walletId,
        positionId: position.id,
        chain: position.chain,
        protocolId: position.protocol.id,
        marketKey: position.lpTokenId ?? null,
        openHash: position.openHash,
        label: label.trim() || position.id,
        positionKey: positionKey(position),
        kind: mode,
        issue: mode === "wrong" ? issue : null,
        derivation,
        expectedStartUsd,
        expectedNetStartUsd: mode === "golden" ? position.netStartUsd : null,
        expectedPnlUsd: null,
        toleranceAbsUsd: 1,
        tolerancePct: 0.02,
        // Single source of truth is always the blockchain operations.
        sourceOfTruth: "chain_ops",
        provenanceNote: note.trim() || null,
        methodologyVersion: METHODOLOGY_VERSION,
        fixturePath: null,
      });
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Ошибка сохранения");
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Отметить позицию"
      description={`${position.protocol.name} · ${position.chain} · ${position.id}`}
      size="sm"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            Отмена
          </Button>
          <Button onClick={() => void submit()} disabled={create.isPending}>
            {create.isPending
              ? "Сохраняем…"
              : mode === "golden"
                ? "Сохранить эталон"
                : "Пометить неверной"}
          </Button>
        </div>
      }
    >
      <div className="space-y-3 text-sm">
        {/* mode toggle */}
        <div className="inline-flex rounded-md border border-border p-0.5">
          <button
            type="button"
            onClick={() => setMode("golden")}
            className={
              "rounded px-3 py-1 text-xs " +
              (mode === "golden" ? "bg-emerald-600 text-white" : "text-muted-foreground")
            }
          >
            ✓ Эталон (верно)
          </button>
          <button
            type="button"
            onClick={() => setMode("wrong")}
            className={
              "rounded px-3 py-1 text-xs " +
              (mode === "wrong" ? "bg-amber-600 text-white" : "text-muted-foreground")
            }
          >
            ✎ Неверно (нужен фикс)
          </button>
        </div>

        <div className="rounded border border-border bg-muted/30 px-3 py-2 text-xs space-y-0.5">
          <div>
            Текущее <b>startUsd</b>: ${currentStart.toFixed(2)}
          </div>
          <div>
            Текущая стоимость: ${currentValue.toFixed(2)}
            {currentStart > 0 && currentValue > currentStart * 5 && (
              <span className="ml-1 text-amber-500">
                ⚠ в {(currentValue / currentStart).toFixed(0)}× больше старта
              </span>
            )}
          </div>
        </div>

        {/* A3.6 — engine lot-trace preview: WHY the cost basis is what it is. */}
        {derivation && (
          <div className="rounded border border-border bg-muted/20 px-3 py-2 text-[11px] space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="font-medium text-foreground">
                Причинно-следственная трасса (движок)
              </span>
              {derivation.engineTraced ? (
                <span className="rounded bg-emerald-600/20 px-1.5 py-0.5 text-emerald-500">
                  ✓ полностью выведено из операций
                </span>
              ) : (
                <span className="rounded bg-amber-600/20 px-1.5 py-0.5 text-amber-500">
                  ⚠ неполная провенанс
                </span>
              )}
            </div>
            {derivation.tokenTraces.length === 0 ? (
              <div className="text-muted-foreground">
                Лот-трасса пуста (стейблы / нет on-chain покупок в истории
                кошелька). startUsd = ${currentStart.toFixed(2)}.
              </div>
            ) : (
              derivation.tokenTraces.map((tr) => (
                <div key={tr.symbol} className="space-y-0.5">
                  <div className="text-foreground">
                    <b>{tr.symbol}</b>: {tr.totalAmountSupplied.toFixed(4)} ·
                    cost ${tr.totalCostUsd.toFixed(2)} · WAC $
                    {tr.effectiveWac.toFixed(4)}/ед · {tr.methodology}
                    {tr.uncoveredAmount > 1e-9 && (
                      <span className="ml-1 text-amber-500">
                        (не покрыто {tr.uncoveredAmount.toFixed(4)})
                      </span>
                    )}
                  </div>
                  {tr.lots.map((l, i) => (
                    <div
                      key={`${tr.symbol}-${i}`}
                      className="pl-3 text-muted-foreground"
                    >
                      ← {l.acquiredDate} · {l.amount.toFixed(4)} {l.symbol} @ $
                      {l.costPerUnit.toFixed(4)} = ${l.costUsd.toFixed(2)} ·{" "}
                      {l.opType ?? l.acquiredVia}
                      {l.sourceHash && (
                        <span className="ml-1 font-mono opacity-70">
                          {l.sourceHash.slice(0, 8)}…
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              ))
            )}
          </div>
        )}

        {mode === "golden" ? (
          <div className="text-xs text-emerald-500">
            Заморозим текущие значения как эталон. Регресс будет зелёным, пока
            движок выдаёт эти числа.
          </div>
        ) : (
          <>
            <label className="block">
              <span className="text-xs text-muted-foreground">Что неверно?</span>
              <select
                value={issue}
                onChange={(e) => setIssue(e.target.value)}
                className="mt-1 w-full rounded border border-border bg-background px-2 py-1 text-sm"
              >
                {ISSUES.map((i) => (
                  <option key={i.value} value={i.value}>
                    {i.label}
                  </option>
                ))}
              </select>
            </label>
            {issue === "start_usd" && (
              <label className="block">
                <span className="text-xs text-muted-foreground">
                  Правильное startUsd (необязательно — если знаешь)
                </span>
                <Input
                  type="number"
                  value={expected}
                  onChange={(e) => setExpected(e.target.value)}
                  placeholder="напр. 237.80 — или оставь пустым"
                />
              </label>
            )}
            <div className="text-xs text-amber-500">
              Позиция будет подсвечена как неверная. Если правильное значение
              неизвестно — просто опиши проблему в заметке ниже.
            </div>
          </>
        )}

        <label className="block">
          <span className="text-xs text-muted-foreground">Метка (label)</span>
          <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="POS-011" />
        </label>

        <div className="rounded border border-border bg-muted/20 px-3 py-2 text-[11px] text-muted-foreground">
          Источник истины — <b>операции блокчейна</b>. При сохранении система сама
          разберёт операции этой позиции из реестра и запишет причинно-следственную
          трассу (почему число такое) как базу знаний.
        </div>

        <label className="block">
          <span className="text-xs text-muted-foreground">
            {mode === "golden"
              ? "Как установлена истина (derivation note)"
              : "Описание проблемы / как должно быть"}
          </span>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            placeholder={
              mode === "golden"
                ? "напр. live → ownerOf(gauge) → NFT 3427422 → mint tx → DefiLlama @block → $237.80"
                : "напр. fees начислены, хотя позиция без наград; startUsd должен быть ~$238"
            }
            className="mt-1 w-full rounded border border-border bg-background px-2 py-1 text-sm"
          />
        </label>

        {err && <div className="text-xs text-red-500">{err}</div>}
      </div>
    </Dialog>
  );
}
