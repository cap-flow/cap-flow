import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n/I18nProvider";
import { getColumnCell, type CellContext } from "@/lib/portfolio/column_sort_filter";
import { totalAssetsOf, type OpenPosition } from "@cap-flow/ucb/open_positions";
import { useAllPositions } from "@/features/admin/all-positions/hooks";
import type { AllPositionItem } from "@/features/admin/all-positions/api";

import { PageHeader } from "./_PageHeader";

/** Same column set + labels as the user-facing open-positions table. */
const COLUMNS: { id: string; label: string }[] = [
  { id: "ageDays", label: "Срок" },
  { id: "wallet", label: "Кошелёк" },
  { id: "chain", label: "Сеть" },
  { id: "protocol", label: "Протокол" },
  { id: "kind", label: "Тип" },
  { id: "capital", label: "Капитал" },
  { id: "tokenId", label: "TokenId / NFT" },
  { id: "openedInToken", label: "Открыто в" },
  { id: "openedInAmount", label: "Внесено токенов" },
  { id: "supplyTokens", label: "Состав позиции" },
  { id: "startUsd", label: "Стартовая $" },
  { id: "currentUsd", label: "Текущая $" },
  { id: "pnl", label: "PnL позиций" },
  { id: "fee", label: "Fee" },
  { id: "feeApr", label: "Fee APR" },
  { id: "totalAssets", label: "Итого активы" },
  { id: "totalPnl", label: "Total PnL" },
  { id: "totalApr", label: "Total APR" },
  { id: "weight", label: "Вес %" },
];

const SIGNED = new Set(["pnl", "totalPnl", "totalApr"]);

function Cell({ p, id, ctx }: { p: OpenPosition; id: string; ctx: CellContext }): JSX.Element {
  let values: string[];
  try {
    values = getColumnCell(p, id, ctx).values;
  } catch {
    values = ["—"];
  }
  let color = "";
  if (SIGNED.has(id)) {
    const v = id === "pnl" ? p.currentUsd - p.startUsd : totalAssetsOf(p) - p.startUsd;
    color = v > 0 ? "text-success" : v < 0 ? "text-destructive" : "";
  }
  return (
    <td className={`px-2 py-1.5 text-center ${color}`}>
      {values.length === 0 ? "—" : values.map((v, i) => <div key={i}>{v}</div>)}
    </td>
  );
}

