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

type GoldenMap = Record<string, { label: string; expectedStartUsd: number; drift: boolean }>;

function GoldenCell({ g }: { g: { label: string; expectedStartUsd: number; drift: boolean } | undefined }): JSX.Element {
  if (!g) return <span className="text-muted-foreground">—</span>;
  return g.drift ? (
    <span className="rounded bg-destructive/15 px-1.5 py-0.5 text-xs text-destructive" title={g.label}>
      ⚠ дрейф (эталон {usd(g.expectedStartUsd)})
    </span>
  ) : (
    <span className="rounded bg-success/15 px-1.5 py-0.5 text-xs text-success" title={g.label}>
      ✓ {usd(g.expectedStartUsd)}
    </span>
  );
}

function PositionsTable({ positions, golden }: { positions: UcbPosition[]; golden?: GoldenMap }): JSX.Element {
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-sm">
        <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
          <tr>
            {["#", "Протокол", "Сеть", "Активы", "NFT", "startUsd", "Сейчас", "PnL", "PnL %", "Fees", "Эталон", ""].map(
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
                  <GoldenCell g={p.id ? golden?.[p.id] : undefined} />
                </td>
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

      {compute.data?.accounts.map((acc) => {
        const goldenCount = acc.golden ? Object.keys(acc.golden).length : 0;
        const driftCount = acc.golden ? Object.values(acc.golden).filter((g) => g.drift).length : 0;
        const errors = (acc.findings ?? []).filter((f) => f.severity === "error");
        return (
          <div key={acc.accountId} className="mb-8">
            <div className="mb-2 flex flex-wrap items-center gap-2 text-sm">
              <span className="font-medium">{acc.label}</span>
              <span className="text-muted-foreground">· {acc.positionCount} позиций · {compute.data!.methodology}</span>
              {goldenCount > 0 && (
                <span className={`rounded px-1.5 py-0.5 text-xs ${driftCount > 0 ? "bg-destructive/15 text-destructive" : "bg-success/15 text-success"}`}>
                  эталонов: {goldenCount}{driftCount > 0 ? ` · дрейф: ${driftCount}` : " · все сходятся ✓"}
                </span>
              )}
            </div>
            {acc.error ? (
              <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                Ошибка расчёта: {acc.error}
              </p>
            ) : acc.positions.length === 0 ? (
              <p className="text-sm text-muted-foreground">Позиций нет (нет EVM-кошельков / live-данных?).</p>
            ) : (
              <>
                <PositionsTable positions={acc.positions} {...(acc.golden && { golden: acc.golden })} />
                {(acc.findings ?? []).length > 0 && (
                  <div className="mt-3">
                    <div className="mb-1 text-xs font-medium text-muted-foreground">
                      Детектор аномалий: {acc.findings!.length} находок{errors.length > 0 ? ` (${errors.length} error)` : ""}
                    </div>
                    <div className="space-y-1">
                      {acc.findings!.map((f, i) => (
                        <div key={i} className="flex items-start gap-2 text-xs">
                          <span className={`rounded px-1.5 py-0.5 ${f.severity === "error" ? "bg-destructive/15 text-destructive" : f.severity === "warn" ? "bg-amber-500/15 text-amber-600" : "bg-muted text-muted-foreground"}`}>
                            {f.severity}
                          </span>
                          <span className="font-mono">{f.checkId}</span>
                          <span className="text-muted-foreground">{f.reason}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
