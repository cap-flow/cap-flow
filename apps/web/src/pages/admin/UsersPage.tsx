import { useEffect, useMemo, useState } from "react";
import { Trash2 } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/features/auth/AuthProvider";
import {
  useAdminUsers,
  useDeleteUser,
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
import { InvitesPanel } from "./InvitesPage";

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

type UsersTab = "users" | "invites";

export function AdminUsersPage(): JSX.Element {
  const [statusFilter, setStatusFilter] = useState<AdminUserStatus | "">("");
  const [roleFilter, setRoleFilter] = useState<AdminUserRole | "">("");
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState<UsersTab>("users");

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
        description="Список пользователей платформы + invite-ссылки на регистрацию. Объединено в один раздел — invite это часть user lifecycle, не отдельная сущность."
        actions={
          tab === "users" ? (
            <Button variant="outline" size="sm" onClick={() => refetch()}>
              Обновить
            </Button>
          ) : null
        }
      />

      <div className="mb-4 inline-flex rounded-md border border-border bg-card/40 p-1">
        <button
          type="button"
          onClick={() => setTab("users")}
          className={cn(
            "rounded px-3 py-1.5 text-sm font-medium transition-colors",
            tab === "users"
              ? "bg-accent text-foreground"
              : "text-muted-foreground hover:text-foreground"
          )}
        >
          Зарегистрированные ({data?.items.length ?? 0})
        </button>
        <button
          type="button"
          onClick={() => setTab("invites")}
          className={cn(
            "rounded px-3 py-1.5 text-sm font-medium transition-colors",
            tab === "invites"
              ? "bg-accent text-foreground"
              : "text-muted-foreground hover:text-foreground"
          )}
        >
          Приглашения
        </button>
      </div>

      {tab === "invites" && <InvitesPanel />}
      {tab === "users" && (
        <UsersTabContent
          data={data}
          isLoading={isLoading}
          error={error as Error | null}
          statusFilter={statusFilter}
          setStatusFilter={setStatusFilter}
          roleFilter={roleFilter}
          setRoleFilter={setRoleFilter}
          search={search}
          setSearch={setSearch}
        />
      )}
    </div>
  );
}

function UsersTabContent({
  data,
  isLoading,
  error,
  statusFilter,
  setStatusFilter,
  roleFilter,
  setRoleFilter,
  search,
  setSearch,
}: {
  readonly data:
    | { items: AdminUserRow[]; nextCursor: string | null }
    | undefined;
  readonly isLoading: boolean;
  readonly error: Error | null;
  readonly statusFilter: AdminUserStatus | "";
  readonly setStatusFilter: (v: AdminUserStatus | "") => void;
  readonly roleFilter: AdminUserRole | "";
  readonly setRoleFilter: (v: AdminUserRole | "") => void;
  readonly search: string;
  readonly setSearch: (v: string) => void;
}): JSX.Element {
  return (
    <>
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

      <div className="overflow-x-auto rounded-lg border border-border bg-card/40">
        <table className="w-full min-w-[1100px] text-sm">
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
            {!isLoading && data?.items.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-muted-foreground">
                  Нет пользователей под текущие фильтры.
                </td>
              </tr>
            )}
            {data?.items.map((u) => (
              <UserRow key={u.id} user={u} />
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function UserRow({ user }: { readonly user: AdminUserRow }) {
  const { user: me, startImpersonation } = useAuth();
  const navigate = useNavigate();
  const setStatus = useSetUserStatus();
  const setRole = useSetUserRole();
  const impersonate = useImpersonateUser();
  const deleteUser = useDeleteUser();

  const [confirmImpersonate, setConfirmImpersonate] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState("");
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

  async function handleDelete() {
    setRowError(null);
    try {
      await deleteUser.mutateAsync(user.id);
      setConfirmDelete(false);
      setDeleteConfirmText("");
    } catch (e) {
      setRowError(formatError(e));
    }
  }

  const expectedConfirm = (user.email ?? user.name ?? "удалить").trim();
  const canConfirmDelete =
    deleteConfirmText.trim().toLowerCase() === expectedConfirm.toLowerCase();

  return (
    <tr className="hover:bg-card/60">
      <td className="px-4 py-3">
        <Link
          to={`/admin/users/${user.id}`}
          className="block hover:text-brand-cyan transition"
        >
          <div className="font-medium text-foreground hover:underline">
            {user.name ?? "—"}
          </div>
          <div className="text-xs text-muted-foreground">
            {user.email ?? "—"}
          </div>
        </Link>
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
        <div className="inline-flex gap-1.5">
          <Button
            variant="outline"
            size="sm"
            disabled={isSelf || impersonate.isPending}
            onClick={() => setConfirmImpersonate(true)}
          >
            Impersonate
          </Button>
          <Button
            variant="destructive"
            size="sm"
            disabled={isSelf || deleteUser.isPending}
            onClick={() => {
              setDeleteConfirmText("");
              setConfirmDelete(true);
            }}
            title={
              isSelf
                ? "Нельзя удалить самого себя"
                : "Удалить пользователя и все его данные"
            }
          >
            <Trash2 className="h-3.5 w-3.5" />
            Удалить
          </Button>
        </div>
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

      <Dialog
        open={confirmDelete}
        onClose={() => {
          if (!deleteUser.isPending) {
            setConfirmDelete(false);
            setDeleteConfirmText("");
          }
        }}
        title="Удалить пользователя?"
        description={`${user.name ?? "—"} · ${user.email ?? "—"}`}
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => {
                setConfirmDelete(false);
                setDeleteConfirmText("");
              }}
              disabled={deleteUser.isPending}
            >
              Отмена
            </Button>
            <Button
              onClick={handleDelete}
              disabled={!canConfirmDelete || deleteUser.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleteUser.isPending ? "Удаляем…" : "Удалить навсегда"}
            </Button>
          </>
        }
      >
        <div className="space-y-3 text-sm">
          <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-destructive">
            <div className="font-semibold">⚠ Действие необратимо</div>
            <div className="mt-1 text-xs">
              Будут удалены: все аккаунты пользователя ({user.accountCount} шт.),
              кошельки, история операций, snapshot'ы, платежи, подписки,
              сессии. Записи в audit_log сохранятся (для forensic-расследований),
              но FK на пользователя обнулится.
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`confirm-${user.id}`}>
              Введите{" "}
              <code className="rounded bg-secondary px-1.5 py-0.5 font-mono text-xs">
                {expectedConfirm}
              </code>{" "}
              для подтверждения
            </Label>
            <Input
              id={`confirm-${user.id}`}
              value={deleteConfirmText}
              onChange={(e) => setDeleteConfirmText(e.target.value)}
              autoFocus
              autoComplete="off"
              disabled={deleteUser.isPending}
            />
          </div>
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
