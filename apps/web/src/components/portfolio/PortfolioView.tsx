import {
  Banknote,
  Coins,
  Database,
  HandCoins,
  PiggyBank,
  Wallet,
  Layers,
} from "lucide-react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useI18n, useT } from "@/i18n/I18nProvider";
import { formatNumber, formatUsd } from "@/i18n/format";
import type { PortfolioSnapshot } from "@/lib/portfolio/types";
import type { OpType } from "@/lib/portfolio/types";
import { cn } from "@/lib/utils";

interface PortfolioViewProps {
  snapshot: PortfolioSnapshot;
}

const OP_TYPE_LABEL: Record<OpType, { en: string; ru: string }> = {
  deposit_fiat:   { en: "Deposit from CEX",   ru: "Завод с биржи" },
  withdraw_fiat:  { en: "Withdraw to CEX",    ru: "Вывод на биржу" },
  transfer_in:    { en: "Transfer in",        ru: "Перевод на" },
  transfer_out:   { en: "Transfer out",       ru: "Перевод с" },
  swap:           { en: "Swap",               ru: "Обмен" },
  lend_supply:    { en: "Supply",             ru: "Внесено в lending" },
  lend_withdraw:  { en: "Withdraw",           ru: "Вывод из lending" },
  borrow:         { en: "Borrow",             ru: "Заём" },
  repay:          { en: "Repay",              ru: "Погашение" },
  lp_add:         { en: "LP add",             ru: "Добавление LP" },
  lp_remove:      { en: "LP remove",          ru: "Вывод LP" },
  stake:          { en: "Stake",              ru: "Стейкинг" },
  unstake:        { en: "Unstake",            ru: "Расстейк" },
  claim_rewards:  { en: "Claim",              ru: "Клейм наград" },
  perp_open:      { en: "Perp open",          ru: "Открытие перпа" },
  perp_close:     { en: "Perp close",         ru: "Закрытие перпа" },
  bridge_in:      { en: "Bridge in",          ru: "Мост входящий" },
  bridge_out:     { en: "Bridge out",         ru: "Мост исходящий" },
  approve:        { en: "Approve",            ru: "Approve" },
  failed:         { en: "Failed",             ru: "Неудачные" },
  gas_topup:      { en: "Gas top-up",         ru: "Пополнение газа" },
  unknown:        { en: "Other",              ru: "Прочее" },
};

