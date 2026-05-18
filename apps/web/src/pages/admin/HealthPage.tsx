/**
 * F3: admin health dashboard.
 *
 * Snapshot всех критичных subsystems: DB / Redis / Queue / Wallets / CEX.
 * Auto-refresh каждые 15s. Каждый сектор имеет color-coded status (ok /
 * warn / error) — для быстрого debug "что сломалось?".
 */
import { CheckCircle2, AlertTriangle, XCircle, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useHealthStatus } from "@/features/admin/health/hooks";
import type { SectionStatus } from "@/features/admin/health/api";

import { PageHeader } from "./_PageHeader";

function StatusIcon({ status }: { status: SectionStatus }): JSX.Element {
  if (status === "ok")
    return <CheckCircle2 className="h-5 w-5 text-emerald-400" />;
  if (status === "warn")
    return <AlertTriangle className="h-5 w-5 text-amber-400" />;
  return <XCircle className="h-5 w-5 text-destructive" />;
}

function statusClass(status: SectionStatus): string {
  if (status === "ok") return "border-emerald-500/30 bg-emerald-500/5";
  if (status === "warn") return "border-amber-500/30 bg-amber-500/5";
  return "border-destructive/30 bg-destructive/5";
}

function formatUptime(sec: number): string {
  const days = Math.floor(sec / 86400);
  const hours = Math.floor((sec % 86400) / 3600);
  const mins = Math.floor((sec % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h ${mins}m`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("ru-RU");
}

export function AdminHealthPage(): JSX.Element {
  const { data, isLoading, error, refetch, dataUpdatedAt } = useHealthStatus();

  return (
    <div>
      <PageHeader
        title="Health dashboard"
        description="Observability snapshot — DB / Redis / Queue / Wallets / CEX. Auto-refresh 15s."
        actions={
          <Button variant="outline" size="sm" onClick={() => refetch()}>
            <RefreshCw className="mr-1 h-3.5 w-3.5" />
            Обновить
          </Button>
        }
      />

      {error && (
        <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {(error as Error).message}
        </p>
      )}

      {isLoading && !data && (
        <p className="text-sm text-muted-foreground">Loading…</p>
      )}

      {data && (
        <>
          {/* Overall banner */}
          <Card className={statusClass(data.overallStatus) + " mb-4"}>
            <CardContent className="p-4 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <StatusIcon status={data.overallStatus} />
                <div>
                  <div className="font-semibold capitalize">
                    Overall: {data.overallStatus}
                  </div>
                  <div className="text-xs text-muted-foreground tabular-nums">
                    Uptime {formatUptime(data.uptimeSec)} · node {data.nodeVersion}
                    {" · "}
                    snapshot {new Date(data.generatedAt).toLocaleTimeString("ru-RU")}
                  </div>
                </div>
              </div>
              <div className="text-[10px] text-muted-foreground">
                Last fetched:{" "}
                {dataUpdatedAt
                  ? new Date(dataUpdatedAt).toLocaleTimeString("ru-RU")
                  : "—"}
              </div>
            </CardContent>
          </Card>

          {/* Sections */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            {/* DB */}
            <Card className={statusClass(data.db.status)}>
              <CardContent className="p-4 space-y-2">
                <div className="flex items-center gap-2">
                  <StatusIcon status={data.db.status} />
                  <span className="font-semibold">PostgreSQL</span>
                </div>
                {data.db.error ? (
                  <p className="text-xs text-destructive">{data.db.error}</p>
                ) : (
                  <dl className="text-xs grid grid-cols-2 gap-x-3 gap-y-1">
                    <dt className="text-muted-foreground">Ping</dt>
                    <dd className="tabular-nums">{data.db.pingMs}ms</dd>
                    <dt className="text-muted-foreground">Pool total</dt>
                    <dd className="tabular-nums">
                      {data.db.poolTotal ?? "—"}
                    </dd>
                    <dt className="text-muted-foreground">Idle</dt>
                    <dd className="tabular-nums">{data.db.poolIdle ?? "—"}</dd>
                    <dt className="text-muted-foreground">Waiting</dt>
                    <dd className="tabular-nums">
                      {data.db.poolWaiting ?? "—"}
                    </dd>
                  </dl>
                )}
              </CardContent>
            </Card>

            {/* Redis */}
            <Card className={statusClass(data.redis.status)}>
              <CardContent className="p-4 space-y-2">
                <div className="flex items-center gap-2">
                  <StatusIcon status={data.redis.status} />
                  <span className="font-semibold">Redis</span>
                </div>
                {data.redis.error ? (
                  <p className="text-xs text-destructive">{data.redis.error}</p>
                ) : (
                  <dl className="text-xs grid grid-cols-2 gap-x-3 gap-y-1">
                    <dt className="text-muted-foreground">Ping</dt>
                    <dd className="tabular-nums">{data.redis.pingMs}ms</dd>
                  </dl>
                )}
              </CardContent>
            </Card>

            {/* Queue */}
            <Card className={statusClass(data.queue.status)}>
              <CardContent className="p-4 space-y-2">
                <div className="flex items-center gap-2">
                  <StatusIcon status={data.queue.status} />
                  <span className="font-semibold">BullMQ — portfolio-refresh</span>
                </div>
                {data.queue.error ? (
                  <p className="text-xs text-destructive">{data.queue.error}</p>
                ) : (
                  <dl className="text-xs grid grid-cols-5 gap-x-2 gap-y-1">
                    <dt className="text-muted-foreground">Active</dt>
                    <dt className="text-muted-foreground">Waiting</dt>
                    <dt className="text-muted-foreground">Delayed</dt>
                    <dt className="text-muted-foreground">Completed</dt>
                    <dt className="text-muted-foreground">Failed</dt>
                    <dd className="tabular-nums">{data.queue.counts.active}</dd>
                    <dd className="tabular-nums">
                      {data.queue.counts.waiting}
                    </dd>
                    <dd className="tabular-nums">
                      {data.queue.counts.delayed}
                    </dd>
                    <dd className="tabular-nums text-muted-foreground">
                      {data.queue.counts.completed}
                    </dd>
                    <dd className="tabular-nums text-destructive">
                      {data.queue.counts.failed}
                    </dd>
                  </dl>
                )}
              </CardContent>
            </Card>

            {/* Wallets */}
            <Card className={statusClass(data.wallets.status)}>
              <CardContent className="p-4 space-y-2">
                <div className="flex items-center gap-2">
                  <StatusIcon status={data.wallets.status} />
                  <span className="font-semibold">On-chain wallets</span>
                </div>
                <dl className="text-xs grid grid-cols-2 gap-x-3 gap-y-1">
                  <dt className="text-muted-foreground">Total</dt>
                  <dd className="tabular-nums">{data.wallets.total}</dd>
                  <dt className="text-muted-foreground">With sync errors</dt>
                  <dd
                    className={
                      "tabular-nums " +
                      (data.wallets.withErrors > 0 ? "text-destructive" : "")
                    }
                  >
                    {data.wallets.withErrors}
                  </dd>
                  <dt className="text-muted-foreground">Oldest sync</dt>
                  <dd className="tabular-nums">
                    {formatDateTime(data.wallets.oldestSyncIso)}
                  </dd>
                </dl>
              </CardContent>
            </Card>

            {/* CEX */}
            <Card className={statusClass(data.cexAccounts.status)}>
              <CardContent className="p-4 space-y-2">
                <div className="flex items-center gap-2">
                  <StatusIcon status={data.cexAccounts.status} />
                  <span className="font-semibold">CEX accounts</span>
                </div>
                <dl className="text-xs grid grid-cols-2 gap-x-3 gap-y-1">
                  <dt className="text-muted-foreground">Total</dt>
                  <dd className="tabular-nums">{data.cexAccounts.total}</dd>
                  <dt className="text-muted-foreground">With sync errors</dt>
                  <dd
                    className={
                      "tabular-nums " +
                      (data.cexAccounts.withErrors > 0 ? "text-destructive" : "")
                    }
                  >
                    {data.cexAccounts.withErrors}
                  </dd>
                </dl>
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
