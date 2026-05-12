import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/features/auth/AuthProvider";
import {
  useAdminUsers,
  useImpersonateUser,
  useSetUserRole,
  useSetUserStatus,
} from "@/features/admin/users/hooks";
import type {
  AdminUserRole,
  AdminUserRow,
  AdminUserStatus,
} from "@/features/admin/users/api";
import { ApiError } from "@/lib/api/client";
import { cn } from "@/lib/utils";

import { PageHeader } from "./_PageHeader";

const STATUSES: Array<{ value: AdminUserStatus | ""; label: string }> = [
  { value: "", label: "Все статусы" },
  { value: "active", label: "Active" },
  { value: "pending", label: "Pending" },
  { value: "blocked", label: "Blocked" },
];

const ROLES: Array<{ value: AdminUserRole | ""; label: string }> = [
  { value: "", label: "Все роли" },
  { value: "admin", label: "Admin" },
  { value: "user", label: "User" },
  { value: "viewer", label: "Viewer" },
];

export function AdminUsersPage(): JSX.Element {
  const [statusFilter, setStatusFilter] = useState<AdminUserStatus | "">("");
  const [roleFilter, setRoleFilter] = useState<AdminUserRole | "">("");
  const [search, setSearch] = useState("");

  // Debounce-lite: only fire the query for searches once 250ms idle.
  const [debouncedSearch, setDebouncedSearch] = useState("");
  useDebouncedValue(search, 250, setDebouncedSearch);

  const filter = useMemo(
    () => ({
      ...(statusFilter ? { status: statusFilter } : {}),
      ...(roleFilter ? { role: roleFilter } : {}),
      ...(debouncedSearch.trim() ? { search: debouncedSearch.trim() } : {}),
    }),
    [statusFilter, roleFilter, debouncedSearch]
  );

  const { data, isLoading, error, refetch } = useAdminUsers(filter);

  return (
    <div>
      <PageHeader
        title="Пользователи"
        description="Список пользователей платформы. Изменение статуса/роли и view-mode impersonation."
        actions={
          <Button variant="outline" size="sm" onClick={() => refetch()}>
            Обновить
          </Button>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Select
          value={statusFilter}
          onChange={(v) => setStatusFilter(v as AdminUserStatus | "")}
          options={STATUSES}
        />
        <Select
          value={roleFilter}
          onChange={(v) => setRoleFilter(v as AdminUserRole | "")}
          options={ROLES}
        />
        <Input
          placeholder="Поиск по email или имени…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="max-w-xs"
        />
        {(statusFilter || roleFilter || search) && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setStatusFilter("");
              setRoleFilter("");
              setSearch("");
            }}
          >
            Сбросить
          </Button>
        )}
      </div>

      {error && (
        <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          Ошибка загрузки: {(error as Error).message}
        </p>
      )}

      <div className="overflow-hidden rounded-lg border border-border bg-card/40">
        <table className="w-full text-sm">
          <thead className="bg-card/80 text-left text-xs uppercase tracking-wider text-muted-foreground">
            <tr>
              <th className="px-4 py-3 font-medium">Пользователь</th>
              <th className="px-4 py-3 font-medium">Роль</th>
              <th className="px-4 py-3 font-medium">Статус</th>
              <th className="px-4 py-3 font-medium">Аккаунтов</th>
              <th className="px-4 py-3 font-medium">Последний refresh</th>
              <th className="px-4 py-3 font-medium">Последний login</th>
              <th className="px-4 py-3 font-medium text-right">Действия</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {isLoading && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-muted-foreground">
                  Загрузка…
                </td>
              </tr>
            )}
            {!isLoading && data?.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-muted-foreground">
                  Нет пользователей под текущие фильтры.
                </td>
              </tr>
            )}
            {data?.map((u) => (
              <UserRow key={u.id} user={u} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function UserRow({ user }: { readonly user: AdminUserRow }) {
  const { user: me, startImpersonation } = useAuth();
  const navigate = useNavigate();
  const setStatus = useSetUserStatus();
  const setRole = useSetUserRole();
  const impersonate = useImpersonateUser();

  const [confirmImpersonate, setConfirmImpersonate] = useState(false);
  const [rowError, setRowError] = useState<string | null>(null);

  const isSelf = me?.id === user.id;

  async function handleStatusChange(next: AdminUserStatus) {
    if (next === user.status) return;
    setRowError(null);
    try {
      await setStatus.mutateAsync({ id: user.id, status: next });
    } catch (e) {
      setRowError(formatError(e));
    }
  }

  async function handleRoleChange(next: AdminUserRole) {
    if (next === user.role) return;
    setRowError(null);
    try {
      await setRole.mutateAsync({ id: user.id, role: next });
    } catch (e) {
      setRowError(formatError(e));
    }
  }

  async function handleImpersonate() {
    setRowError(null);
    setConfirmImpersonate(false);
    try {
      const res = await impersonate.mutateAsync(user.id);
      await startImpersonation({
        accessToken: res.accessToken,
        impersonatedUserId: user.id,
      });
      navigate("/", { replace: true });
    } catch (e) {
      setRowError(formatError(e));
    }
  }

  return (
    <tr className="hover:bg-card/60">
      <td className="px-4 py-3">
        <div className="font-medium text-foreground">{user.name ?? "—"}</div>
        <div className="text-xs text-muted-foreground">
          {user.email ?? "—"}
        </div>
      </td>
      <td className="px-4 py-3">
        <Select
          value={user.role}
          onChange={(v) => handleRoleChange(v as AdminUserRole)}
          options={ROLES.filter((r) => r.value !== "")}
          compact
          disabled={isSelf || setRole.isPending}
        />
      </td>
      <td className="px-4 py-3">
        <div className="flex items-center gap-2">
          <Select
            value={user.status}
            onChange={(v) => handleStatusChange(v as AdminUserStatus)}
            options={STATUSES.filter((s) => s.value !== "")}
            compact
            disabled={isSelf || setStatus.isPending}
          />
          <StatusBadge status={user.status} />
        </div>
      </td>
      <td className="px-4 py-3 text-muted-foreground">{user.accountCount}</td>
      <td className="px-4 py-3 text-muted-foreground">
        {formatSnapshot(user.lastSnapshotAt, user.lastSnapshotUsd)}
      </td>
      <td className="px-4 py-3 text-muted-foreground">
        {user.lastLoginAt ? formatDate(user.lastLoginAt) : "никогда"}
      </td>
      <td className="px-4 py-3 text-right">
        <Button
          variant="outline"
          size="sm"
          disabled={isSelf || impersonate.isPending}
          onClick={() => setConfirmImpersonate(true)}
        >
          Impersonate
        </Button>
        {rowError && (
          <div className="mt-1 text-xs text-destructive">{rowError}</div>
        )}
      </td>

      <Dialog
        open={confirmImpersonate}
        onClose={() => setConfirmImpersonate(false)}
        title="Войти от лица пользователя?"
        description={`${user.name ?? user.email} · ${user.email}`}
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => setConfirmImpersonate(false)}
            >
              Отмена
            </Button>
            <Button onClick={handleImpersonate}>Войти в view-mode</Button>
          </>
        }
      >
        <div className="space-y-2 text-sm text-muted-foreground">
          <p>
            Сессия заменится на сессию пользователя в read-only режиме. Все
            действия пишутся в audit_log с пометкой <code>as_admin</code>.
          </p>
          <p>
            <span className="font-medium text-red-300">Важно:</span> ваша
            админская сессия будет завершена. После «Завершить» в красном
            баннере вы попадёте на /login и войдёте как админ заново.
          </p>
        </div>
      </Dialog>
    </tr>
  );
}

function StatusBadge({ status }: { readonly status: AdminUserStatus }) {
  if (status === "active") return <Badge variant="success">active</Badge>;
  if (status === "blocked") return <Badge variant="destructive">blocked</Badge>;
  return <Badge variant="warning">pending</Badge>;
}

// ─── shared bits ─────────────────────────────────────────────────────

interface SelectOption {
  readonly value: string;
  readonly label: string;
}

function Select({
  value,
  onChange,
  options,
  compact,
  disabled,
}: {
  readonly value: string;
  readonly onChange: (v: string) => void;
  readonly options: readonly SelectOption[];
  readonly compact?: boolean;
  readonly disabled?: boolean;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      className={cn(
        "rounded-md border border-border bg-background px-3 text-sm",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        "disabled:cursor-not-allowed disabled:opacity-50",
        compact ? "h-8" : "h-10"
      )}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

function useDebouncedValue<T>(
  value: T,
  delayMs: number,
  cb: (v: T) => void
): void {
  useEffect(() => {
    const id = window.setTimeout(() => cb(value), delayMs);
    return () => window.clearTimeout(id);
  }, [value, delayMs, cb]);
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatSnapshot(at: string | null, usd: number | null): string {
  if (!at) return "никогда";
  const when = formatDate(at);
  if (usd === null || usd === undefined) return when;
  return `${when} · $${Math.round(usd).toLocaleString("ru-RU")}`;
}

function formatError(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 403) return "Недостаточно прав.";
    if (e.status === 404) return "Пользователь не найден.";
    return `Ошибка ${e.status}.`;
  }
  return "Сеть недоступна.";
}
