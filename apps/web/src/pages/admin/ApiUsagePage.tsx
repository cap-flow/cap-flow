import { useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  useApiUsageQuotas,
  useApiUsageRecent,
  useApiUsageSummary,
} from "@/features/admin/api-usage/hooks";
import { useAdminUsers } from "@/features/admin/users/hooks";
import type {
  ApiUsageRecent,
  ApiUsageSummary,
} from "@/features/admin/api-usage/api";
import { cn } from "@/lib/utils";

import { PageHeader } from "./_PageHeader";

const WINDOWS = [
  { hours: 1, label: "1ч" },
  { hours: 24, label: "24ч" },
  { hours: 24 * 7, label: "7д" },
  { hours: 24 * 30, label: "30д" },
];

export function AdminApiUsagePage(): JSX.Element {
  const [hours, setHours] = useState(24);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);

  const summary = useApiUsageSummary(hours);
  const recent = useApiUsageRecent(50);
  const users = useAdminUsers({});
  const quotas = useApiUsageQuotas(selectedUserId);

  const usersById = useMemo(() => {
    const m = new Map<string, { email: string | null; name: string | null }>();
    users.data?.forEach((u) => m.set(u.id, { email: u.email, name: u.name }));
    return m;
  }, [users.data]);

  return (
    <div>
      <PageHeader
        title="Расходы API"
        description="Per-provider summary · топ-юзеры · последние вызовы · квоты."
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              summary.refetch();
              recent.refetch();
            }}
          >
            Обновить
          </Button>
        }
      />

      <div className="mb-4 inline-flex rounded-md border border-border bg-card/40 p-1">
        {WINDOWS.map((w) => (
          <button
            key={w.hours}
            type="button"
            onClick={() => setHours(w.hours)}
            className={cn(
              "rounded px-3 py-1 text-xs font-medium transition-colors",
              hours === w.hours
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {w.label}
          </button>
        ))}
      </div>

      <section className="mb-6">
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          По провайдерам
        </h2>
        <ProviderTable summary={summary.data} loading={summary.isLoading} />
      </section>

      <section className="mb-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <TopUsers
          summary={summary.data}
          usersById={usersById}
          onSelect={setSelectedUserId}
          selected={selectedUserId}
        />
        <QuotaPanel
          userId={selectedUserId}
          userLabel={
            selectedUserId
              ? (usersById.get(selectedUserId)?.email ?? selectedUserId)
              : ""
          }
          data={quotas.data}
          loading={quotas.isLoading}
          onClear={() => setSelectedUserId(null)}
        />
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Последние вызовы (50)
        </h2>
        <RecentTable
          rows={recent.data}
          loading={recent.isLoading}
          usersById={usersById}
        />
      </section>
    </div>
  );
}

