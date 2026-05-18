import { useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Eye,
  EyeOff,
  Pencil,
  RefreshCw,
  RotateCcw,
  XCircle,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  useAdminIntegrations,
  useClearIntegration,
  useTestCexProxy,
  useUpdateIntegration,
} from "@/features/admin/integrations/hooks";
import type {
  IntegrationStatus,
  ProxyTestReport,
  ProxyTestStatus,
} from "@/features/admin/integrations/api";

import { PageHeader } from "./_PageHeader";

export function AdminIntegrationsPage(): JSX.Element {
  const q = useAdminIntegrations();
  const [editing, setEditing] = useState<IntegrationStatus | null>(null);

  const configured = q.data?.filter((i) => i.configured).length ?? 0;
  const total = q.data?.length ?? 0;
  const totalCost24h =
    q.data?.reduce((s, i) => s + i.totalCostUsd24h, 0) ?? 0;
  const totalErrors24h = q.data?.reduce((s, i) => s + i.errors24h, 0) ?? 0;

  return (
    <div>
      <PageHeader
        title="Интеграции"
        description="Все upstream API. Каждую можно редактировать прямо здесь — DB-override перекрывает env-переменную; кэш в process.env обновляется на лету, но долгоживущие клиенты подхватят новый ключ после рестарта API."
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => q.refetch()}
            disabled={q.isFetching}
          >
            <RefreshCw
              className={`mr-1.5 h-3.5 w-3.5 ${q.isFetching ? "animate-spin" : ""}`}
            />
            Обновить
          </Button>
        }
      />

      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiCard
          label="Подключено"
          value={`${configured} / ${total}`}
          tone={configured === total ? "ok" : "warn"}
        />
        <KpiCard
          label="Вызовы 24ч"
          value={(
            q.data?.reduce((s, i) => s + i.calls24h, 0) ?? 0
          ).toLocaleString("ru-RU")}
        />
        <KpiCard
          label="Ошибок 24ч"
          value={totalErrors24h.toLocaleString("ru-RU")}
          tone={totalErrors24h > 0 ? "alert" : "ok"}
        />
        <KpiCard
          label="Расход 24ч"
          value={`$${totalCost24h.toFixed(2)}`}
        />
      </div>

      {q.error && (
        <p className="mb-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          Ошибка загрузки: {(q.error as Error).message}
        </p>
      )}

      <div className="overflow-x-auto rounded-lg border border-border bg-card/40">
        <table className="w-full min-w-[1200px] text-sm">
          <thead className="bg-card/80 text-left text-xs uppercase tracking-wider text-muted-foreground">
            <tr>
              <th className="px-4 py-3 font-medium">Интеграция</th>
              <th className="px-4 py-3 font-medium">Назначение</th>
              <th className="px-4 py-3 font-medium">Статус</th>
              <th className="px-4 py-3 font-medium">Текущий ключ</th>
              <th className="px-4 py-3 font-medium text-right">Вызовы 24ч</th>
              <th className="px-4 py-3 font-medium text-right">Ошибки 24ч</th>
              <th className="px-4 py-3 font-medium">Действия</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {q.isLoading && (
              <tr>
                <td
                  colSpan={7}
                  className="px-4 py-8 text-center text-muted-foreground"
                >
                  Загрузка…
                </td>
              </tr>
            )}
            {q.data?.map((row) => (
              <Row key={row.key} row={row} onEdit={() => setEditing(row)} />
            ))}
          </tbody>
        </table>
      </div>

      {editing && (
        <EditIntegrationDialog
          row={editing}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function Row({
  row,
  onEdit,
}: {
  readonly row: IntegrationStatus;
  readonly onEdit: () => void;
}) {
  const isPublic = row.envVar.startsWith("(");
  return (
    <tr className="hover:bg-card/60">
      <td className="px-4 py-3">
        <div className="font-medium text-foreground">{row.name}</div>
        <code className="font-mono text-[10px] text-muted-foreground">
          {row.envVar}
        </code>
      </td>
      <td className="px-4 py-3 text-muted-foreground">{row.purpose}</td>
      <td className="px-4 py-3">
        {row.configured ? (
          <Badge variant="default" className="gap-1">
            <CheckCircle2 className="h-3 w-3" />
            подключено
          </Badge>
        ) : (
          <Badge variant="warning" className="gap-1">
            <XCircle className="h-3 w-3" />
            не задан
          </Badge>
        )}
        {row.hasDbOverride && (
          <Badge variant="outline" className="ml-1 text-[10px]">
            DB override
          </Badge>
        )}
      </td>
      <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
        {row.valuePreview ?? (isPublic ? "—" : <span className="italic">не задан</span>)}
        {row.editedAt && (
          <div className="text-[10px]">
            ред. {new Date(row.editedAt).toLocaleString("ru-RU")}
          </div>
        )}
      </td>
      <td className="px-4 py-3 text-right tabular-nums">
        {row.calls24h.toLocaleString("ru-RU")}
      </td>
      <td
        className={`px-4 py-3 text-right tabular-nums ${
          row.errors24h > 0 ? "text-destructive" : "text-muted-foreground"
        }`}
      >
        {row.errors24h}
      </td>
      <td className="px-4 py-3">
        <Button
          variant="ghost"
          size="sm"
          onClick={onEdit}
          disabled={isPublic}
          title={isPublic ? "Публичный endpoint — ключ не требуется" : "Редактировать ключ"}
        >
          <Pencil className="h-3.5 w-3.5" />
          <span className="ml-1">Изменить</span>
        </Button>
      </td>
    </tr>
  );
}

function EditIntegrationDialog({
  row,
  onClose,
}: {
  readonly row: IntegrationStatus;
  readonly onClose: () => void;
}) {
  const [value, setValue] = useState("");
  const [revealed, setRevealed] = useState(false);
  const update = useUpdateIntegration();
  const clear = useClearIntegration();
  const testProxy = useTestCexProxy();
  const [error, setError] = useState<string | null>(null);
  const [testReport, setTestReport] = useState<ProxyTestReport | null>(null);

  async function handleTest() {
    setError(null);
    setTestReport(null);
    try {
      const report = await testProxy.mutateAsync(value);
      setTestReport(report);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function handleSave() {
    setError(null);
    try {
      await update.mutateAsync({ key: row.key, value });
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function handleClear() {
    if (
      !window.confirm(
        `Очистить DB-override для ${row.name}?\nПосле этого активным станет значение из .env (если задано).`,
      )
    )
      return;
    setError(null);
    try {
      await clear.mutateAsync(row.key);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const busy = update.isPending || clear.isPending || testProxy.isPending;

  return (
    <Dialog
      open
      onClose={onClose}
      size="md"
      title={`Редактировать: ${row.name}`}
    >
      <div className="flex flex-col gap-4 text-sm">
        <div className="rounded-md border border-border bg-secondary/30 px-3 py-2 text-xs">
          <div className="font-medium text-foreground">{row.purpose}</div>
          <div className="mt-1 text-muted-foreground">
            Env-переменная:{" "}
            <code className="font-mono text-foreground">{row.envVar}</code>
          </div>
          {row.configured && row.valuePreview && (
            <div className="mt-1 text-muted-foreground">
              Текущее значение:{" "}
              <code className="font-mono text-foreground">{row.valuePreview}</code>
              {row.hasDbOverride && (
                <Badge variant="outline" className="ml-2 text-[10px]">
                  из DB
                </Badge>
              )}
              {!row.hasDbOverride && row.configured && (
                <Badge variant="muted" className="ml-2 text-[10px]">
                  из .env
                </Badge>
              )}
            </div>
          )}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="new-secret">
            {row.key === "cex_proxy" ? "URL прокси" : "Новое значение"}
          </Label>
          <div className="relative">
            <Input
              id="new-secret"
              type={revealed ? "text" : "password"}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={
                row.key === "cex_proxy"
                  ? "http://user:pass@host:port  или  socks5://host:port"
                  : "Вставьте новый API-ключ"
              }
              autoFocus
              autoComplete="off"
              spellCheck={false}
              className="pr-9 font-mono"
            />
            <button
              type="button"
              onClick={() => setRevealed((v) => !v)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              aria-label={revealed ? "Скрыть" : "Показать"}
            >
              {revealed ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
          {row.key === "cex_proxy" ? (
            <div className="space-y-1 text-[11px] text-muted-foreground">
              <p>
                HTTP(S) / SOCKS5 прокси для всех исходящих CEX-запросов.
                Применяется немедленно — без рестарта API.
              </p>
              <ul className="ml-4 list-disc">
                <li>
                  <code className="font-mono">http://user:pass@host:port</code>{" "}
                  — HTTP с авторизацией
                </li>
                <li>
                  <code className="font-mono">http://host:port</code> — без
                  авторизации
                </li>
                <li>
                  <code className="font-mono">socks5://host:port</code> —
                  SOCKS5 (только для CCXT; native fetch без поддержки SOCKS)
                </li>
              </ul>
              <p>
                Bybit / OKX / BingX геоблокируют RU/CIS IPs через CloudFront —
                поставьте прокси в EU/SG/HK.
              </p>
            </div>
          ) : (
            <p className="text-[11px] text-muted-foreground">
              Запишется в БД (`integration_secrets`), переопределит env-переменную.
              Сразу применится к `process.env`; для долгоживущих singleton-клиентов
              (DeBank/Alchemy) — рестарт API подхватит гарантированно.
            </p>
          )}
        </div>

        {error && (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
          </div>
        )}

        {/* UCB B1: результат «Тест прокси» — отдельная панель с per-биржа статусом. */}
        {row.key === "cex_proxy" && testReport && (
          <ProxyTestResultPanel report={testReport} />
        )}

        <div className="flex items-center justify-between gap-2 border-t border-border pt-3">
          {row.hasDbOverride ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={handleClear}
              disabled={busy}
              className="text-destructive"
            >
              <RotateCcw className="mr-1 h-3.5 w-3.5" />
              Сбросить DB-override
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={onClose} disabled={busy}>
              Отмена
            </Button>
            {/* UCB B1: для cex_proxy — кнопка «Тест» перед Save, чтобы юзер
                мог проверить URL без сохранения. */}
            {row.key === "cex_proxy" && (
              <Button
                variant="outline"
                size="sm"
                onClick={handleTest}
                disabled={busy || !value.trim()}
                title="Probe candidate proxy через api.bybit.com / bingx / bitget — без сохранения в БД"
              >
                {testProxy.isPending ? "Тестирую…" : "Тест"}
              </Button>
            )}
            <Button size="sm" onClick={handleSave} disabled={busy || !value.trim()}>
              Сохранить
            </Button>
          </div>
        </div>
      </div>
    </Dialog>
  );
}

/* ─── UCB B1: result panel ─── */

const STATUS_META: Record<
  ProxyTestStatus,
  { label: string; cls: string; icon: string }
> = {
  ok: { label: "Работает", cls: "text-success", icon: "✓" },
  geo_blocked: { label: "GEO-блок", cls: "text-destructive", icon: "🚫" },
  auth_failed: { label: "Auth fail", cls: "text-destructive", icon: "🔒" },
  timeout: { label: "Таймаут", cls: "text-warning", icon: "⏱" },
  network_error: { label: "Сеть", cls: "text-destructive", icon: "✗" },
  exchange_error: { label: "Биржа", cls: "text-warning", icon: "?" },
};

function ProxyTestResultPanel({ report }: { readonly report: ProxyTestReport }) {
  const summary = report.anyOk
    ? "✓ Прокси работает хотя бы для одной биржи — можно сохранять"
    : "✗ Прокси не работает ни для одной биржи — не годится";
  const summaryCls = report.anyOk
    ? "border-success/40 bg-success/10 text-success"
    : "border-destructive/40 bg-destructive/10 text-destructive";

  return (
    <div className={`rounded-md border px-3 py-2 ${summaryCls}`}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-xs font-semibold">{summary}</span>
        <code className="font-mono text-[10px] opacity-70">
          {report.proxyUrl}
        </code>
      </div>
      <table className="w-full text-xs">
        <thead className="text-[10px] uppercase tracking-wider opacity-70">
          <tr>
            <th className="py-1 text-left">Биржа</th>
            <th className="py-1 text-left">Статус</th>
            <th className="py-1 text-right">HTTP</th>
            <th className="py-1 text-right">Latency</th>
          </tr>
        </thead>
        <tbody>
          {report.results.map((r) => {
            const m = STATUS_META[r.status];
            return (
              <tr key={r.exchange} className="border-t border-border/30">
                <td className="py-1 font-medium uppercase">{r.exchange}</td>
                <td className={`py-1 ${m.cls}`} title={r.note ?? undefined}>
                  {m.icon} {m.label}
                </td>
                <td className="py-1 text-right tabular-nums">
                  {r.httpCode ?? "—"}
                </td>
                <td className="py-1 text-right tabular-nums">
                  {r.latencyMs} ms
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {/* Подсказки по типичным failure modes */}
      {!report.anyOk && (
        <ul className="mt-2 ml-4 list-disc text-[11px] leading-relaxed opacity-90">
          {report.results.some((r) => r.status === "timeout") && (
            <li>
              <strong>Timeout на всех биржах</strong> → прокси скорее всего
              мёртв или жёстко rate-лимитит. Запросите у провайдера другой IP.
            </li>
          )}
          {report.results.some((r) => r.status === "geo_blocked") && (
            <li>
              <strong>GEO-блок</strong> → exit-IP прокси в blocked-зоне.
              Нужен прокси в EU (DE/NL/FI) или SG/HK.
            </li>
          )}
          {report.results.some((r) => r.status === "auth_failed") && (
            <li>
              <strong>Auth fail</strong> → неверный user:pass в URL прокси.
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

function KpiCard({
  label,
  value,
  tone = "default",
}: {
  readonly label: string;
  readonly value: string;
  readonly tone?: "default" | "ok" | "warn" | "alert";
}) {
  const toneCls =
    tone === "alert"
      ? "border-destructive/40 text-destructive"
      : tone === "warn"
        ? "border-warning/40 text-warning"
        : tone === "ok"
          ? "border-success/40 text-success"
          : "border-border";
  return (
    <div className={`rounded-lg border bg-card/50 p-4 ${toneCls}`}>
      <div className="text-xs uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className="mt-2 text-2xl font-semibold tracking-tight tabular-nums">
        {value}
      </div>
    </div>
  );
}
