import { useState } from "react";

import { Button } from "@/components/ui/button";
import { useUcbCompute } from "@/features/admin/ucb-server/hooks";
import type { Methodology, UcbPosition } from "@/features/admin/ucb-server/api";
import { useAdminPortfolios } from "@/features/admin/portfolios/hooks";

import { PageHeader } from "./_PageHeader";

const METHODOLOGIES: Methodology[] = ["FIFO", "LIFO", "WAC", "HIFO"];

function usd(n: number | null | undefined): string {
  if (n == null) return "—";
  return `$${(Math.round(n * 100) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function PositionsTable({ positions }: { positions: UcbPosition[] }): JSX.Element {
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-sm">
        <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
          <tr>
            {["#", "Протокол", "Сеть", "Активы", "NFT", "startUsd", "Сейчас", "PnL", "PnL %", "Fees", ""].map(
              (h) => (
                <th key={h} className="px-3 py-2 font-medium">
                  {h}
                </th>
              ),
            )}
          </tr>
        </thead>
        <tbody>
          {positions.map((p, i) => {
            const sym = (p.supplyTokens ?? []).map((t) => t.symbol).join("+");
            const pnlNeg = (p.netPnlUsd ?? 0) < 0;
            return (
              <tr key={p.id ?? i} className="border-t border-border/60 hover:bg-muted/30">
                <td className="px-3 py-2 text-muted-foreground">{i + 1}</td>
                <td className="px-3 py-2">{p.protocol?.id ?? p.protocol?.name ?? "—"}</td>
                <td className="px-3 py-2">{p.chain ?? "—"}</td>
                <td className="px-3 py-2">{sym || "—"}</td>
                <td className="px-3 py-2 font-mono text-xs">{p.matchedV3TokenId ?? "—"}</td>
                <td className="px-3 py-2 font-medium">{usd(p.startUsd)}</td>
                <td className="px-3 py-2">{usd(p.currentUsd)}</td>
                <td className={`px-3 py-2 ${pnlNeg ? "text-destructive" : p.netPnlUsd ? "text-success" : ""}`}>
                  {usd(p.netPnlUsd)}
                </td>
                <td className="px-3 py-2">{p.netPnlPct == null ? "—" : `${p.netPnlPct.toFixed(1)}%`}</td>
                <td className="px-3 py-2">{usd(p.feesUsd)}</td>
                <td className="px-3 py-2">
                  {p.coverageIncomplete ? (
                    <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-xs text-amber-600">⚠ неполно</span>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function AdminUcbServerPage(): JSX.Element {
  const [account, setAccount] = useState("");
  const [methodology, setMethodology] = useState<Methodology>("FIFO");
  const compute = useUcbCompute();
  const accounts = useAdminPortfolios();

  // Sort by owner email for a scannable dropdown.
  const options = (accounts.data ?? [])
    .slice()
    .sort((a, b) => (a.ownerEmail ?? "").localeCompare(b.ownerEmail ?? ""));

  const run = () => {
    if (account) compute.mutate({ account, methodology });
  };

  return (
    <div>
      <PageHeader
        title="UCB Server"
        description="Серверный расчёт позиций (cost basis / PnL / fees) для любого аккаунта или email. Тот же движок, что увидит юзер после флипа — для сверки с клиентским UI перед мёржем."
      />

      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground">Аккаунт</label>
          <select
            value={account}
            onChange={(e) => setAccount(e.target.value)}
            disabled={accounts.isLoading}
            className="w-96 rounded-md border border-border bg-background px-3 py-1.5 text-sm"
          >
            <option value="">
              {accounts.isLoading ? "Загрузка аккаунтов…" : "— выберите аккаунт —"}
            </option>
            {options.map((a) => (
              <option key={a.accountId} value={a.accountId}>
                {(a.ownerEmail ?? a.ownerName ?? "—") + " · " + a.accountName + " · " + a.accountId.slice(0, 8)}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground">Методология</label>
          <select
            value={methodology}
            onChange={(e) => setMethodology(e.target.value as Methodology)}
            className="rounded-md border border-border bg-background px-3 py-1.5 text-sm"
          >
            {METHODOLOGIES.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </div>
        <Button onClick={run} disabled={compute.isPending || !account}>
          {compute.isPending ? "Считаю… (live-фетч, до ~1–2 мин)" : "Рассчитать"}
        </Button>
      </div>

      <p className="mb-4 text-xs text-muted-foreground">
        Методология должна совпадать с выбранной у юзера (дефолт FIFO; после персиста сервер берёт её сам). На
        лету идут live-фетчи DeBank / Etherscan / Alchemy — это медленно.
      </p>

      {compute.isError && (
        <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {(compute.error as Error).message}
        </p>
      )}

      {compute.data?.notFound && (
        <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-600">
          Аккаунт/пользователь не найден.
        </p>
      )}

      {compute.data?.accounts.map((acc) => (
        <div key={acc.accountId} className="mb-6">
          <div className="mb-2 flex items-center gap-2 text-sm">
            <span className="font-medium">{acc.label}</span>
            <span className="text-muted-foreground">· {acc.positionCount} позиций · {compute.data!.methodology}</span>
          </div>
          {acc.error ? (
            <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              Ошибка расчёта: {acc.error}
            </p>
          ) : acc.positions.length === 0 ? (
            <p className="text-sm text-muted-foreground">Позиций нет (нет EVM-кошельков / live-данных?).</p>
          ) : (
            <PositionsTable positions={acc.positions} />
          )}
        </div>
      ))}
    </div>
  );
}
