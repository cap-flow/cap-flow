import { ExternalLink } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useQueueStatus } from "@/features/admin/queue/hooks";

import { PageHeader } from "./_PageHeader";

const COUNT_TILES: Array<{
  key: keyof import("@/features/admin/queue/api").QueueStatus["counts"];
  label: string;
  tone: "default" | "alert" | "warn" | "muted";
}> = [
  { key: "active", label: "Active", tone: "default" },
  { key: "waiting", label: "Waiting", tone: "default" },
  { key: "delayed", label: "Delayed", tone: "muted" },
  { key: "completed", label: "Completed", tone: "muted" },
  { key: "failed", label: "Failed", tone: "alert" },
];

export function AdminQueuePage(): JSX.Element {
  const { data, isLoading, error, refetch, dataUpdatedAt } = useQueueStatus();

  return (
    <div>
      <PageHeader
        title="Очередь refresh"
        description="BullMQ queue portfolio-refresh — counts + recurring schedulers."
        actions={
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => refetch()}>
              Обновить
            </Button>
            <a
              href="/api/v1/admin/queue/ui/"
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-9 items-center gap-2 rounded-md border border-border bg-secondary px-3 text-sm font-medium hover:bg-accent"
            >
              bull-board
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          </div>
        }
      />

      {error && (
        <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {(error as Error).message}
        </p>
      )}

      <p className="mb-3 text-xs text-muted-foreground">
        Queue: <span className="font-mono text-foreground">{data?.name ?? "…"}</span>
        {dataUpdatedAt && (
          <span className="ml-3">
            обновлено {new Date(dataUpdatedAt).toLocaleTimeString("ru-RU")}
            ; авто-refresh 5с
          </span>
        )}
      </p>

      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-5">
        {COUNT_TILES.map((t) => (
          <CountTile
            key={t.key}
            label={t.label}
            value={data?.counts[t.key]}
            tone={t.tone}
            loading={isLoading}
          />
        ))}
      </div>

      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Recurring schedulers ({data?.recurringSchedules.length ?? 0})
        </h2>
        <div className="overflow-x-auto rounded-lg border border-border bg-card/40">
          <table className="w-full min-w-[900px] text-sm">
            <thead className="bg-card/80 text-left text-xs uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Scheduler key</th>
                <th className="px-3 py-2 font-medium">Every</th>
                <th className="px-3 py-2 font-medium">Next fire</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {isLoading && (
                <tr>
                  <td colSpan={3} className="px-3 py-6 text-center text-muted-foreground">
                    Загрузка…
                  </td>
                </tr>
              )}
              {!isLoading && data?.recurringSchedules.length === 0 && (
                <tr>
                  <td colSpan={3} className="px-3 py-6 text-center text-muted-foreground">
                    Нет recurring schedulers.
                  </td>
                </tr>
              )}
              {data?.recurringSchedules.map((s) => (
                <tr key={s.key} className="hover:bg-card/60">
                  <td className="px-3 py-2 font-mono text-xs">{s.key}</td>
                  <td className="px-3 py-2 text-muted-foreground tabular-nums">
                    {s.every !== null ? formatEvery(s.every) : "—"}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground tabular-nums">
                    {s.next !== null ? formatNext(s.next) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function CountTile({
  label,
  value,
  tone,
  loading,
}: {
  readonly label: string;
  readonly value: number | undefined;
  readonly tone: "default" | "alert" | "warn" | "muted";
  readonly loading: boolean;
}) {
  const valueColor =
    tone === "alert" && value && value > 0
      ? "text-destructive"
      : tone === "warn"
        ? "text-warning"
        : "text-foreground";
  const borderColor =
    tone === "alert" && value && value > 0
      ? "border-destructive/40"
      : "border-border";

  return (
    <div className={`rounded-lg border ${borderColor} bg-card/40 p-4`}>
      <div className="text-xs uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div
        className={`mt-2 text-2xl font-semibold tracking-tight tabular-nums ${valueColor}`}
      >
        {loading ? "…" : (value ?? "—")}
      </div>
    </div>
  );
}

function formatEvery(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}с`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}мин`;
  return `${Math.round(ms / 3_600_000)}ч`;
}

function formatNext(unixMs: number): string {
  const d = new Date(unixMs);
  return d.toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}