function ProviderTable({
  summary,
  loading,
}: {
  readonly summary: ApiUsageSummary | undefined;
  readonly loading: boolean;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card/40">
      <table className="w-full text-sm">
        <thead className="bg-card/80 text-left text-xs uppercase tracking-wider text-muted-foreground">
          <tr>
            <th className="px-3 py-2 font-medium">Провайдер</th>
            <th className="px-3 py-2 text-right font-medium">Calls</th>
            <th className="px-3 py-2 text-right font-medium">Cache hits</th>
            <th className="px-3 py-2 text-right font-medium">Errors</th>
            <th className="px-3 py-2 text-right font-medium">Cost (USD)</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {loading && (
            <tr>
              <td colSpan={5} className="px-3 py-6 text-center text-muted-foreground">
                Загрузка…
              </td>
            </tr>
          )}
          {!loading && summary?.perProvider.length === 0 && (
            <tr>
              <td colSpan={5} className="px-3 py-6 text-center text-muted-foreground">
                Нет вызовов в окне.
              </td>
            </tr>
          )}
          {summary?.perProvider.map((p) => (
            <tr key={p.provider} className="hover:bg-card/60">
              <td className="px-3 py-2 font-medium">{p.provider}</td>
              <td className="px-3 py-2 text-right tabular-nums">{p.calls}</td>
              <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                {p.cacheHits}
                {p.calls > 0 && (
                  <span className="ml-1 text-[10px]">
                    ({Math.round((p.cacheHits / p.calls) * 100)}%)
                  </span>
                )}
              </td>
              <td
                className={`px-3 py-2 text-right tabular-nums ${
                  p.errors > 0 ? "text-destructive" : "text-muted-foreground"
                }`}
              >
                {p.errors}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">
                ${Number(p.totalCostUsd).toFixed(4)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TopUsers({
  summary,
  usersById,
  onSelect,
  selected,
}: {
  readonly summary: ApiUsageSummary | undefined;
  readonly usersById: Map<string, { email: string | null; name: string | null }>;
  readonly onSelect: (id: string) => void;
  readonly selected: string | null;
}) {
  return (
    <div className="rounded-lg border border-border bg-card/40">
      <h3 className="border-b border-border px-3 py-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Топ-10 юзеров по вызовам
      </h3>
      <ul className="divide-y divide-border">
        {summary?.topUsers.length === 0 && (
          <li className="px-3 py-4 text-center text-muted-foreground">
            Никто не вызывал.
          </li>
        )}
        {summary?.topUsers.map((u) => {
          const meta = usersById.get(u.userId);
          return (
            <li key={u.userId}>
              <button
                type="button"
                onClick={() => onSelect(u.userId)}
                className={cn(
                  "flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-accent",
                  selected === u.userId && "bg-accent"
                )}
              >
                <span>
                  <span className="font-medium text-foreground">
                    {meta?.name ?? "?"}
                  </span>
                  <span className="ml-2 text-xs text-muted-foreground">
                    {meta?.email ?? u.userId.slice(0, 8) + "…"}
                  </span>
                </span>
                <span className="tabular-nums text-muted-foreground">
                  {u.calls}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function QuotaPanel({
  userId,
  userLabel,
  data,
  loading,
  onClear,
}: {
  readonly userId: string | null;
  readonly userLabel: string;
  readonly data: import("@/features/admin/api-usage/api").ApiUsageQuotas | undefined;
  readonly loading: boolean;
  readonly onClear: () => void;
}) {
  if (!userId) {
    return (
      <div className="flex items-center justify-center rounded-lg border border-dashed border-border bg-card/30 px-3 py-6 text-sm text-muted-foreground">
        Выберите юзера слева, чтобы увидеть квоты.
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-border bg-card/40">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Квоты · <span className="font-normal text-foreground">{userLabel}</span>
        </h3>
        <Button variant="ghost" size="sm" onClick={onClear}>
          Очистить
        </Button>
      </div>
      <ul className="divide-y divide-border">
        {loading && (
          <li className="px-3 py-4 text-center text-muted-foreground">
            Загрузка…
          </li>
        )}
        {data?.perProvider.map((p) => {
          const pct = p.limit > 0 ? Math.min(100, (p.used / p.limit) * 100) : 0;
          const tone =
            pct >= 90
              ? "bg-destructive"
              : pct >= 60
                ? "bg-warning"
                : "bg-brand-cyan";
          return (
            <li key={p.provider} className="px-3 py-2">
              <div className="flex items-center justify-between text-sm">
                <span className="font-medium">{p.provider}</span>
                <span className="tabular-nums text-muted-foreground">
                  {p.used} / {p.limit}
                </span>
              </div>
              <div className="mt-1 h-1 overflow-hidden rounded-full bg-card">
                <div
                  className={`h-full ${tone}`}
                  style={{ width: `${pct}%` }}
                />
              </div>
              <div className="mt-1 text-[10px] text-muted-foreground">
                reset {new Date(p.resetAt).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function RecentTable({
  rows,
  loading,
  usersById,
}: {
  readonly rows: ApiUsageRecent | undefined;
  readonly loading: boolean;
  readonly usersById: Map<string, { email: string | null; name: string | null }>;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card/40">
      <table className="w-full text-sm">
        <thead className="bg-card/80 text-left text-xs uppercase tracking-wider text-muted-foreground">
          <tr>
            <th className="px-3 py-2 font-medium">Время</th>
            <th className="px-3 py-2 font-medium">Provider</th>
            <th className="px-3 py-2 font-medium">Endpoint</th>
            <th className="px-3 py-2 font-medium">User</th>
            <th className="px-3 py-2 text-right font-medium">Статус</th>
            <th className="px-3 py-2 text-right font-medium">Cache</th>
            <th className="px-3 py-2 text-right font-medium">ms</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {loading && (
            <tr>
              <td colSpan={7} className="px-3 py-6 text-center text-muted-foreground">
                Загрузка…
              </td>
            </tr>
          )}
          {!loading && rows?.length === 0 && (
            <tr>
              <td colSpan={7} className="px-3 py-6 text-center text-muted-foreground">
                Нет вызовов.
              </td>
            </tr>
          )}
          {rows?.map((r) => (
            <tr key={r.id} className="hover:bg-card/60">
              <td className="px-3 py-2 whitespace-nowrap text-xs text-muted-foreground">
                {new Date(r.createdAt).toLocaleString("ru-RU", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
              </td>
              <td className="px-3 py-2">{r.provider}</td>
              <td className="px-3 py-2 font-mono text-xs text-muted-foreground max-w-xs truncate">
                {r.endpoint}
              </td>
              <td className="px-3 py-2 text-xs text-muted-foreground">
                {r.userId ? usersById.get(r.userId)?.email ?? r.userId.slice(0, 8) + "…" : "—"}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">
                {r.error ? (
                  <Badge variant="destructive">{r.httpStatus ?? "err"}</Badge>
                ) : (
                  <span
                    className={cn(
                      r.httpStatus && r.httpStatus >= 400
                        ? "text-destructive"
                        : "text-muted-foreground"
                    )}
                  >
                    {r.httpStatus ?? "—"}
                  </span>
                )}
              </td>
              <td className="px-3 py-2 text-right text-xs">
                {r.cacheHit === 1 ? (
                  <Badge variant="muted">cache</Badge>
                ) : (
                  <span className="text-muted-foreground">live</span>
                )}
              </td>
              <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                {r.durationMs ?? "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
