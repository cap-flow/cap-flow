import { AlertCircle, AlertTriangle, CheckCircle2, Info } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useTechAuditReport } from "@/features/admin/tech-audit/hooks";
import type { Finding } from "@/features/admin/tech-audit/api";

import { PageHeader } from "./_PageHeader";

export function AdminTechAuditPage(): JSX.Element {
  const { data, isLoading, error, refetch } = useTechAuditReport();

  const findingsByCategory = data
    ? groupBy(data.findings, (f) => f.category)
    : new Map<string, Finding[]>();

  return (
    <div>
      <PageHeader
        title="Технический аудит"
        description="Аномалии: stale-snapshots, upstream-errors, юзеры без аккаунтов, invite expiry."
        actions={
          <Button variant="outline" size="sm" onClick={() => refetch()}>
            Перезапустить
          </Button>
        }
      />

      {error && (
        <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {(error as Error).message}
        </p>
      )}

      {data && Object.keys(data.summary).length === 0 && (
        <div className="flex items-center gap-3 rounded-lg border border-success/30 bg-success/10 px-4 py-6 text-success">
          <CheckCircle2 className="h-5 w-5" />
          <span className="font-medium">Аномалий не найдено.</span>
        </div>
      )}

      {!isLoading && Object.keys(data?.summary ?? {}).length > 0 && (
        <div className="mb-4 flex flex-wrap gap-2">
          {Object.entries(data?.summary ?? {}).map(([cat, n]) => (
            <Badge key={cat} variant="muted">
              {cat}: <span className="ml-1 font-semibold text-foreground">{n}</span>
            </Badge>
          ))}
        </div>
      )}

      <div className="space-y-3">
        {Array.from(findingsByCategory.entries()).map(([category, findings]) => (
          <CategorySection
            key={category}
            category={category}
            findings={findings}
          />
        ))}
      </div>
    </div>
  );
}

function CategorySection({
  category,
  findings,
}: {
  readonly category: string;
  readonly findings: Finding[];
}) {
  const worstSev = findings.some((f) => f.severity === "error")
    ? "error"
    : findings.some((f) => f.severity === "warning")
      ? "warning"
      : "info";

  return (
    <section
      className={`rounded-lg border bg-card/40 ${
        worstSev === "error"
          ? "border-destructive/40"
          : worstSev === "warning"
            ? "border-warning/40"
            : "border-border"
      }`}
    >
      <header className="flex items-center justify-between border-b border-border px-4 py-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <SeverityIcon severity={worstSev} />
          {category}
        </h2>
        <span className="text-xs text-muted-foreground">
          {findings.length} {findings.length === 1 ? "запись" : "записей"}
        </span>
      </header>
      <ul className="divide-y divide-border">
        {findings.map((f) => (
          <li key={f.id} className="px-4 py-2.5">
            <div className="flex items-start gap-3">
              <SeverityIcon severity={f.severity} />
              <div className="min-w-0 flex-1">
                <p className="text-sm text-foreground">{f.message}</p>
                {(f.accountId || f.userId) && (
                  <p className="mt-1 font-mono text-[10px] text-muted-foreground">
                    {f.accountId && <span>account: {f.accountId.slice(0, 8)}… </span>}
                    {f.userId && <span>user: {f.userId.slice(0, 8)}…</span>}
                  </p>
                )}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function SeverityIcon({
  severity,
}: {
  readonly severity: "info" | "warning" | "error";
}): JSX.Element {
  if (severity === "error")
    return <AlertCircle className="h-4 w-4 shrink-0 text-destructive" />;
  if (severity === "warning")
    return <AlertTriangle className="h-4 w-4 shrink-0 text-warning" />;
  return <Info className="h-4 w-4 shrink-0 text-muted-foreground" />;
}

function groupBy<T, K>(arr: T[], getKey: (x: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>();
  for (const x of arr) {
    const k = getKey(x);
    const bucket = out.get(k);
    if (bucket) bucket.push(x);
    else out.set(k, [x]);
  }
  return out;
}
