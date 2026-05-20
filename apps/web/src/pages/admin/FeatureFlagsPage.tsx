/**
 * Feature flags admin — feature-centric UX.
 *
 * Каждая известная фича (registry в `CLIENT_FEATURE_FLAGS`) показывается
 * как карточка с прямым управлением раскаткой:
 *  - Off — флаг не активен ни у кого (default)
 *  - Per-user — выбрать конкретных пользователей через checkbox grid
 *  - Global — включить для всех юзеров сервиса
 *
 * Под капотом каждое действие создаёт/обновляет server-side row в
 * `feature_flags` table через `useUpsertFeatureFlag` / `useDeleteFeatureFlag`.
 * Resolve приоритет (для конкретного юзера): user > account > global > default.
 *
 * Также — секция «Клиентские флаги (этот браузер)» для dev-only experiments
 * через localStorage (применяется только в этом браузере, поверх server-flag).
 */

import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  useDeleteFeatureFlag,
  useFeatureFlags,
  useUpsertFeatureFlag,
} from "@/features/admin/feature-flags/hooks";
import type { FlagRow } from "@/features/admin/feature-flags/api";
import { useAdminUsers } from "@/features/admin/users/hooks";
import type { AdminUserRow } from "@/features/admin/users/api";
import {
  CLIENT_FEATURE_FLAGS,
  getClientFlag,
  resetClientFlag,
  setClientFlag,
  type ClientFeatureFlag,
} from "@/lib/portfolio/feature_flags";

import { PageHeader } from "./_PageHeader";

export function AdminFeatureFlagsPage(): JSX.Element {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Feature flags"
        description="Канареечная выкатка фич: раскатка → конкретные юзеры → все. Приоритет: user → account → global → default(false)."
      />

      <KnownFeaturesSection />
      <ClientFlagsSection />
      <OtherServerFlagsSection />
    </div>
  );
}

// ─────────────────── Known features ───────────────────

/**
 * Карточки для каждой фичи из `CLIENT_FEATURE_FLAGS` registry.
 * Каждая карточка содержит inline-управление раскаткой (Off/Users/Global).
 */
function KnownFeaturesSection(): JSX.Element {
  const flags = useFeatureFlags();
  const users = useAdminUsers({ limit: 100 });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Известные фичи</CardTitle>
        <CardDescription>
          Кликни на фичу чтобы раскатить её на одного / нескольких / всех
          пользователей. Изменения вступают в силу сразу (нужно перезагрузить
          страницу пользователю чтобы он увидел эффект).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {CLIENT_FEATURE_FLAGS.map((f) => (
          <FeatureCard
            key={f.key}
            feature={f}
            flagRows={(flags.data ?? []).filter((r) => r.key === f.key)}
            users={users.data?.items ?? []}
            isUsersLoading={users.isLoading}
          />
        ))}
      </CardContent>
    </Card>
  );
}

interface FeatureCardProps {
  feature: ClientFeatureFlag;
  flagRows: FlagRow[];
  users: readonly AdminUserRow[];
  isUsersLoading: boolean;
}

