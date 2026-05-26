import { useState } from "react";
import {
  AlertTriangle,
  Database,
  DollarSign,
  RefreshCw,
  Users,
  Zap,
} from "lucide-react";
import { useNavigate } from "react-router-dom";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/features/auth/AuthProvider";
import {
  useAdminPortfolioRefreshOne,
  useAdminPortfolios,
  useAdminPortfoliosAggregate,
  useAdminPortfoliosRefreshAll,
} from "@/features/admin/portfolios/hooks";
import type { AdminAccountRow } from "@/features/admin/portfolios/api";
import { useImpersonateUser } from "@/features/admin/users/hooks";

import { PageHeader } from "./_PageHeader";

export function AdminPortfoliosPage(): JSX.Element {
  const list = useAdminPortfolios();
  const agg = useAdminPortfoliosAggregate();
  const refreshAll = useAdminPortfoliosRefreshAll();
  const [lastEnqueued, setLastEnqueued] = useState<number | null>(null);

  return (
    <div>
      <PageHeader
        title="Портфели"
        description="Все аккаунты платформы: текущий капитал, последний refresh, ошибки за 24ч. Кликни по строке — провалишься в дашборд этого пользователя (impersonation). Кнопка «Обновить» ставит задачу refresh для ВСЕХ активных аккаунтов; снэпшоты подтянутся в течение 30-60 сек."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                list.refetch();
                agg.refetch();
              }}
              disabled={list.isFetching || agg.isFetching}
            >
              Перезагрузить таблицу
            </Button>
            <Button
              variant="default"
              size="sm"
              onClick={async () => {
                const res = await refreshAll.mutateAsync();
                setLastEnqueued(res.enqueued);
              }}
              disabled={refreshAll.isPending}
            >
              <RefreshCw
                className={`mr-1.5 h-3.5 w-3.5 ${refreshAll.isPending ? "animate-spin" : ""}`}
              />
              {refreshAll.isPending
                ? "Запускаю refresh…"
                : "Обновить все портфели"}
            </Button>
          </div>
        }
      />

      {lastEnqueued !== null && !refreshAll.isPending && (
        <p className="mt-2 rounded-md border border-brand-cyan/30 bg-brand-cyan/10 px-3 py-2 text-xs text-brand-cyan">
          В очередь поставлено {lastEnqueued} задач refresh. Снапшоты
          появятся в таблице через 30-60 сек (auto-poll каждые 5 / 30 сек).
        </p>
      )}

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

      <div className="mt-4 overflow-x-auto rounded-lg border border-border bg-card/40">
        <table className="w-full min-w-[1100px] text-sm">
          <thead className="bg-card/80 text-left text-xs uppercase tracking-wider text-muted-foreground">
            <tr>
              <th className="px-4 py-3 font-medium">Аккаунт</th>
              <th className="px-4 py-3 font-medium">Владелец</th>
              <th className="px-4 py-3 font-medium text-right">Текущий капитал</th>
              <th className="px-4 py-3 font-medium">Last refresh</th>
              <th className="px-4 py-3 font-medium">Trigger</th>
              <th className="px-4 py-3 font-medium text-right">24ч</th>
              <th className="px-4 py-3 font-medium text-right">Ошибок 24ч</th>
              <th className="px-4 py-3 font-medium text-right">Refresh</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {list.isLoading && (
              <tr>
                <td
                  colSpan={8}
                  className="px-4 py-8 text-center text-muted-foreground"
                >
                  Загрузка…
                </td>
              </tr>
            )}
            {!list.isLoading && list.data?.length === 0 && (
              <tr>
                <td
                  colSpan={8}
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
  const { user: me, startImpersonation } = useAuth();
  const navigate = useNavigate();
  const impersonate = useImpersonateUser();
  const refreshOne = useAdminPortfolioRefreshOne();
  const [busy, setBusy] = useState(false);

  const isSelf = me?.id === row.ownerId;

  async function handleDrillIn() {
    if (busy) return;
    setBusy(true);
    try {
      if (isSelf) {
        // No need to impersonate own account — just navigate home.
        navigate("/", { replace: false });
        return;
      }
      const res = await impersonate.mutateAsync(row.ownerId);
      await startImpersonation({
        accessToken: res.accessToken,
        impersonatedUserId: row.ownerId,
      });
      navigate("/", { replace: false });
    } finally {
      setBusy(false);
    }
  }

  return (
    <tr
      className="cursor-pointer hover:bg-card/60"
      role="link"
      tabIndex={0}
      onClick={handleDrillIn}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          void handleDrillIn();
        }
      }}
      aria-disabled={busy}
    >
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
        <div className="text-foreground">
          {row.ownerName ?? "—"}
          {isSelf && (
            <Badge variant="muted" className="ml-2">
              это вы
            </Badge>
          )}
        </div>
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
      <td className="px-4 py-3 text-right">
        <Button
          variant="ghost"
          size="sm"
          disabled={refreshOne.isPending}
          // Останавливаем bubbling, чтобы не сработала impersonation
          // (handleDrillIn навешен на всю строку).
          onClick={(e) => {
            e.stopPropagation();
            refreshOne.mutate(row.accountId);
          }}
          onKeyDown={(e) => e.stopPropagation()}
          aria-label={`Запустить refresh для ${row.accountName}`}
        >
          <RefreshCw
            className={`h-3.5 w-3.5 ${refreshOne.isPending ? "animate-spin" : ""}`}
          />
        </Button>
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
        label="Общий капитал"
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
