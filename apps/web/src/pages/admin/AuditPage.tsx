import { useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  useAuditActionCounts,
  useAuditEntries,
} from "@/features/admin/audit/hooks";
import type { AuditEntry } from "@/features/admin/audit/api";
import { cn } from "@/lib/utils";

import { PageHeader } from "./_PageHeader";

const WINDOW_OPTIONS = [
  { hours: 1, label: "1ч" },
  { hours: 24, label: "24ч" },
  { hours: 24 * 7, label: "7д" },
  { hours: 24 * 30, label: "30д" },
];

const AS_ADMIN_OPTIONS = [
  { value: "", label: "Все события" },
  { value: "true", label: "Только admin" },
  { value: "false", label: "Только user" },
];

export function AdminAuditPage(): JSX.Element {
  const [sinceHours, setSinceHours] = useState(24);
  const [actionPrefix, setActionPrefix] = useState("");
  const [asAdminFilter, setAsAdminFilter] = useState<"" | "true" | "false">("");
  const [limit, setLimit] = useState(100);

  const filter = useMemo(
    () => ({
      sinceHours,
      limit,
      ...(actionPrefix.trim() ? { action: actionPrefix.trim() } : {}),
      ...(asAdminFilter
        ? { asAdmin: asAdminFilter === "true" }
        : {}),
    }),
    [sinceHours, limit, actionPrefix, asAdminFilter]
  );

  const list = useAuditEntries(filter);
  const counts = useAuditActionCounts(sinceHours);

  return (
    <div>
      <PageHeader
        title="Аудит-лог"
        description="Все действия в системе — actor / target / action / ip."
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              list.refetch();
              counts.refetch();
            }}
          >
            Обновить
          </Button>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="inline-flex rounded-md border border-border bg-card/40 p-1">
          {WINDOW_OPTIONS.map((opt) => (
            <button
              key={opt.hours}
              type="button"
              onClick={() => setSinceHours(opt.hours)}
              className={cn(
                "rounded px-3 py-1 text-xs font-medium transition-colors",
                sinceHours === opt.hours
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <select
          value={asAdminFilter}
          onChange={(e) =>
            setAsAdminFilter(e.target.value as "" | "true" | "false")
          }
          className="h-9 rounded-md border border-border bg-background px-3 text-sm"
        >
          {AS_ADMIN_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <Input
          placeholder="Action prefix (например auth. или admin.)"
          value={actionPrefix}
          onChange={(e) => setActionPrefix(e.target.value)}
          className="max-w-xs"
        />
        <select
          value={limit}
          onChange={(e) => setLimit(Number(e.target.value))}
          className="h-9 rounded-md border border-border bg-background px-3 text-sm"
        >
          <option value={50}>50 строк</option>
          <option value={100}>100 строк</option>
          <option value={250}>250 строк</option>
          <option value={500}>500 строк</option>
        </select>
      </div>

      <div className="mb-6 grid grid-cols-1 gap-4 lg:grid-cols-[1fr_280px]">
        <div className="overflow-x-auto rounded-lg border border-border bg-card/40">
          <table className="w-full min-w-[900px] text-sm">
            <thead className="bg-card/80 text-left text-xs uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Время</th>
                <th className="px-3 py-2 font-medium">Action</th>
                <th className="px-3 py-2 font-medium">Actor</th>
                <th className="px-3 py-2 font-medium">Target</th>
                <th className="px-3 py-2 font-medium">IP</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {list.isLoading && (
                <tr>
                  <td colSpan={5} className="px-3 py-6 text-center text-muted-foreground">
                    Загрузка…
                  </td>
                </tr>
              )}
              {!list.isLoading && list.data?.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-3 py-6 text-center text-muted-foreground">
                    Событий не найдено.
                  </td>
                </tr>
              )}
              {list.data?.map((e) => <EntryRow key={e.id} entry={e} />)}
            </tbody>
          </table>
        </div>

        <aside className="rounded-lg border border-border bg-card/40 p-3">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Action counts ({WINDOW_OPTIONS.find((o) => o.hours === sinceHours)?.label})
          </h3>
          <div className="space-y-1">
            {counts.isLoading && (
              <p className="text-xs text-muted-foreground">Загрузка…</p>
            )}
            {counts.data && counts.data.length === 0 && (
              <p className="text-xs text-muted-foreground">Пусто.</p>
            )}
            {counts.data?.map((c) => (
              <button
                key={c.action}
                type="button"
                onClick={() => setActionPrefix(c.action)}
                className="flex w-full items-center justify-between rounded px-2 py-1 text-xs hover:bg-accent"
              >
                <span className="font-mono text-foreground">{c.action}</span>
                <span className="text-muted-foreground tabular-nums">{c.n}</span>
              </button>
            ))}
          </div>
        </aside>
      </div>
    </div>
  );
}

function EntryRow({ entry }: { readonly entry: AuditEntry }) {
  return (
    <tr className="hover:bg-card/60">
      <td className="px-3 py-2 text-xs text-muted-foreground whitespace-nowrap">
        {formatTime(entry.occurredAt)}
      </td>
      <td className="px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs text-foreground">
            {entry.action}
          </span>
          {entry.asAdmin && <Badge variant="warning">as_admin</Badge>}
        </div>
      </td>
      <td className="px-3 py-2 text-xs font-mono text-muted-foreground">
        {entry.actorId ? entry.actorId.slice(0, 8) + "…" : "system"}
      </td>
      <td className="px-3 py-2 text-xs font-mono text-muted-foreground">
        {entry.targetUserId
          ? entry.targetUserId.slice(0, 8) + "…"
          : entry.accountId
            ? entry.accountId.slice(0, 8) + "…"
            : entry.target ?? "—"}
      </td>
      <td className="px-3 py-2 text-xs text-muted-foreground tabular-nums">
        {entry.ip ?? "—"}
      </td>
    </tr>
  );
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}