function FeatureCard({
  feature,
  flagRows,
  users,
  isUsersLoading,
}: FeatureCardProps): JSX.Element {
  const upsert = useUpsertFeatureFlag();
  const del = useDeleteFeatureFlag();

  // Текущее состояние раскатки.
  const globalRow = flagRows.find((r) => r.scope === "global");
  const userRows = flagRows.filter(
    (r) => r.scope === "user" && r.scopeRefId && r.enabled,
  );
  const enabledUserIds = new Set(
    userRows.map((r) => r.scopeRefId).filter((x): x is string => !!x),
  );

  // Определяем текущий режим: Off / Per-user / Global
  type Mode = "off" | "per-user" | "global";
  const currentMode: Mode = globalRow?.enabled
    ? "global"
    : userRows.length > 0
      ? "per-user"
      : "off";

  const [expanded, setExpanded] = useState(false);
  const [search, setSearch] = useState("");

  const filteredUsers = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return users;
    return users.filter((u) => {
      const email = (u.email ?? "").toLowerCase();
      const name = (u.name ?? "").toLowerCase();
      return email.includes(q) || name.includes(q);
    });
  }, [users, search]);

  // Действия (создание/обновление server flag'ов)
  async function setMode(mode: Mode): Promise<void> {
    if (mode === "off") {
      // Delete global row, delete все user rows.
      const toDelete = flagRows.filter((r) => r.enabled);
      for (const r of toDelete) {
        await del.mutateAsync(r.id);
      }
    } else if (mode === "global") {
      // Удаляем user-scope (они станут redundant)
      for (const r of flagRows.filter((r) => r.scope === "user")) {
        await del.mutateAsync(r.id);
      }
      await upsert.mutateAsync({
        key: feature.key,
        body: { scope: "global", scopeRefId: null, enabled: true },
      });
    } else {
      // per-user: убираем global, оставляем user rows как есть
      if (globalRow) {
        // Disable global вместо удаления — чтобы preserve history
        await upsert.mutateAsync({
          key: feature.key,
          body: { scope: "global", scopeRefId: null, enabled: false },
        });
      }
      setExpanded(true);
    }
  }

  async function toggleUser(userId: string, on: boolean): Promise<void> {
    const existing = flagRows.find(
      (r) => r.scope === "user" && r.scopeRefId === userId,
    );
    if (existing) {
      if (existing.enabled === on) return;
      await upsert.mutateAsync({
        key: feature.key,
        body: {
          scope: "user",
          scopeRefId: userId,
          enabled: on,
        },
      });
    } else if (on) {
      await upsert.mutateAsync({
        key: feature.key,
        body: { scope: "user", scopeRefId: userId, enabled: true },
      });
    }
  }

  const busy = upsert.isPending || del.isPending;

  return (
    <div className="rounded-lg border border-border bg-secondary/30">
      <div className="flex items-start gap-3 p-4">
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <h3 className="text-base font-semibold">{feature.label}</h3>
            <ModeBadge mode={currentMode} userCount={userRows.length} />
          </div>
          <code className="text-[10px] text-muted-foreground">
            {feature.key}
          </code>
          <p className="mt-2 text-xs text-muted-foreground">
            {feature.description}
          </p>
        </div>
      </div>

      <div className="border-t border-border bg-background/40 p-4">
        <Label className="mb-2 block text-xs uppercase tracking-wider text-muted-foreground">
          Раскатка
        </Label>
        <div className="flex flex-wrap gap-2">
          <ModeButton
            label="Off (все)"
            description="Никто не видит фичу"
            active={currentMode === "off"}
            disabled={busy}
            onClick={() => void setMode("off")}
          />
          <ModeButton
            label="Конкретным пользователям"
            description="Выбрать через checkbox-список ниже"
            active={currentMode === "per-user"}
            disabled={busy}
            onClick={() => void setMode("per-user")}
          />
          <ModeButton
            label="Global (все)"
            description="Все юзеры сервиса видят фичу"
            active={currentMode === "global"}
            disabled={busy}
            onClick={() => void setMode("global")}
          />
        </div>

        {(currentMode === "per-user" || expanded) && (
          <div className="mt-4 space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-xs uppercase tracking-wider text-muted-foreground">
                Пользователи ({enabledUserIds.size} включено
                {users.length > 0 ? ` из ${users.length}` : ""})
              </Label>
              <Input
                placeholder="Поиск по email / имени…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-64"
              />
            </div>
            {isUsersLoading ? (
              <p className="text-xs text-muted-foreground">Загружаем юзеров…</p>
            ) : filteredUsers.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                Никто не найден.
              </p>
            ) : (
              <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                {filteredUsers.map((u) => (
                  <UserToggle
                    key={u.id}
                    user={u}
                    enabled={enabledUserIds.has(u.id)}
                    disabled={busy || currentMode === "global"}
                    onToggle={(on) => void toggleUser(u.id, on)}
                  />
                ))}
              </div>
            )}
          </div>
        )}

        {currentMode === "global" && (
          <div className="mt-3 rounded border border-emerald-500/30 bg-emerald-500/5 p-2 text-xs">
            ✓ Фича раскатана на <strong>всех пользователей</strong>. User-scope
            overrides отключены (global всё перекрывает).
          </div>
        )}
      </div>
    </div>
  );
}

