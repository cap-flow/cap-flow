import { AlertTriangle, Database, DollarSign, Users, Zap } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  useAdminPortfolios,
  useAdminPortfoliosAggregate,
} from "@/features/admin/portfolios/hooks";
import type { AdminAccountRow } from "@/features/admin/portfolios/api";

import { PageHeader } from "./_PageHeader";

export function AdminPortfoliosPage(): JSX.Element {
  const list = useAdminPortfolios();
  const agg = useAdminPortfoliosAggregate();

  return (
    <div>
      <PageHeader
        title="Портфели"
        description="Все аккаунты платформы: TVL, последний refresh, ошибки за 24ч."
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              list.refetch();
              agg.refetch();
            }}
          >
            Обновить
          </Button>
        }
      />

      <KpiGrid
        aggregate={agg.data}
        isLoading={agg.isLoading}
        error={(agg.error as Error | null)?.message}
      />

      {list.error && (
        <p className="mt-4 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          Ошибка загрузки: {(list.error as Error).message}
        </p>
      )}

      <div className="mt-4 overflow-hidden rounded-lg border border-border bg-card/40">
        <table className="w-full text-sm">
          <thead className="bg-card/80 text-left text-xs uppercase tracking-wider text-muted-foreground">
            <tr>
              <th className="px-4 py-3 font-medium">Аккаунт</th>
              <th className="px-4 py-3 font-medium">Владелец</th>
              <th className="px-4 py-3 font-medium text-right">TVL</th>
              <th className="px-4 py-3 font-medium">Last refresh</th>
              <th className="px-4 py-3 font-medium">Trigger</th>
              <th className="px-4 py-3 font-medium text-right">24ч</th>
              <th className="px-4 py-3 font-medium text-right">Ошибок 24ч</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {list.isLoading && (
              <tr>
                <td
                  colSpan={7}
                  className="px-4 py-8 text-center text-muted-foreground"
                >
                  Загрузка…
                </td>
              </tr>
            )}
            {!list.isLoading && list.data?.length === 0 && (
              <tr>
                <td
                  colSpan={7}
                  className="px-4 py-8 text-center text-muted-foreground"
                >
                  Нет активных аккаунтов.
                </td>
              </tr>
            )}
            {list.data?.map((row) => <Row key={row.accountId} row={row} />)}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Row({ row }: { readonly row: AdminAccountRow }) {
  return (
    <tr className="hover:bg-card/60">
      <td className="px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="font-medium text-foreground">{row.accountName}</span>
          {row.isPrimary && <Badge variant="outline">primary</Badge>}
        </div>
        <div className="font-mono text-[10px] text-muted-foreground">
          {row.accountId.slice(0, 8)}…
        </div>
      </td>
      <td className="px-4 py-3">
        <div className="text-foreground">{row.ownerName ?? "—"}</div>
        <div className="text-xs text-muted-foreground">
          {row.ownerEmail ?? "—"}
        </div>
      </td>
      <td className="px-4 py-3 text-right tabular-nums">
        {row.lastSnapshotUsd !== null
          ? `$${Math.round(row.lastSnapshotUsd).toLocaleString("ru-RU")}`
          : "—"}
      </td>
      <td className="px-4 py-3 text-muted-foreground">
        {row.lastSnapshotAt ? formatRelative(row.lastSnapshotAt) : "никогда"}
      </td>
      <td className="px-4 py-3">
        <TriggerBadge trigger={row.lastTrigger} />
      </td>
      <td className="px-4 py-3 text-right text-muted-foreground tabular-nums">
        {row.snapshotCount24h}
      </td>
      <td
        className={`px-4 py-3 text-right tabular-nums ${
          row.errors24h > 0 ? "text-destructive" : "text-muted-foreground"
        }`}
      >
        {row.errors24h}
      </td>
    </tr>
  );
}

function TriggerBadge({ trigger }: { readonly trigger: string | null }) {
  if (!trigger) return <span className="text-muted-foreground">—</span>;
  if (trigger === "cron")
    return <Badge variant="muted">cron</Badge>;
  if (trigger === "manual" || trigger === "admin" || trigger === "user")
    return <Badge variant="default">{trigger}</Badge>;
  if (trigger === "stub")
    return <Badge variant="warning">stub</Badge>;
  return <Badge variant="outline">{trigger}</Badge>;
}

// ─── KPI shapka ───────────────────────────────────────────────────────

interface KpiGridProps {
  readonly aggregate: import("@/features/admin/portfolios/api").AdminAggregate | undefined;
  readonly isLoading: boolean;
  readonly error?: string | undefined;
}

function KpiGrid({ aggregate, isLoading, error }: KpiGridProps): JSX.Element {
  if (error) {
    return (
      <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
        Не удалось загрузить агрегаты: {error}
      </p>
    );
  }
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
      <KpiCard
        icon={<Users className="h-4 w-4" />}
        label="Активных юзеров"
        value={fmtInt(aggregate?.usersActive)}
        loading={isLoading}
      />
      <KpiCard
        icon={<Database className="h-4 w-4" />}
        label="Активных аккаунтов"
        value={fmtInt(aggregate?.accountsActive)}
        loading={isLoading}
      />
      <KpiCard
        icon={<DollarSign className="h-4 w-4" />}
        label="Общий TVL"
        value={
          aggregate
            ? `$${Math.round(aggregate.totalUsd).toLocaleString("ru-RU")}`
            : "—"
        }
        loading={isLoading}
      />
      <KpiCard
        icon={<Zap className="h-4 w-4" />}
        label="Snapshots 24ч"
        value={fmtInt(aggregate?.snapshotsLast24h)}
        loading={isLoading}
      />
      <KpiCard
        icon={<AlertTriangle className="h-4 w-4" />}
        label="Ошибки 24ч"
        value={fmtInt(aggregate?.errorsLast24h)}
        loading={isLoading}
        tone={aggregate && aggregate.errorsLast24h > 0 ? "alert" : "default"}
      />
    </div>
  );
}

function KpiCard({
  icon,
  label,
  value,
  loading,
  tone = "default",
}: {
  readonly icon: React.ReactNode;
  readonly label: string;
  readonly value: string;
  readonly loading: boolean;
  readonly tone?: "default" | "alert";
}): JSX.Element {
  return (
    <div
      className={`rounded-lg border bg-card/50 p-4 ${
        tone === "alert" ? "border-destructive/40" : "border-border"
      }`}
    >
      <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-muted-foreground">
        <span
          className={tone === "alert" ? "text-destructive" : "text-brand-cyan"}
        >
          {icon}
        </span>
        {label}
      </div>
      <div
        className={`mt-2 text-2xl font-semibold tracking-tight tabular-nums ${
          tone === "alert" ? "text-destructive" : "text-foreground"
        }`}
      >
        {loading ? "…" : value}
      </div>
    </div>
  );
}

// ─── helpers ─────────────────────────────────────────────────────────

function fmtInt(n: number | undefined | null): string {
  if (n === undefined || n === null) return "—";
  return n.toLocaleString("ru-RU");
}

function formatRelative(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  const diffSec = Math.floor((Date.now() - t) / 1000);
  if (diffSec < 60) return "только что";
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)} мин назад`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} ч назад`;
  return new Date(iso).toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}
