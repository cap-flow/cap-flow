import { useMemo, useState } from "react";
import { ArrowDownUp, Layers, Search } from "lucide-react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { useI18n } from "@/i18n/I18nProvider";
import { formatUsd } from "@/i18n/format";
import { usePrimaryAccount } from "@/features/accounts/hooks";
import { useAccountSnapshot } from "@/features/portfolio/hooks";

type SortField = "asset" | "debt" | "net";
type SortDir = "asc" | "desc";

/**
 * Server-driven "Открытые позиции" table.
 *
 * Renders the flat list of every DeFi position the user has across all
 * wallets, sourced directly from the worker snapshot. No client-side
 * compute, no LoadedWalletsProvider. Each row is one DeBank
 * `portfolio_item` — Aave with collateral + borrow is one row, a V3
 * LP NFT is one row, etc.
 *
 * Phase F6b slice 5. Successor of the 3.5k-line legacy
 * OpenPositionsPage, which the dashboard routes to only when the
 * LoadedWalletsProvider has data. For SaaS users on the
 * server-snapshot path this is the entry point.
 */
export function ServerOpenPositionsPage(): JSX.Element {
  const { locale } = useI18n();
  const primary = usePrimaryAccount();
  const { metrics, isLoading } = useAccountSnapshot(primary?.id);

  const [query, setQuery] = useState("");
  const [sortField, setSortField] = useState<SortField>("asset");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const positions = metrics?.positions ?? [];

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    let rows = positions;
    if (q) {
      rows = rows.filter((p) => {
        if (p.protocolName.toLowerCase().includes(q)) return true;
        if (p.chain.toLowerCase().includes(q)) return true;
        if (p.itemName.toLowerCase().includes(q)) return true;
        if (p.walletName.toLowerCase().includes(q)) return true;
        if (p.supplyTokens.some((t) => t.symbol.toLowerCase().includes(q)))
          return true;
        if (p.debtTokens.some((t) => t.symbol.toLowerCase().includes(q)))
          return true;
        return false;
      });
    }
    const dir = sortDir === "asc" ? 1 : -1;
    const fieldKey: keyof typeof rows[0] =
      sortField === "asset"
        ? "assetUsd"
        : sortField === "debt"
          ? "debtUsd"
          : "netUsd";
    rows = [...rows].sort((a, b) => dir * (Number(a[fieldKey]) - Number(b[fieldKey])));
    return rows;
  }, [positions, query, sortField, sortDir]);

  const totalAsset = positions.reduce((s, p) => s + p.assetUsd, 0);
  const totalDebt = positions.reduce((s, p) => s + p.debtUsd, 0);
  const totalNet = totalAsset - totalDebt;

  function toggleSort(f: SortField) {
    if (sortField === f) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortField(f);
      setSortDir("desc");
    }
  }

  return (
    <div className="mx-auto max-w-7xl space-y-4 p-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Открытые позиции
        </h1>
        <p className="text-sm text-muted-foreground">
          {positions.length} позиций · server snapshot. Каждая строка —
          одна позиция в DeFi-протоколе (Aave, V3 LP, Yearn vault, ...).
        </p>
      </div>

      {/* KPI strip */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <KpiCard
          label="Активы в работе"
          value={formatUsd(totalAsset, locale)}
          tone="default"
        />
        <KpiCard
          label="Совокупный долг"
          value={totalDebt > 0 ? formatUsd(totalDebt, locale) : "—"}
          tone={totalDebt > 0 ? "destructive" : "muted"}
        />
        <KpiCard
          label="Нетто"
          value={formatUsd(totalNet, locale)}
          tone={totalNet >= 0 ? "success" : "destructive"}
        />
      </div>

      {/* Search */}
      <div className="relative max-w-md">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder="Поиск по протоколу, сети, токену, кошельку..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="pl-9"
        />
      </div>

      {/* Table */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <Layers className="h-4 w-4 text-brand-cyan" />
            <CardTitle className="text-base">Позиции</CardTitle>
            <CardDescription className="ml-auto text-xs">
              {filtered.length} из {positions.length}
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading && positions.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-muted-foreground">
              Загружаем…
            </p>
          ) : positions.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-muted-foreground">
              Нет открытых позиций. Подключи кошельки в Реестре и нажми «Обновить».
            </p>
          ) : (
            <div className="overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-card/80 text-left text-xs uppercase tracking-wider text-muted-foreground">
                  <tr>
                    <th className="px-4 py-3 font-medium">Протокол</th>
                    <th className="px-4 py-3 font-medium">Кошелёк</th>
                    <th className="px-4 py-3 font-medium">Состав</th>
                    <SortableTh
                      label="Актив"
                      field="asset"
                      sortField={sortField}
                      sortDir={sortDir}
                      onClick={() => toggleSort("asset")}
                    />
                    <SortableTh
                      label="Долг"
                      field="debt"
                      sortField={sortField}
                      sortDir={sortDir}
                      onClick={() => toggleSort("debt")}
                    />
                    <SortableTh
                      label="Нетто"
                      field="net"
                      sortField={sortField}
                      sortDir={sortDir}
                      onClick={() => toggleSort("net")}
                    />
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {filtered.map((p) => (
                    <tr key={p.id} className="hover:bg-card/60">
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-foreground">
                            {p.protocolName}
                          </span>
                          <Badge variant="outline" className="text-[9px]">
                            {p.chain}
                          </Badge>
                        </div>
                        <div className="mt-0.5 text-[10px] text-muted-foreground">
                          {p.itemName}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="text-foreground">{p.walletName}</div>
                        <div className="font-mono text-[10px] text-muted-foreground">
                          {p.address.slice(0, 6)}…{p.address.slice(-4)}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-xs text-muted-foreground">
                        {p.supplyTokens.length > 0 && (
                          <div>
                            <span className="text-[9px] uppercase">supply: </span>
                            {p.supplyTokens
                              .slice(0, 3)
                              .map((t) =>
                                `${fmtAmount(t.amount)} ${t.symbol}`,
                              )
                              .join(" + ")}
                            {p.supplyTokens.length > 3 &&
                              ` + ${p.supplyTokens.length - 3} more`}
                          </div>
                        )}
                        {p.debtTokens.length > 0 && (
                          <div className="text-destructive/70">
                            <span className="text-[9px] uppercase">borrow: </span>
                            {p.debtTokens
                              .map((t) => `${fmtAmount(t.amount)} ${t.symbol}`)
                              .join(" + ")}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums font-medium">
                        {formatUsd(p.assetUsd, locale)}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums text-destructive">
                        {p.debtUsd > 0 ? formatUsd(p.debtUsd, locale) : "—"}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">
                        <span
                          className={
                            p.netUsd >= 0 ? "text-foreground" : "text-destructive"
                          }
                        >
                          {formatUsd(p.netUsd, locale)}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function KpiCard({
  label,
  value,
  tone,
}: {
  readonly label: string;
  readonly value: string;
  readonly tone: "default" | "success" | "destructive" | "muted";
}): JSX.Element {
  const valueClass =
    tone === "success"
      ? "text-success"
      : tone === "destructive"
        ? "text-destructive"
        : tone === "muted"
          ? "text-muted-foreground"
          : "text-foreground";
  return (
    <div className="rounded-lg border border-border bg-card/50 p-4">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div
        className={`mt-2 text-2xl font-semibold tabular-nums tracking-tight ${valueClass}`}
      >
        {value}
      </div>
    </div>
  );
}

function SortableTh({
  label,
  field,
  sortField,
  sortDir,
  onClick,
}: {
  readonly label: string;
  readonly field: SortField;
  readonly sortField: SortField;
  readonly sortDir: SortDir;
  readonly onClick: () => void;
}): JSX.Element {
  const active = sortField === field;
  return (
    <th className="px-4 py-3 font-medium text-right">
      <button
        type="button"
        onClick={onClick}
        className="inline-flex items-center gap-1 hover:text-foreground"
      >
        {label}
        <ArrowDownUp
          className={`h-3 w-3 ${active ? "text-brand-cyan" : "text-muted-foreground/50"} ${active && sortDir === "asc" ? "rotate-180" : ""}`}
        />
      </button>
    </th>
  );
}

function fmtAmount(n: number): string {
  if (n === 0) return "0";
  if (Math.abs(n) >= 1000) return n.toFixed(0);
  if (Math.abs(n) >= 1) return n.toFixed(2);
  return n.toFixed(4);
}
