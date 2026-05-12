import { Activity, MailCheck, Sparkles, UserCheck, UserPlus, Users } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useSaasMetrics } from "@/features/admin/metrics/hooks";
import type { SaasMetrics } from "@/features/admin/metrics/api";

import { PageHeader } from "./_PageHeader";

export function AdminMetricsPage(): JSX.Element {
  const { data, isLoading, error, refetch } = useSaasMetrics();

  return (
    <div>
      <PageHeader
        title="SaaS-метрики"
        description="Здоровье платформы: пользователи, активность, invite-воронка, активация."
        actions={
          <Button variant="outline" size="sm" onClick={() => refetch()}>
            Обновить
          </Button>
        }
      />

      {error && (
        <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          Не удалось загрузить метрики: {(error as Error).message}
        </p>
      )}

      <Section title="Пользователи" icon={<Users className="h-4 w-4" />}>
        <Stat label="Всего" value={fmt(data?.users.total)} loading={isLoading} />
        <Stat
          label="Active"
          value={fmt(data?.users.active)}
          loading={isLoading}
          tone="success"
        />
        <Stat
          label="Pending"
          value={fmt(data?.users.pending)}
          loading={isLoading}
          tone="warning"
        />
        <Stat
          label="Blocked"
          value={fmt(data?.users.blocked)}
          loading={isLoading}
          tone="destructive"
        />
      </Section>

      <Section title="Активность" icon={<Activity className="h-4 w-4" />}>
        <Stat
          label="DAU"
          hint="distinct сессий за 24ч"
          value={fmt(data?.dau)}
          loading={isLoading}
        />
        <Stat
          label="WAU"
          hint="за 7 дней"
          value={fmt(data?.wau)}
          loading={isLoading}
        />
        <Stat
          label="MAU"
          hint="за 30 дней"
          value={fmt(data?.mau)}
          loading={isLoading}
        />
      </Section>

      <Section title="Новые юзеры" icon={<UserPlus className="h-4 w-4" />}>
        <Stat
          label="За 24ч"
          value={fmt(data?.newUsers.last24h)}
          loading={isLoading}
        />
        <Stat
          label="За 7 дней"
          value={fmt(data?.newUsers.last7d)}
          loading={isLoading}
        />
        <Stat
          label="За 30 дней"
          value={fmt(data?.newUsers.last30d)}
          loading={isLoading}
        />
      </Section>

      <Section title="Invite-воронка" icon={<MailCheck className="h-4 w-4" />}>
        <Stat
          label="Pending"
          value={fmt(data?.invites.pending)}
          loading={isLoading}
        />
        <Stat
          label="Consumed"
          value={fmt(data?.invites.consumed)}
          loading={isLoading}
          tone="success"
        />
        <Stat
          label="Revoked"
          value={fmt(data?.invites.revoked)}
          loading={isLoading}
        />
        <Stat
          label="Expired"
          value={fmt(data?.invites.expired)}
          loading={isLoading}
          tone="warning"
        />
      </Section>

      <Section title="Активация" icon={<Sparkles className="h-4 w-4" />}>
        <Stat
          label="Invites <24ч"
          hint="% приглашений принято в первые сутки (30д окно)"
          value={pct(data?.activation.within24hPct)}
          loading={isLoading}
          tone={chooseActivationTone(data, "within24hPct")}
          big
        />
        <Stat
          label="Refresh <7д"
          hint="% юзеров с первым refresh в первые 7 дней (30д окно)"
          value={pct(data?.activation.firstRefreshWithin7dPct)}
          loading={isLoading}
          tone={chooseActivationTone(data, "firstRefreshWithin7dPct")}
          big
        />
        <ActivationHint metrics={data} />
      </Section>
    </div>
  );
}

function ActivationHint({
  metrics,
}: {
  readonly metrics: SaasMetrics | undefined;
}): JSX.Element {
  return (
    <div className="rounded-lg border border-border bg-card/40 p-4 text-xs text-muted-foreground sm:col-span-2">
      <div className="mb-1 flex items-center gap-2 text-foreground">
        <UserCheck className="h-3.5 w-3.5" />
        <span className="font-medium">Как читать</span>
      </div>
      Оба процента берутся за окно последних 30 дней. «Invites&nbsp;&lt;24ч»
      — доля приглашений, которыми воспользовались в первые сутки после
      выдачи. «Refresh&nbsp;&lt;7д» — доля новых юзеров, у которых хоть
      один portfolio_snapshot записан в первые 7 дней после регистрации.
      {metrics?.activation.firstRefreshWithin7dPct === 0 && (
        <div className="mt-2 text-warning">
          Пока на 0% — pipeline refresh ещё на stub (Phase 6 включит real
          balances).
        </div>
      )}
    </div>
  );
}

function chooseActivationTone(
  m: SaasMetrics | undefined,
  field: "within24hPct" | "firstRefreshWithin7dPct"
): "default" | "success" | "warning" | "destructive" {
  if (!m) return "default";
  const v = m.activation[field];
  if (v >= 80) return "success";
  if (v >= 40) return "default";
  if (v >= 10) return "warning";
  return "destructive";
}

// ─── Layout primitives ──────────────────────────────────────────────

function Section({
  title,
  icon,
  children,
}: {
  readonly title: string;
  readonly icon: React.ReactNode;
  readonly children: React.ReactNode;
}): JSX.Element {
  return (
    <section className="mb-6">
      <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
        <span className="text-brand-cyan">{icon}</span>
        {title}
      </h2>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
        {children}
      </div>
    </section>
  );
}

function Stat({
  label,
  hint,
  value,
  loading,
  tone = "default",
  big = false,
}: {
  readonly label: string;
  readonly hint?: string;
  readonly value: string;
  readonly loading: boolean;
  readonly tone?: "default" | "success" | "warning" | "destructive";
  readonly big?: boolean;
}): JSX.Element {
  const toneClass =
    tone === "success"
      ? "text-success"
      : tone === "warning"
        ? "text-warning"
        : tone === "destructive"
          ? "text-destructive"
          : "text-foreground";
  return (
    <div className="rounded-lg border border-border bg-card/40 p-4">
      <div className="text-xs uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div
        className={`mt-2 font-semibold tracking-tight tabular-nums ${
          big ? "text-3xl" : "text-2xl"
        } ${toneClass}`}
      >
        {loading ? "…" : value}
      </div>
      {hint && <div className="mt-1 text-[11px] text-muted-foreground">{hint}</div>}
    </div>
  );
}

// ─── helpers ─────────────────────────────────────────────────────────

function fmt(n: number | undefined | null): string {
  if (n === undefined || n === null) return "—";
  return n.toLocaleString("ru-RU");
}

function pct(n: number | undefined | null): string {
  if (n === undefined || n === null) return "—";
  return `${n}%`;
}
