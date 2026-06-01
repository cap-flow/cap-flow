import { useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

import type { ResolvedSetting } from "./api";
import {
  useAdminAppSettings,
  useResetAppSetting,
  useUpdateAppSetting,
} from "./hooks";

/**
 * Admin-панель тюнинга API-кнобов (rate limits, квоты, cache TTL, DeBank
 * история, авто-рефреш). Группирует по `group`, поле на кноб с валидацией
 * min/max, Save/Reset, бейдж источника (db/default) и хинт «нужен рестарт».
 */
export function SettingsPanel(): JSX.Element {
  const q = useAdminAppSettings();

  const groups = useMemo(() => {
    const m = new Map<string, ResolvedSetting[]>();
    for (const s of q.data ?? []) {
      const arr = m.get(s.group) ?? [];
      arr.push(s);
      m.set(s.group, arr);
    }
    return Array.from(m.entries());
  }, [q.data]);

  if (q.isLoading) {
    return <p className="text-sm text-muted-foreground">Загрузка настроек…</p>;
  }
  if (groups.length === 0) {
    return <p className="text-sm text-muted-foreground">Нет настроек.</p>;
  }

  return (
    <div className="space-y-6">
      {groups.map(([group, items]) => (
        <section key={group}>
          <h3 className="mb-2 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            {group}
          </h3>
          <div className="divide-y divide-border rounded-md border border-border bg-card/40">
            {items.map((s) => (
              <SettingRow key={s.key} setting={s} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function SettingRow({ setting }: { setting: ResolvedSetting }): JSX.Element {
  const update = useUpdateAppSetting();
  const reset = useResetAppSetting();
  const [draft, setDraft] = useState<string>(String(setting.currentValue));
  const [err, setErr] = useState<string | null>(null);

  // Синхронизируем draft, если значение изменилось извне (refetch).
  const serverValue = String(setting.currentValue);
  const dirty = draft !== serverValue;

  const validate = (raw: string): string | null => {
    if (setting.valueType === "number") {
      const n = Number(raw);
      if (!Number.isFinite(n)) return "Не число";
      if (setting.min != null && n < setting.min) return `Минимум ${setting.min}`;
      if (setting.max != null && n > setting.max) return `Максимум ${setting.max}`;
    }
    return null;
  };

  const onSave = () => {
    const v = validate(draft);
    if (v) {
      setErr(v);
      return;
    }
    setErr(null);
    const value: number | boolean | string =
      setting.valueType === "number"
        ? Number(draft)
        : setting.valueType === "boolean"
          ? draft === "true"
          : draft;
    update.mutate({ key: setting.key, value });
  };

  const onReset = () => {
    setErr(null);
    reset.mutate(setting.key, {
      onSuccess: () => setDraft(String(setting.defaultValue)),
    });
  };

  return (
    <div className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-foreground">{setting.label}</span>
          {setting.source === "db" ? (
            <Badge variant="outline" className="text-amber-400 border-amber-500/30">
              изменено
            </Badge>
          ) : (
            <Badge variant="outline" className="text-muted-foreground">
              по умолчанию
            </Badge>
          )}
          {setting.hotReload === "restart" && (
            <Badge variant="outline" className="text-rose-400 border-rose-500/30">
              нужен рестарт
            </Badge>
          )}
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">{setting.description}</p>
        <p className="mt-0.5 font-mono text-[10px] text-muted-foreground/70">
          {setting.key}
          {setting.min != null || setting.max != null
            ? ` · [${setting.min ?? "−∞"}…${setting.max ?? "∞"}]`
            : ""}
          {` · default: ${String(setting.defaultValue)}`}
        </p>
        {err && <p className="mt-0.5 text-xs text-rose-400">{err}</p>}
      </div>
      <div className="flex items-center gap-2">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          inputMode={setting.valueType === "number" ? "numeric" : "text"}
          className={cn("w-40", dirty && "border-amber-500/50")}
        />
        <Button
          size="sm"
          onClick={onSave}
          disabled={!dirty || update.isPending}
        >
          Сохранить
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={onReset}
          disabled={setting.source === "default" || reset.isPending}
        >
          Сброс
        </Button>
      </div>
    </div>
  );
}
