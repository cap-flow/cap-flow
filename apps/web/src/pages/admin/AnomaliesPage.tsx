import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  useAnomalyFlags,
  useAnomalyScan,
  usePromoteAnomaly,
  useResolveAnomaly,
} from "@/features/admin/anomaly/hooks";
import type { AnomalyFlag } from "@/features/admin/anomaly/api";
import { useAdminPortfolios } from "@/features/admin/portfolios/hooks";

import { PageHeader } from "./_PageHeader";

const SOURCES = ["manual", "krystal", "etherscan_v2", "revert_ui"] as const;

const STATUSES = ["open", "acknowledged", "resolved", "promoted"] as const;

function sevClass(sev: string): string {
  if (sev === "error") return "bg-destructive/15 text-destructive";
  if (sev === "warn") return "bg-amber-500/15 text-amber-600";
  return "bg-muted text-muted-foreground";
}

function num(s: string | null): string {
  if (s == null) return "—";
  const n = Number(s);
  return Number.isFinite(n) ? `$${(Math.round(n * 100) / 100).toLocaleString("en-US")}` : s;
}

interface FlagsTableProps {
  flags: AnomalyFlag[];
  onAck: (f: AnomalyFlag) => void;
  onResolve: (f: AnomalyFlag) => void;
  onPromote: (f: AnomalyFlag) => void;
  pending: boolean;
}