export function PortfolioView({ snapshot }: PortfolioViewProps) {
  const t = useT();
  const { locale } = useI18n();

  return (
    <div className="space-y-6">
      {/* Стартовый капитал */}
      <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <BigStat
          icon={<Banknote />}
          label={t("portfolio.startingCapital")}
          value={formatUsd(snapshot.startingCapitalUsd, locale)}
          hint={t("portfolio.startingCapital.hint")}
          accent="brand"
        />
        <BigStat
          icon={<HandCoins />}
          label={t("portfolio.withdrawn")}
          value={formatUsd(snapshot.withdrawnUsd, locale)}
        />
        <BigStat
          icon={<PiggyBank />}
          label={t("portfolio.netInvested")}
          value={formatUsd(snapshot.netInvestedUsd, locale)}
        />
        <BigStat
          icon={<Database />}
          label={t("portfolio.gas")}
          value={formatUsd(snapshot.totalGasUsd, locale)}
        />
      </section>

      {/* Балансы кошелька */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Wallet className="h-4 w-4 text-brand-cyan" />
            {t("portfolio.walletBalances.title")}
          </CardTitle>
          <CardDescription>{t("portfolio.walletBalances.sub")}</CardDescription>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          {snapshot.walletBalances.length === 0 ? (
            <Empty />
          ) : (
            <table className="w-full text-sm">
              <thead className="border-y border-border bg-secondary/40 text-xs uppercase tracking-wider text-muted-foreground">
                <tr>
                  <Th>{t("portfolio.col.token")}</Th>
                  <Th className="text-right">{t("portfolio.col.amount")}</Th>
                  <Th className="text-right">{t("portfolio.col.costBasis")}</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {snapshot.walletBalances.map((b) => (
                  <tr key={b.tokenId}>
                    <td className="px-4 py-2.5">
                      <span className="font-medium">{b.symbol}</span>
                      {b.isStable && (
                        <Badge variant="muted" className="ml-2 h-5 px-1.5 text-[10px]">
                          stable
                        </Badge>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums">
                      {formatNumber(b.amount, locale, 6)}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums">
                      {formatUsd(b.costBasisUsd, locale)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      {/* Lending */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Layers className="h-4 w-4 text-brand-cyan" />
            {t("portfolio.lending.title")}
          </CardTitle>
          <CardDescription>{t("portfolio.lending.sub")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {snapshot.lendingPositions.length === 0 ? (
            <Empty />
          ) : (
            snapshot.lendingPositions.map((p) => (
              <div
                key={`${p.protocol.id}-${p.chain}`}
                className="rounded-md border border-border bg-secondary/30 p-4"
              >
                <div className="flex items-center justify-between">
                  <div>
                    <div className="font-medium">{p.protocol.name}</div>
                    <div className="text-xs uppercase tracking-wider text-muted-foreground">
                      {p.chain}
                    </div>
                  </div>
                  <Badge variant="default">{p.protocol.category}</Badge>
                </div>
                <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <SubPos
                    title={t("portfolio.lending.supplied")}
                    rows={Object.entries(p.supplied)}
                    color="success"
                  />
                  <SubPos
                    title={t("portfolio.lending.borrowed")}
                    rows={Object.entries(p.borrowed)}
                    color="destructive"
                  />
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      {/* LP / Staking */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Coins className="h-4 w-4 text-brand-cyan" />
              {t("portfolio.lp.title")}
            </CardTitle>
            <CardDescription>{t("portfolio.lp.sub")}</CardDescription>
          </CardHeader>
          <CardContent>
            {snapshot.lpPositions.length === 0 ? (
              <Empty />
            ) : (
              <ul className="space-y-2">
                {snapshot.lpPositions.map((p) => (
                  <li
                    key={`${p.protocol.id}-${p.chain}`}
                    className="flex items-center justify-between rounded-md border border-border bg-secondary/30 px-3 py-2"
                  >
                    <div>
                      <div className="text-sm font-medium">{p.protocol.name}</div>
                      <div className="text-[11px] text-muted-foreground">
                        {p.chain.toUpperCase()} · {p.tokens.join(" / ")}
                      </div>
                    </div>
                    <span
                      className={cn(
                        "font-medium tabular-nums",
                        p.netUsd > 0 ? "text-foreground" : "text-muted-foreground",
                      )}
                    >
                      {formatUsd(p.netUsd, locale)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <PiggyBank className="h-4 w-4 text-brand-cyan" />
              {t("portfolio.staking.title")}
            </CardTitle>
            <CardDescription>{t("portfolio.staking.sub")}</CardDescription>
          </CardHeader>
          <CardContent>
            {snapshot.stakingPositions.length === 0 ? (
              <Empty />
            ) : (
              <ul className="space-y-2">
                {snapshot.stakingPositions.map((p) => (
                  <li
                    key={`${p.protocol.id}-${p.chain}-${p.symbol}`}
                    className="flex items-center justify-between rounded-md border border-border bg-secondary/30 px-3 py-2"
                  >
                    <div>
                      <div className="text-sm font-medium">
                        {p.symbol}{" "}
                        <span className="text-muted-foreground">· {p.protocol.name}</span>
                      </div>
                      <div className="text-[11px] text-muted-foreground">
                        {p.chain.toUpperCase()}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="font-medium tabular-nums">
                        {formatNumber(p.amount, locale, 6)}
                      </div>
                      <div className="text-[11px] text-muted-foreground tabular-nums">
                        {formatUsd(p.costUsd, locale)}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Сводка по типам */}
      <Card>
        <CardHeader>
          <CardTitle>{t("portfolio.opsByType.title")}</CardTitle>
          <CardDescription>{t("portfolio.opsByType.sub")}</CardDescription>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          <table className="w-full text-sm">
            <thead className="border-y border-border bg-secondary/40 text-xs uppercase tracking-wider text-muted-foreground">
              <tr>
                <Th>{t("portfolio.col.opType")}</Th>
                <Th className="text-right">{t("portfolio.col.count")}</Th>
                <Th className="text-right">{t("portfolio.col.netUsd")}</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {snapshot.opsByType.map((row) => (
                <tr key={row.type}>
                  <td className="px-4 py-2.5">{OP_TYPE_LABEL[row.type][locale]}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{row.count}</td>
                  <td
                    className={cn(
                      "px-4 py-2.5 text-right tabular-nums",
                      row.netUsd > 0
                        ? "text-success"
                        : row.netUsd < 0
                        ? "text-destructive"
                        : "text-muted-foreground",
                    )}
                  >
                    {formatUsd(row.netUsd, locale)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}

/* ----------------------------- helpers ------------------------------------ */

function Th({ children, className }: { children: React.ReactNode; className?: string }) {
  return <th className={cn("px-4 py-3 text-left font-medium", className)}>{children}</th>;
}

function BigStat({
  icon,
  label,
  value,
  hint,
  accent,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  hint?: string;
  accent?: "brand";
}) {
  return (
    <Card className={cn("relative overflow-hidden", accent === "brand" && "")}>
      {accent === "brand" && (
        <span className="pointer-events-none absolute -top-px left-6 right-6 h-px bg-brand-gradient" />
      )}
      <CardContent className="p-4">
        <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-muted-foreground">
          <span className="text-brand-cyan [&_svg]:h-4 [&_svg]:w-4">{icon}</span>
          {label}
        </div>
        <div className="mt-1 text-2xl font-semibold tracking-tight tabular-nums">
          {value}
        </div>
        {hint && <div className="text-[11px] text-muted-foreground">{hint}</div>}
      </CardContent>
    </Card>
  );
}

function SubPos({
  title,
  rows,
  color,
}: {
  title: string;
  rows: [string, { amount: number; usd: number }][];
  color: "success" | "destructive";
}) {
  const { locale } = useI18n();
  return (
    <div>
      <div className="mb-1 text-[11px] uppercase tracking-wider text-muted-foreground">
        {title}
      </div>
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">—</p>
      ) : (
        <ul className="space-y-1">
          {rows.map(([sym, v]) => (
            <li key={sym} className="flex items-center justify-between text-sm">
              <span className="font-medium">{sym}</span>
              <span className="text-right">
                <div className="tabular-nums">{formatNumber(v.amount, locale, 6)}</div>
                <div
                  className={cn(
                    "text-[11px] tabular-nums",
                    color === "success" ? "text-success" : "text-destructive",
                  )}
                >
                  {formatUsd(v.usd, locale)}
                </div>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Empty() {
  const t = useT();
  return (
    <p className="px-4 py-6 text-center text-sm text-muted-foreground">
      {t("common.empty")}
    </p>
  );
}
