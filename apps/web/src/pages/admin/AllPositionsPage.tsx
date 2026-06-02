import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { useAllPositions } from "@/features/admin/all-positions/hooks";
import type { AllPositionRow } from "@/features/admin/all-positions/api";

import { PageHeader } from "./_PageHeader";

function usd(n: number | null): string {
  if (n == null) return "—";
  return `$${(Math.round(n * 100) / 100).toLocaleString("en-US")}`;
}

function AnomalyBadge({ row }: { row: AllPositionRow }): JSX.Element {
  if (row.anomalies.length === 0) return <span className="text-success">✓</span>;
  const hasError = row.anomalies.some((a) => a.severity === "error");
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-xs ${hasError ? "bg-destructive/15 text-destructive" : "bg-amber-500/15 text-amber-600"}`}
      title={row.anomalies.map((a) => `${a.severity} ${a.checkId}: ${a.reason}`).join("\n")}
    >
      ⚠ {row.anomalies.length}
    </span>
  );
}

export function AdminAllPositionsPage(): JSX.Element {
  const q = useAllPositions();
  const [search, setSearch] = useState("");
  const [onlyAnomalies, setOnlyAnomalies] = useState(false);

  const rows = useMemo(() => {
    const all = q.data?.positions ?? [];
    const s = search.trim().toLowerCase();
    return all.filter((r) => {
      if (onlyAnomalies && r.anomalies.length === 0) return false;
      if (!s) return true;
      return (
        (r.ownerEmail ?? "").toLowerCase().includes(s) ||
        (r.accountName ?? "").toLowerCase().includes(s) ||
        r.protocolId.toLowerCase().includes(s) ||
        r.symbol.toLowerCase().includes(s) ||
        r.chain.toLowerCase().includes(s)
      );
    });
  }, [q.data, search, onlyAnomalies]);

  const anomalyCount = (q.data?.positions ?? []).filter((r) => r.anomalies.length > 0).length;

  return (
    <div>
      <PageHeader
        title="Все позиции"
        description="Единый реестр открытых позиций со всех аккаунтов (серверный канонический расчёт). Обновляется автоматически по мере пересчёта воркером. Аномалии — находки детектора (включая дрейф от эталонов)."
        actions={
          <Button variant="outline" size="sm" onClick={() => q.refetch()}>
            Обновить
          </Button>
        }
      />

      <div className="mb-3 flex flex-wrap items-center gap-3 text-sm">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="поиск: email / протокол / актив / сеть"
          className="w-80 rounded-md border border-border bg-background px-3 py-1.5 text-sm"
        />
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={onlyAnomalies} onChange={(e) => setOnlyAnomalies(e.target.checked)} />
          только с аномалиями
        </label>
        <span className="text-muted-foreground">
          {q.data ? `${q.data.accounts} аккаунтов · ${q.data.positions.length} позиций · аномалий: ${anomalyCount}` : ""}
        </span>
      </div>

      {q.error && (
        <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {(q.error as Error).message}
        </p>
      )}
      {q.data && q.data.positions.length === 0 && (
        <p className="text-sm text-muted-foreground">
          Нет посчитанных позиций. Аккаунт появляется здесь после серверного расчёта (флаг ucbServerShadow ON / кнопка
          «Рассчитать» на UCB Server / прогон воркера).
        </p>
      )}

      {rows.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
              <tr>
                {["Владелец", "Сеть", "Протокол", "Активы", "NFT", "startUsd", "Сейчас", "PnL", "Fees", "Аномалии", "Метод."].map(
                  (h) => (
                    <th key={h} className="px-3 py-2 font-medium">{h}</th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const pnlNeg = r.netPnlUsd < 0;
                return (
                  <tr key={`${r.accountId}|${r.positionId}`} className="border-t border-border/60 hover:bg-muted/30">
                    <td className="px-3 py-2">{r.ownerEmail ?? r.accountName ?? r.accountId.slice(0, 8)}</td>
                    <td className="px-3 py-2">{r.chain}</td>
                    <td className="px-3 py-2">{r.protocolId}</td>
                    <td className="px-3 py-2">{r.symbol || "—"}</td>
                    <td className="px-3 py-2 font-mono text-xs">{r.matchedV3TokenId ?? "—"}</td>
                    <td className="px-3 py-2 font-medium">{usd(r.startUsd)}</td>
                    <td className="px-3 py-2">{usd(r.currentUsd)}</td>
                    <td className={`px-3 py-2 ${pnlNeg ? "text-destructive" : r.netPnlUsd ? "text-success" : ""}`}>{usd(r.netPnlUsd)}</td>
                    <td className="px-3 py-2">{usd(r.feesUsd)}</td>
                    <td className="px-3 py-2"><AnomalyBadge row={r} /></td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">{r.methodology}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