function FlagsTable({ flags, onAck, onResolve, onPromote, pending }: FlagsTableProps): JSX.Element {
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-sm">
        <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
          <tr>
            {["Severity", "Check", "Сеть", "Протокол", "Market", "Observed", "Expected", "Status", "Причина", "Действия"].map(
              (h) => (
                <th key={h} className="px-3 py-2 font-medium">{h}</th>
              ),
            )}
          </tr>
        </thead>
        <tbody>
          {flags.map((f) => {
            const actionable = f.status === "open" || f.status === "acknowledged";
            const isPosition = !!f.positionId;
            return (
              <tr key={f.id} className="border-t border-border/60 hover:bg-muted/30 align-top">
                <td className="px-3 py-2">
                  <span className={`rounded px-1.5 py-0.5 text-xs ${sevClass(f.severity)}`}>{f.severity}</span>
                </td>
                <td className="px-3 py-2 font-mono text-xs">{f.checkId}</td>
                <td className="px-3 py-2">{f.chain ?? "—"}</td>
                <td className="px-3 py-2">{f.protocolId ?? "—"}</td>
                <td className="px-3 py-2 font-mono text-xs">{f.marketKey ? f.marketKey.slice(0, 12) : "—"}</td>
                <td className="px-3 py-2">{num(f.observedValue)}</td>
                <td className="px-3 py-2">{num(f.expectedValue)}</td>
                <td className="px-3 py-2">{f.status}</td>
                <td className="px-3 py-2 max-w-md text-xs text-muted-foreground">
                  {String((f.detail as { reason?: string } | null)?.reason ?? "")}
                </td>
                <td className="px-3 py-2">
                  {actionable ? (
                    <div className="flex flex-wrap gap-1">
                      {f.status === "open" && (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={pending}
                          onClick={() => onAck(f)}
                        >
                          Принять
                        </Button>
                      )}
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={pending}
                        onClick={() => onResolve(f)}
                      >
                        Закрыть
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={pending || !isPosition}
                        title={isPosition ? undefined : "Промоут доступен только для аномалий уровня позиции"}
                        onClick={() => onPromote(f)}
                      >
                        В эталон
                      </Button>
                    </div>
                  ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

interface PromoteDialogProps {
  flag: AnomalyFlag | null;
  onClose: () => void;
}

function PromoteDialog({ flag, onClose }: PromoteDialogProps): JSX.Element | null {
  const promote = usePromoteAnomaly();
  const [label, setLabel] = useState("");
  const [source, setSource] = useState<string>("manual");
  const [expected, setExpected] = useState("");
  const [note, setNote] = useState("");
  const [err, setErr] = useState<string | null>(null);

  // Сидируем поля при смене аномалии (паттерн MarkGoldenDialog).
  const [seededFor, setSeededFor] = useState<string | null>(null);
  if (flag && seededFor !== flag.id) {
    setSeededFor(flag.id);
    setLabel(`${flag.checkId} · ${flag.positionId ?? flag.accountId.slice(0, 8)}`);
    setSource("manual");
    const obs = flag.observedValue == null ? NaN : Number(flag.observedValue);
    setExpected(Number.isFinite(obs) ? String(obs) : "0");
    setNote("");
    setErr(null);
  }

  if (!flag) return null;

  const submit = async (): Promise<void> => {
    setErr(null);
    try {
      const n = Number(expected);
      await promote.mutateAsync({
        id: flag.id,
        body: {
          label: label.trim() || flag.checkId,
          expectedStartUsd: Number.isFinite(n) ? n : 0,
          expectedNetStartUsd: null,
          expectedPnlUsd: null,
          toleranceAbsUsd: 1,
          tolerancePct: 0.02,
          sourceOfTruth: source,
          provenanceNote: note.trim() || null,
          methodologyVersion: "ucb@dev",
          fixturePath: null,
        },
      });
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Ошибка промоута");
    }
  };

  return (
    <Dialog
      open={!!flag}
      onClose={onClose}
      title="Промоут в эталон"
      description={`${flag.checkId} · ${flag.chain ?? "—"} · ${flag.positionId ?? flag.accountId}`}
      size="sm"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            Отмена
          </Button>
          <Button onClick={() => void submit()} disabled={promote.isPending}>
            {promote.isPending ? "Сохраняем…" : "Создать эталон"}
          </Button>
        </div>
      }
    >
      <div className="space-y-3 text-sm">
        <label className="block">
          <span className="text-xs text-muted-foreground">Метка (label)</span>
          <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="POS-011" />
        </label>

        <label className="block">
          <span className="text-xs text-muted-foreground">Источник истины</span>
          <select
            value={source}
            onChange={(e) => setSource(e.target.value)}
            className="mt-1 w-full rounded border border-border bg-background px-2 py-1 text-sm"
          >
            {SOURCES.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="text-xs text-muted-foreground">expectedStartUsd</span>
          <Input
            type="number"
            value={expected}
            onChange={(e) => setExpected(e.target.value)}
            placeholder="напр. 237.80"
          />
        </label>

        <label className="block">
          <span className="text-xs text-muted-foreground">Provenance note</span>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            placeholder="напр. live → ownerOf(gauge) → NFT → mint tx → цена @block"
            className="mt-1 w-full rounded border border-border bg-background px-2 py-1 text-sm"
          />
        </label>

        {err && <div className="text-xs text-red-500">{err}</div>}
      </div>
    </Dialog>
  );
}

export function AdminAnomaliesPage(): JSX.Element {
  const [account, setAccount] = useState("");
  const [status, setStatus] = useState<string>("open");
  const accounts = useAdminPortfolios();
  const scan = useAnomalyScan();
  const resolve = useResolveAnomaly();
  const flags = useAnomalyFlags({
    ...(account && { accountId: account }),
    status,
  });
  const [promoteFlag, setPromoteFlag] = useState<AnomalyFlag | null>(null);

  const options = (accounts.data ?? [])
    .slice()
    .sort((a, b) => (a.ownerEmail ?? "").localeCompare(b.ownerEmail ?? ""));

  return (
    <div>
      <PageHeader
        title="Аномалии"
        description="Детектор сверяет серверный canonical-расчёт с эталонами (golden_case_drift) + инварианты. Запусти скан аккаунта или смотри накопленные находки."
      />

      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground">Аккаунт (для скана и фильтра)</label>
          <select
            value={account}
            onChange={(e) => setAccount(e.target.value)}
            disabled={accounts.isLoading}
            className="w-96 rounded-md border border-border bg-background px-3 py-1.5 text-sm"
          >
            <option value="">— все аккаунты —</option>
            {options.map((a) => (
              <option key={a.accountId} value={a.accountId}>
                {(a.ownerEmail ?? a.ownerName ?? "—") + " · " + a.accountName + " · " + a.accountId.slice(0, 8)}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground">Статус</label>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="rounded-md border border-border bg-background px-3 py-1.5 text-sm"
          >
            {STATUSES.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </div>
        <Button onClick={() => account && scan.mutate(account)} disabled={!account || scan.isPending}>
          {scan.isPending ? "Сканирую…" : "Сканировать аккаунт"}
        </Button>
        <Button variant="outline" onClick={() => flags.refetch()}>Обновить</Button>
      </div>

      {scan.data && (
        <div className="mb-4 rounded-md border border-border bg-muted/30 px-3 py-2 text-sm">
          {scan.data.notFound ? (
            <span className="text-amber-600">Аккаунт не найден.</span>
          ) : (
            scan.data.accounts.map((a) => (
              <div key={a.accountId}>
                {a.accountId.slice(0, 8)}:{" "}
                {a.skipped
                  ? "пропущен (нет серверного расчёта — запусти UCB Server / refresh)"
                  : `${a.positions} позиций, ${a.goldenCases} эталонов → ${a.findings} находок (${JSON.stringify(a.bySeverity ?? {})}), авто-резолв ${a.resolved}`}
              </div>
            ))
          )}
        </div>
      )}

      {flags.error && (
        <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {(flags.error as Error).message}
        </p>
      )}
      {flags.data && flags.data.flags.length === 0 && (
        <p className="text-sm text-muted-foreground">Находок со статусом «{status}» нет.</p>
      )}
      {flags.data && flags.data.flags.length > 0 && (
        <FlagsTable
          flags={flags.data.flags}
          pending={resolve.isPending}
          onAck={(f) => resolve.mutate({ id: f.id, body: { status: "acknowledged", note: null } })}
          onResolve={(f) => resolve.mutate({ id: f.id, body: { status: "resolved", note: null } })}
          onPromote={(f) => setPromoteFlag(f)}
        />
      )}

      <PromoteDialog flag={promoteFlag} onClose={() => setPromoteFlag(null)} />
    </div>
  );
}
