import { useState } from "react";

import { Button } from "@/components/ui/button";
import { useAnomalyFlags, useAnomalyScan } from "@/features/admin/anomaly/hooks";
import type { AnomalyFlag } from "@/features/admin/anomaly/api";
import { useAdminPortfolios } from "@/features/admin/portfolios/hooks";

import { PageHeader } from "./_PageHeader";

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

function FlagsTable({ flags }: { flags: AnomalyFlag[] }): JSX.Element {
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-sm">
        <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
          <tr>
            {["Severity", "Check", "Сеть", "Протокол", "Market", "Observed", "Expected", "Status", "Причина"].map(
              (h) => (
                <th key={h} className="px-3 py-2 font-medium">{h}</th>
              ),
            )}
          </tr>
        </thead>
        <tbody>
          {flags.map((f) => (
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
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function AdminAnomaliesPage(): JSX.Element {
  const [account, setAccount] = useState("");
  const [status, setStatus] = useState<string>("open");
  const accounts = useAdminPortfolios();
  const scan = useAnomalyScan();
  const flags = useAnomalyFlags({
    ...(account && { accountId: account }),
    status,
  });

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
      {flags.data && flags.data.flags.length > 0 && <FlagsTable flags={flags.data.flags} />}
    </div>
  );
}