function AnomalyBadge({ item }: { item: AllPositionItem }): JSX.Element {
  if (item.anomalies.length === 0) return <span className="text-success">✓</span>;
  const hasError = item.anomalies.some((a) => a.severity === "error");
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-xs ${hasError ? "bg-destructive/15 text-destructive" : "bg-amber-500/15 text-amber-600"}`}
      title={item.anomalies.map((a) => `${a.severity} ${a.checkId}: ${a.reason}`).join("\n")}
    >
      ⚠ {item.anomalies.length}
    </span>
  );
}

export function AdminAllPositionsPage(): JSX.Element {
  const q = useAllPositions();
  const { locale } = useI18n();
  const [account, setAccount] = useState("");
  const [wallet, setWallet] = useState("");
  const [search, setSearch] = useState("");
  const [onlyAnomalies, setOnlyAnomalies] = useState(false);

  const items = q.data?.items ?? [];

  // Account + wallet option lists.
  const accountOptions = useMemo(() => {
    const m = new Map<string, string>();
    for (const it of items) m.set(it.accountId, it.ownerEmail ?? it.accountName ?? it.accountId.slice(0, 8));
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [items]);

  const walletOptions = useMemo(() => {
    const m = new Map<string, string>();
    for (const it of items) {
      if (account && it.accountId !== account) continue;
      const p = it.position as unknown as OpenPosition;
      if (p.walletId) m.set(p.walletId, p.walletName || p.walletId.slice(0, 8));
    }
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [items, account]);

  const rows = useMemo(() => {
    const s = search.trim().toLowerCase();
    return items.filter((it) => {
      if (account && it.accountId !== account) return false;
      const p = it.position as unknown as OpenPosition;
      if (wallet && p.walletId !== wallet) return false;
      if (onlyAnomalies && it.anomalies.length === 0) return false;
      if (!s) return true;
      return (
        (it.ownerEmail ?? "").toLowerCase().includes(s) ||
        (p.protocol?.name ?? "").toLowerCase().includes(s) ||
        p.supplyTokens?.some((t) => t.symbol.toLowerCase().includes(s)) ||
        (p.chain ?? "").toLowerCase().includes(s)
      );
    });
  }, [items, account, wallet, search, onlyAnomalies]);

  const ctx: CellContext = useMemo(
    () => ({
      sumCurrentUsd: rows.reduce((s, it) => s + ((it.position as unknown as OpenPosition).currentUsd ?? 0), 0),
      locale,
    }),
    [rows, locale],
  );

  const anomalyCount = items.filter((it) => it.anomalies.length > 0).length;

  return (
    <div>
      <PageHeader
        title="Все позиции"
        description="Единый реестр открытых позиций со всех аккаунтов (серверный канонический расчёт), в том же виде, что и пользовательский список. Обновляется по мере пересчёта воркером."
        actions={
          <Button variant="outline" size="sm" onClick={() => q.refetch()}>
            Обновить
          </Button>
        }
      />

      <div className="mb-3 flex flex-wrap items-center gap-3 text-sm">
        <select
          value={account}
          onChange={(e) => { setAccount(e.target.value); setWallet(""); }}
          className="rounded-md border border-border bg-background px-3 py-1.5 text-sm"
        >
          <option value="">— все аккаунты —</option>
          {accountOptions.map(([id, label]) => (
            <option key={id} value={id}>{label}</option>
          ))}
        </select>
        <select
          value={wallet}
          onChange={(e) => setWallet(e.target.value)}
          className="rounded-md border border-border bg-background px-3 py-1.5 text-sm"
        >
          <option value="">— все кошельки —</option>
          {walletOptions.map(([id, label]) => (
            <option key={id} value={id}>{label}</option>
          ))}
        </select>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="поиск: email / протокол / актив / сеть"
          className="w-72 rounded-md border border-border bg-background px-3 py-1.5 text-sm"
        />
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={onlyAnomalies} onChange={(e) => setOnlyAnomalies(e.target.checked)} />
          только с аномалиями
        </label>
        <span className="text-muted-foreground">
          {q.data ? `${q.data.accounts} акк. · ${rows.length}/${items.length} позиций · аномалий: ${anomalyCount}` : ""}
        </span>
      </div>

      {q.error && (
        <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {(q.error as Error).message}
        </p>
      )}
      {q.data && items.length === 0 && (
        <p className="text-sm text-muted-foreground">
          Нет посчитанных позиций. Аккаунт появляется здесь после серверного расчёта (флаг ucbServerShadow ON /
          кнопка «Рассчитать» на UCB Server / прогон воркера).
        </p>
      )}

      {rows.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="text-xs">
            <thead className="border-y border-border bg-secondary/40 uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="px-2 py-1.5 text-left">Владелец</th>
                {COLUMNS.map((c) => (
                  <th key={c.id} className="px-2 py-1.5 text-center whitespace-nowrap">{c.label}</th>
                ))}
                <th className="px-2 py-1.5 text-center">Аномалии</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((it) => {
                const p = it.position as unknown as OpenPosition;
                return (
                  <tr key={`${it.accountId}|${p.id}`} className="border-t border-border/60 hover:bg-muted/30">
                    <td className="px-2 py-1.5 text-left whitespace-nowrap">{it.ownerEmail ?? it.accountName ?? it.accountId.slice(0, 8)}</td>
                    {COLUMNS.map((c) => (
                      <Cell key={c.id} p={p} id={c.id} ctx={ctx} />
                    ))}
                    <td className="px-2 py-1.5 text-center"><AnomalyBadge item={it} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
