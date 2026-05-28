import { useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAdminPortfolios } from "@/features/admin/portfolios/hooks";
import {
  useAdminOperationFacets,
  useAdminOperations,
} from "@/features/admin/operations/hooks";
import type { AdminOperationsParams } from "@/features/admin/operations/api";

import { PageHeader } from "./_PageHeader";

const PAGE_SIZE = 100;

const OP_TYPES = [
  "buy",
  "sell",
  "swap",
  "transfer",
  "deposit",
  "withdraw",
  "fee",
  "open",
  "close",
  "loan",
  "loan_repay",
  "loan_take",
  "div",
  "other",
] as const;

const selectClass =
  "h-10 rounded-md border border-border bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";

interface Filters {
  userId: string;
  accountId: string;
  type: string;
  network: string;
  from: string;
  to: string;
  search: string;
}

const EMPTY_FILTERS: Filters = {
  userId: "",
  accountId: "",
  type: "",
  network: "",
  from: "",
  to: "",
  search: "",
};

export function AdminOperationsRegistryPage(): JSX.Element {
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [offset, setOffset] = useState(0);

  const portfolios = useAdminPortfolios();
  const facets = useAdminOperationFacets();

  // Derive user + account filter options from the portfolios table.
  const users = useMemo(() => {
    const map = new Map<string, string>();
    for (const a of portfolios.data ?? []) {
      if (!map.has(a.ownerId)) {
        map.set(a.ownerId, a.ownerEmail ?? a.ownerName ?? a.ownerId);
      }
    }
    return Array.from(map.entries()).sort((x, y) => x[1].localeCompare(y[1]));
  }, [portfolios.data]);

  const accounts = useMemo(() => {
    return (portfolios.data ?? [])
      .filter((a) => !filters.userId || a.ownerId === filters.userId)
      .map((a) => ({
        id: a.accountId,
        label: `${a.accountName} · ${a.ownerEmail ?? a.ownerName ?? "—"}`,
      }))
      .sort((x, y) => x.label.localeCompare(y.label));
  }, [portfolios.data, filters.userId]);

  const params: AdminOperationsParams = {
    userId: filters.userId || undefined,
    accountId: filters.accountId || undefined,
    type: filters.type || undefined,
    network: filters.network || undefined,
    from: filters.from || undefined,
    to: filters.to || undefined,
    search: filters.search || undefined,
    limit: PAGE_SIZE,
    offset,
  };

  const query = useAdminOperations(params);

  function patch(p: Partial<Filters>) {
    setFilters((prev) => ({ ...prev, ...p }));
    setOffset(0);
  }

  const total = query.data?.total ?? 0;
  const items = query.data?.items ?? [];
  const pageStart = total === 0 ? 0 : offset + 1;
  const pageEnd = offset + items.length;
  const hasActiveFilters = Object.values(filters).some((v) => v !== "");

  return (
    <div>
      <PageHeader
        title="Реестр операций"
        description="Единое окно: операции всех аккаунтов всех пользователей. Идентификация по владельцу, аккаунту и кошельку — без переключения между аккаунтами."
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => query.refetch()}
            disabled={query.isFetching}
          >
            Обновить
          </Button>
        }
      />

      {/* Фильтры */}
      <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <select
          className={selectClass}
          value={filters.userId}
          onChange={(e) => patch({ userId: e.target.value, accountId: "" })}
          aria-label="Пользователь"
        >
          <option value="">Все пользователи</option>
          {users.map(([id, label]) => (
            <option key={id} value={id}>
              {label}
            </option>
          ))}
        </select>

        <select
          className={selectClass}
          value={filters.accountId}
          onChange={(e) => patch({ accountId: e.target.value })}
          aria-label="Аккаунт"
        >
          <option value="">Все аккаунты</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.label}
            </option>
          ))}
        </select>

        <select
          className={selectClass}
          value={filters.type}
          onChange={(e) => patch({ type: e.target.value })}
          aria-label="Тип операции"
        >
          <option value="">Все типы</option>
          {OP_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>

        <select
          className={selectClass}
          value={filters.network}
          onChange={(e) => patch({ network: e.target.value })}
          aria-label="Сеть"
        >
          <option value="">Все сети</option>
          {(facets.data?.networks ?? []).map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>

        <Input
          type="date"
          value={filters.from}
          onChange={(e) => patch({ from: e.target.value })}
          aria-label="Дата с"
        />
        <Input
          type="date"
          value={filters.to}
          onChange={(e) => patch({ to: e.target.value })}
          aria-label="Дата по"
        />
        <Input
          type="search"
          placeholder="Поиск: кошелёк, токен, комментарий…"
          value={filters.search}
          onChange={(e) => patch({ search: e.target.value })}
          className="lg:col-span-2"
          aria-label="Поиск"
        />
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs text-muted-foreground">
          {query.isLoading
            ? "Загрузка…"
            : total === 0
              ? "Операций не найдено"
              : `${pageStart}–${pageEnd} из ${total.toLocaleString("ru-RU")}`}
        </div>
        {hasActiveFilters && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setFilters(EMPTY_FILTERS);
              setOffset(0);
            }}
          >
            Сбросить фильтры
          </Button>
        )}
      </div>

      {query.error && (
        <p className="mt-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          Ошибка загрузки: {(query.error as Error).message}
        </p>
      )}

      <div className="mt-3 overflow-x-auto rounded-lg border border-border bg-card/40">
        <table className="w-full min-w-[1100px] text-sm">
          <thead className="bg-card/80 text-left text-xs uppercase tracking-wider text-muted-foreground">
            <tr>
              <th className="px-3 py-3 font-medium">Дата</th>
              <th className="px-3 py-3 font-medium">Владелец</th>
              <th className="px-3 py-3 font-medium">Аккаунт</th>
              <th className="px-3 py-3 font-medium">Тип</th>
              <th className="px-3 py-3 font-medium">Откуда → Куда</th>
              <th className="px-3 py-3 font-medium text-right">Сумма 1</th>
              <th className="px-3 py-3 font-medium text-right">Сумма 2</th>
              <th className="px-3 py-3 font-medium">Сеть</th>
              <th className="px-3 py-3 font-medium">Источник</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {!query.isLoading && items.length === 0 && (
              <tr>
                <td
                  colSpan={9}
                  className="px-3 py-8 text-center text-muted-foreground"
                >
                  Нет операций по текущему фильтру.
                </td>
              </tr>
            )}
            {items.map((op) => (
              <tr key={op.id} className="hover:bg-card/60">
                <td className="whitespace-nowrap px-3 py-2.5 text-muted-foreground tabular-nums">
                  {op.date}
                </td>
                <td className="px-3 py-2.5">
                  <div className="text-foreground">{op.ownerName ?? "—"}</div>
                  <div className="text-xs text-muted-foreground">
                    {op.ownerEmail ?? "—"}
                  </div>
                </td>
                <td className="px-3 py-2.5 text-foreground">{op.accountName}</td>
                <td className="px-3 py-2.5">
                  <Badge variant="muted">{op.type}</Badge>
                </td>
                <td className="px-3 py-2.5 text-foreground">
                  <span>{op.fromName ?? "—"}</span>
                  <span className="text-muted-foreground"> → </span>
                  <span>{op.toName ?? "—"}</span>
                  {op.comment && (
                    <div className="truncate text-xs text-muted-foreground max-w-[280px]">
                      {op.comment}
                    </div>
                  )}
                </td>
                <td className="whitespace-nowrap px-3 py-2.5 text-right tabular-nums">
                  {fmtAmount(op.amount1)} {op.cur1 ?? ""}
                </td>
                <td className="whitespace-nowrap px-3 py-2.5 text-right tabular-nums">
                  {fmtAmount(op.amount2)} {op.cur2 ?? ""}
                </td>
                <td className="px-3 py-2.5 text-muted-foreground">
                  {op.network ?? "—"}
                </td>
                <td className="px-3 py-2.5">
                  <Badge variant="outline">{op.source}</Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Пагинация */}
      <div className="mt-3 flex items-center justify-end gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={offset === 0 || query.isFetching}
          onClick={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))}
        >
          Назад
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={pageEnd >= total || query.isFetching}
          onClick={() => setOffset((o) => o + PAGE_SIZE)}
        >
          Вперёд
        </Button>
      </div>
    </div>
  );
}

function fmtAmount(v: string | null): string {
  if (v === null) return "—";
  const n = Number(v);
  if (Number.isNaN(n)) return v;
  return n.toLocaleString("ru-RU", { maximumFractionDigits: 8 });
}