function ModeBadge({
  mode,
  userCount,
}: {
  mode: "off" | "per-user" | "global";
  userCount: number;
}): JSX.Element {
  if (mode === "global") {
    return (
      <Badge className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-400">
        🌍 Global
      </Badge>
    );
  }
  if (mode === "per-user") {
    return (
      <Badge className="bg-brand-cyan/15 text-brand-cyan">
        👥 {userCount} user(s)
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="text-muted-foreground">
      ⚪ Off
    </Badge>
  );
}

function ModeButton({
  label,
  description,
  active,
  disabled,
  onClick,
}: {
  label: string;
  description: string;
  active: boolean;
  disabled: boolean;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={
        "rounded-md border px-3 py-2 text-left text-xs transition disabled:opacity-50 " +
        (active
          ? "border-brand-cyan bg-brand-cyan/10 text-brand-cyan font-medium"
          : "border-border bg-background hover:bg-accent/40")
      }
    >
      <div className="font-medium">{label}</div>
      <div className="text-[10px] text-muted-foreground">{description}</div>
    </button>
  );
}

function UserToggle({
  user,
  enabled,
  disabled,
  onToggle,
}: {
  user: AdminUserRow;
  enabled: boolean;
  disabled: boolean;
  onToggle: (on: boolean) => void;
}): JSX.Element {
  return (
    <label
      className={
        "flex cursor-pointer items-start gap-2 rounded border px-2 py-1.5 transition " +
        (enabled
          ? "border-brand-cyan/40 bg-brand-cyan/5"
          : "border-border bg-background hover:bg-accent/30") +
        (disabled ? " opacity-60" : "")
      }
    >
      <input
        type="checkbox"
        checked={enabled}
        onChange={(e) => onToggle(e.target.checked)}
        disabled={disabled}
        className="mt-0.5"
      />
      <div className="flex-1 text-xs">
        <div className="font-medium">{user.email ?? user.name ?? "—"}</div>
        <div className="text-[10px] text-muted-foreground">
          {user.name && user.email ? user.name : ""}
          {user.role !== "user" ? ` · ${user.role}` : ""}
          {user.status !== "active" ? ` · ${user.status}` : ""}
        </div>
      </div>
    </label>
  );
}

// ─────────────────── Client-side flags (this browser) ───────────────────

function ClientFlagsSection(): JSX.Element {
  if (CLIENT_FEATURE_FLAGS.length === 0) return <></>;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          Клиентские флаги (только этот браузер)
        </CardTitle>
        <CardDescription>
          Dev-override через localStorage. Поверх server-флага. Применяется
          только к твоему текущему браузеру; другие юзеры это не видят.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {CLIENT_FEATURE_FLAGS.map((f) => (
          <ClientFlagRow key={f.key} flag={f} />
        ))}
        <div className="flex justify-end pt-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => window.location.reload()}
          >
            🔄 Перезагрузить
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function ClientFlagRow({ flag }: { flag: ClientFeatureFlag }): JSX.Element {
  const [enabled, setEnabled] = useState(() =>
    getClientFlag(flag.key, flag.defaultValue),
  );
  const [dirty, setDirty] = useState(false);

  function onToggle(checked: boolean): void {
    setEnabled(checked);
    setClientFlag(flag.key, checked);
    setDirty(true);
  }

  function onReset(): void {
    resetClientFlag(flag.key);
    setEnabled(flag.defaultValue);
    setDirty(true);
  }

  return (
    <div className="rounded-md border border-border bg-secondary/30 p-3">
      <div className="flex items-start justify-between gap-3">
        <label className="flex flex-1 cursor-pointer items-start gap-2">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => onToggle(e.target.checked)}
            className="mt-0.5"
          />
          <div className="flex-1">
            <div className="text-sm font-medium">{flag.label}</div>
            <code className="text-[10px] text-muted-foreground">{flag.key}</code>
            {dirty && (
              <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
                Перезагрузи страницу чтобы изменения применились
              </p>
            )}
          </div>
        </label>
        <Button type="button" variant="ghost" size="sm" onClick={onReset}>
          Сброс
        </Button>
      </div>
    </div>
  );
}

// ─────────────────── Other server flags (not in registry) ───────────────────

/**
 * Server-флаги созданные ad-hoc (не в registry). Показываем для возможности
 * удалить мусорные / legacy записи.
 */
function OtherServerFlagsSection(): JSX.Element {
  const flags = useFeatureFlags();
  const del = useDeleteFeatureFlag();

  const knownKeys = useMemo(
    () => new Set(CLIENT_FEATURE_FLAGS.map((f) => f.key)),
    [],
  );
  const otherRows = (flags.data ?? []).filter((r) => !knownKeys.has(r.key));

  if (otherRows.length === 0) return <></>;

  // Group by key.
  const byKey = new Map<string, FlagRow[]>();
  for (const r of otherRows) {
    const arr = byKey.get(r.key) ?? [];
    arr.push(r);
    byKey.set(r.key, arr);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          Прочие server-флаги (не в registry)
        </CardTitle>
        <CardDescription>
          Ad-hoc флаги созданные кем-то вручную (placeholder / legacy / тест).
          Не привязаны к UI карточкам. Можно удалить если не используются.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {[...byKey.entries()].sort().map(([key, rows]) => (
          <div key={key} className="rounded border border-border p-2">
            <code className="text-xs font-mono font-semibold">{key}</code>
            <div className="mt-1 space-y-1">
              {rows.map((r) => (
                <div
                  key={r.id}
                  className="flex items-center gap-2 text-xs text-muted-foreground"
                >
                  <span>{r.scope}</span>
                  {r.scopeRefId && (
                    <code className="font-mono">
                      {r.scopeRefId.slice(0, 8)}…
                    </code>
                  )}
                  <span>{r.enabled ? "✓ enabled" : "✗ disabled"}</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="ml-auto h-6 px-2"
                    onClick={() => del.mutate(r.id)}
                    disabled={del.isPending}
                  >
                    Удалить
                  </Button>
                </div>
              ))}
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
