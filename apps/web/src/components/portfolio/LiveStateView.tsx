/**
 * Live-state view: «что у меня есть прямо сейчас».
 *
 * Чейн-нейтральный — рендерит уже унифицированный `LiveSnapshot`,
 * который заполняется и из DeBank (EVM), и из Helius+Jupiter (Solana).
 */

import { useState } from "react";
import {
  Coins,
  Info,
  Layers,
  PiggyBank,
  ShieldCheck,
  TrendingUp,
  Wallet,
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
import type { Loaded } from "@/components/data/LoadedWalletsProvider";
import type {
  LiveProtocolPosition,
  LiveTokenBalance,
} from "@/lib/portfolio/live";
import {
  buildPositionCostBasis,
  enrichPosition,
  type PositionEnrichment,
} from "@/lib/portfolio/position_pnl";
import {
  buildProtocolTokenSlots,
  findSlotsFor,
  type ProtocolTokenSlot,
} from "@/lib/ledger/protocol_pnl";
import { generateManualLedger } from "@/lib/ledger/generate";
import { cn } from "@/lib/utils";

interface LiveStateProps {
  loaded: Loaded[];
}

interface AggregatedToken {
  symbol: string;
  amount: number;
  usd: number;
  costBasisUsd: number;       // взвешенная сумма cost basis (по найденным позициям)
  costBasisCovered: number;   // сколько из usd покрыто cost basis (для PnL)
  chains: Set<string>;
  walletNames: Set<string>;
  isKnown: boolean;
}

interface AggregatedProtocol {
  protocolId: string;
  name: string;
  logo: string | null | undefined;
  chains: Set<string>;
  walletNames: Set<string>;
  net_usd: number;
  asset_usd: number;
  debt_usd: number;
  positions: LiveProtocolPosition[];
  enrichment: PositionEnrichment | null;
}

export function LiveStateView({ loaded }: LiveStateProps) {
  const t = useT();
  const { locale } = useI18n();

  const liveLoaded = loaded.filter((l) => l.live);
  const [hideUnknown, setHideUnknown] = useState(true);

  if (liveLoaded.length === 0) return null;

  const hasSolWallet = liveLoaded.some((l) => l.wallet.chain === "sol");

  // Cost-basis-индекс позиций: считаем из всей истории всех загруженных кошельков.
  const generated =
    loaded.length > 0
      ? generateManualLedger({
          loaded: loaded.map((l) => ({
            walletName: l.wallet.name,
            walletAddress: l.wallet.address,
            ops: l.ops,
          })),
        })
      : null;
  const costBasisIndex = generated
    ? buildPositionCostBasis(generated.manual)
    : new Map();
  // Per-protocol-per-token cost basis: для каждого supply-токена внутри позиции
  // знаем avg cost и сравниваем с текущей ценой.
  const protocolTokenSlots = generated
    ? buildProtocolTokenSlots(generated.manual)
    : new Map();

  /* ----------------------- агрегация всех кошельков ---------------------- */

  const rawTokens: LiveTokenBalance[] = liveLoaded.flatMap((l) => l.live!.tokens);
  const allTokens = hideUnknown
    ? rawTokens.filter((t) => t.isKnown || t.usd >= 5)
    : rawTokens;
  const hiddenSpamCount = rawTokens.length - allTokens.length;
  const allPositions: LiveProtocolPosition[] = liveLoaded.flatMap((l) => l.live!.positions);

  const totalUsd = liveLoaded.reduce((s, l) => s + l.live!.totalUsd, 0);
  const totalAssetUsd = allPositions.reduce((s, p) => s + p.assetUsd, 0);
  const totalDebtUsd = allPositions.reduce((s, p) => s + p.debtUsd, 0);
  const walletCashUsd = allTokens.reduce((s, t) => s + t.usd, 0);

  // Балансы — по символу+chain, чтобы EVM-USDC и Solana-USDC были раздельно.
  const tokenAgg = new Map<string, AggregatedToken>();
  for (const tk of allTokens) {
    const key = `${tk.symbol}@${tk.chain}`;
    const cur = tokenAgg.get(key) ?? {
      symbol: tk.symbol,
      amount: 0,
      usd: 0,
      costBasisUsd: 0,
      costBasisCovered: 0,
      chains: new Set<string>(),
      walletNames: new Set<string>(),
      isKnown: false,
    };
    cur.amount += tk.amount;
    cur.usd += tk.usd;
    if (tk.costBasisUsd != null) {
      cur.costBasisUsd += tk.costBasisUsd;
      cur.costBasisCovered += tk.usd;
    }
    cur.chains.add(tk.chain);
    cur.walletNames.add(tk.walletName);
    cur.isKnown = cur.isKnown || tk.isKnown;
    tokenAgg.set(key, cur);
  }
  const tokens = Array.from(tokenAgg.values()).sort((a, b) => b.usd - a.usd);
  const totalPnlUsd = tokens.reduce(
    (s, t) => s + (t.costBasisUsd > 0 ? t.usd - t.costBasisUsd : 0),
    0,
  );

  // Протоколы — по protocolId+chain.
  const protoAgg = new Map<string, AggregatedProtocol>();
  for (const p of allPositions) {
    const key = `${p.protocolId}@${p.chain}`;
    const cur = protoAgg.get(key) ?? {
      protocolId: p.protocolId,
      name: p.protocolName,
      logo: p.protocolLogo,
      chains: new Set<string>(),
      walletNames: new Set<string>(),
      net_usd: 0,
      asset_usd: 0,
      debt_usd: 0,
      positions: [],
      enrichment: null as PositionEnrichment | null,
    };
    cur.chains.add(p.chain);
    cur.walletNames.add(p.walletName);
    cur.net_usd += p.netUsd;
    cur.asset_usd += p.assetUsd;
    cur.debt_usd += p.debtUsd;
    cur.positions.push(p);
    if (!cur.enrichment) cur.enrichment = enrichPosition(p, costBasisIndex);
    protoAgg.set(key, cur);
  }
  const protocols = Array.from(protoAgg.values()).sort(
    (a, b) => b.net_usd - a.net_usd,
  );

  // Total PnL по позициям + наличным.
  const positionPnlUsd = protocols.reduce(
    (s, p) => s + (p.enrichment?.pnlUsd ?? 0),
    0,
  );
  const totalCapitalAtRisk = protocols.reduce(
    (s, p) => s + (p.enrichment?.costBasisOwnUsd ?? 0),
    0,
  );
  const totalBorrowedDeployed = protocols.reduce(
    (s, p) => s + (p.enrichment?.costBasisBorrowedUsd ?? 0),
    0,
  );

  return (
    <div className="space-y-6">
      {/* Hero */}
      <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat
          icon={<TrendingUp />}
          label={t("live.total")}
          value={formatUsd(totalUsd, locale)}
          accent
        />
        <Stat
          icon={<Wallet />}
          label={t("live.walletCash")}
          value={formatUsd(walletCashUsd, locale)}
          hint={`${tokens.length} ${t("live.tokens")}`}
        />
        <Stat
          icon={<Layers />}
          label={t("live.deployed")}
          value={formatUsd(totalAssetUsd, locale)}
          hint={`${protocols.length} ${t("live.protocols")}`}
        />
        <Stat
          icon={<ShieldCheck />}
          label={t("live.debt")}
          value={formatUsd(totalDebtUsd, locale)}
          hint={
            totalDebtUsd > 0 && totalAssetUsd > 0
              ? `LTV ${((totalDebtUsd / totalAssetUsd) * 100).toFixed(1)}%`
              : undefined
          }
          tone={totalDebtUsd > 0 ? "warn" : undefined}
        />
      </section>

      {/* Полный портфельный PnL: cash + позиции */}
      {(Math.abs(totalPnlUsd) > 0.5 || Math.abs(positionPnlUsd) > 0.5) && (
        <Card>
          <CardContent className="space-y-2 py-3 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">{t("live.totalPnl.cash")}</span>
              <span className={cn("font-medium tabular-nums", totalPnlUsd >= 0 ? "text-success" : "text-destructive")}>
                {totalPnlUsd >= 0 ? "+" : ""}{formatUsd(totalPnlUsd, locale)}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">{t("live.totalPnl.positions")}</span>
              <span className={cn("font-medium tabular-nums", positionPnlUsd >= 0 ? "text-success" : "text-destructive")}>
                {positionPnlUsd >= 0 ? "+" : ""}{formatUsd(positionPnlUsd, locale)}
              </span>
            </div>
            <div className="flex items-center justify-between border-t border-border pt-2">
              <span className="font-medium">{t("live.totalPnl.total")}</span>
              <span className={cn("font-bold tabular-nums", (totalPnlUsd + positionPnlUsd) >= 0 ? "text-success" : "text-destructive")}>
                {(totalPnlUsd + positionPnlUsd) >= 0 ? "+" : ""}
                {formatUsd(totalPnlUsd + positionPnlUsd, locale)}
              </span>
            </div>
            {totalBorrowedDeployed > 0 && (
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>{t("live.totalPnl.deployed")}</span>
                <span>
                  {t("live.totalPnl.own")} {formatUsd(totalCapitalAtRisk, locale)} ·{" "}
                  <span className="text-warning">
                    {t("live.totalPnl.borrowed")} {formatUsd(totalBorrowedDeployed, locale)}
                  </span>
                </span>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Балансы кошельков */}
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Coins className="h-4 w-4 text-brand-cyan" />
              {t("live.balances.title")}
            </CardTitle>
            <CardDescription>{t("live.balances.sub")}</CardDescription>
          </div>
          <label className="flex items-center gap-2 text-xs text-muted-foreground whitespace-nowrap">
            <input
              type="checkbox"
              checked={hideUnknown}
              onChange={(e) => setHideUnknown(e.target.checked)}
            />
            {t("ledger.filters.hideUnknown")}
            {hideUnknown && hiddenSpamCount > 0 && (
              <span className="rounded bg-secondary px-1.5 py-0.5 font-mono">
                {hiddenSpamCount}
              </span>
            )}
          </label>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          {tokens.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-muted-foreground">—</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-y border-border bg-secondary/40 text-xs uppercase tracking-wider text-muted-foreground">
                  <tr>
                    <Th>{t("live.col.token")}</Th>
                    <Th>{t("live.col.chains")}</Th>
                    <Th className="text-right">{t("live.col.amount")}</Th>
                    <Th className="text-right">{t("live.col.costBasis")}</Th>
                    <Th className="text-right">{t("live.col.value")}</Th>
                    <Th className="text-right">{t("live.col.pnl")}</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {tokens.map((tok) => {
                    const pnl = tok.costBasisUsd > 0 ? tok.usd - tok.costBasisUsd : null;
                    const pnlPct =
                      tok.costBasisUsd > 0 ? (pnl! / tok.costBasisUsd) * 100 : null;
                    return (
                      <tr
                        key={`${tok.symbol}-${Array.from(tok.chains).join("-")}`}
                        className="hover:bg-accent/40"
                      >
                        <td className="px-4 py-2.5">
                          <div className="font-medium">{tok.symbol}</div>
                          <div className="text-[10px] text-muted-foreground">
                            {Array.from(tok.walletNames).join(", ")}
                          </div>
                        </td>
                        <td className="px-4 py-2.5"><ChainsList chains={tok.chains} /></td>
                        <td className="px-4 py-2.5 text-right tabular-nums">
                          {formatNumber(tok.amount, locale, 6)}
                        </td>
                        <td className="px-4 py-2.5 text-right tabular-nums">
                          {tok.costBasisUsd > 0 ? (
                            <>
                              <div>{formatUsd(tok.costBasisUsd, locale)}</div>
                              <div className="text-[10px] text-muted-foreground">
                                avg {formatUsd(tok.costBasisUsd / tok.amount, locale)}
                              </div>
                            </>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-right font-medium tabular-nums">
                          {formatUsd(tok.usd, locale)}
                        </td>
                        <td className="px-4 py-2.5 text-right tabular-nums">
                          {pnl != null && pnlPct != null ? (
                            <span className={pnl >= 0 ? "text-success" : "text-destructive"}>
                              {pnl >= 0 ? "+" : ""}
                              {formatUsd(pnl, locale)}
                              <span className="ml-1 text-[10px]">
                                ({pnlPct >= 0 ? "+" : ""}{pnlPct.toFixed(2)}%)
                              </span>
                            </span>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Открытые позиции */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <PiggyBank className="h-4 w-4 text-brand-cyan" />
            {t("live.positions.title")}
          </CardTitle>
          <CardDescription>{t("live.positions.sub")}</CardDescription>
          {/* Диагностика источников: какие API использовались. */}
          <div className="mt-2 flex flex-wrap gap-2 text-[10px]">
            {liveLoaded.flatMap((l) =>
              (l.live!.sources ?? []).map((s, i) => (
                <span
                  key={`${l.wallet.id}-${i}-${s.name}`}
                  className={cn(
                    "inline-flex items-center gap-1 rounded border px-1.5 py-0.5",
                    s.ok
                      ? "border-success/40 bg-success/10 text-success"
                      : "border-warning/40 bg-warning/10 text-muted-foreground",
                  )}
                  title={s.error ?? ""}
                >
                  {s.ok ? "✓" : "○"} {l.wallet.name} · {s.name}
                  {s.positions != null && s.ok && ` · ${s.positions}p`}
                  {s.tokens != null && s.ok && ` · ${s.tokens}t`}
                  {s.error && ` · ${s.error}`}
                </span>
              )),
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {protocols.length === 0 ? (
            <p className="text-sm text-muted-foreground">—</p>
          ) : (
            protocols.map((p) => (
              <ProtocolBlock
                key={`${p.protocolId}-${Array.from(p.chains).join("-")}`}
                agg={p}
                tokenSlots={findSlotsFor(p.name, Array.from(p.chains)[0] ?? "", protocolTokenSlots)}
              />
            ))
          )}
          {hasSolWallet && (
            <div className="rounded-md border border-border bg-secondary/30 p-3 text-xs text-muted-foreground">
              <div className="flex items-start gap-2">
                <Info className="h-4 w-4 shrink-0 text-brand-cyan" />
                <div>
                  <span className="font-medium text-foreground">Solana DeFi:</span>{" "}
                  если позиция Flash Trade / Drift / Kamino не видна — добавьте
                  ключ Vybe Network в Settings → Integrations. Без него видны
                  только LST/JLP-токены, которые лежат в кошельке.
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function ChainsList({ chains }: { chains: Set<string> }) {
  return (
    <div className="flex flex-wrap gap-1">
      {Array.from(chains).map((c) => (
        <Badge
          key={c}
          variant="outline"
          className={cn("uppercase text-[10px]", c === "sol" && "text-[#14F195]")}
        >
          {c}
        </Badge>
      ))}
    </div>
  );
}

function ProtocolBlock({
  agg,
  tokenSlots,
}: {
  agg: AggregatedProtocol;
  tokenSlots: Map<string, ProtocolTokenSlot> | null;
}) {
  const t = useT();
  const { locale } = useI18n();
  const enr = agg.enrichment;
  return (
    <div className="rounded-md border border-border bg-secondary/30 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          {agg.logo ? (
            <img
              src={agg.logo}
              alt={agg.name}
              width={28}
              height={28}
              className="rounded-full bg-secondary"
            />
          ) : (
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-brand-gradient text-[10px] font-bold text-background">
              {agg.name.slice(0, 2).toUpperCase()}
            </span>
          )}
          <div>
            <div className="flex items-center gap-2 font-semibold">
              {agg.name}
              {enr && enr.borrowedShare > 0 && (
                <Badge variant="warning" className="text-[10px]">
                  {enr.borrowedShare === 1
                    ? t("live.fundsTag.borrowed")
                    : `${Math.round(enr.borrowedShare * 100)}% ${t("live.fundsTag.borrowed")}`}
                  {enr.borrowSource ? ` · ${enr.borrowSource}` : ""}
                </Badge>
              )}
            </div>
            <div className="text-[11px] text-muted-foreground flex flex-wrap gap-1">
              {Array.from(agg.chains).map((c) => (
                <Badge
                  key={c}
                  variant="muted"
                  className={cn("uppercase text-[10px]", c === "sol" && "text-[#14F195]")}
                >
                  {c}
                </Badge>
              ))}
              <span className="text-muted-foreground">
                · {Array.from(agg.walletNames).join(", ")}
              </span>
            </div>
          </div>
        </div>
        <div className="text-right">
          <div className="text-lg font-semibold tabular-nums">
            {formatUsd(agg.net_usd, locale)}
          </div>
          {agg.debt_usd > 0 && (
            <div className="text-[11px] text-muted-foreground">
              {t("live.position.assets")} {formatUsd(agg.asset_usd, locale)} · {t("live.position.debt")}{" "}
              <span className="text-destructive">{formatUsd(agg.debt_usd, locale)}</span>
            </div>
          )}
          {enr && enr.costBasisTotalUsd > 0 && (
            <div className="mt-1 text-xs">
              <span className="text-muted-foreground">{t("live.position.cost")} </span>
              <span className="tabular-nums">{formatUsd(enr.costBasisOwnUsd, locale)}</span>
              {enr.costBasisBorrowedUsd > 0 && (
                <span className="text-warning"> + {formatUsd(enr.costBasisBorrowedUsd, locale)} {t("live.fundsTag.borrowed").toLowerCase()}</span>
              )}
              <span className="text-muted-foreground"> · </span>
              <span
                className={cn(
                  "font-medium tabular-nums",
                  enr.pnlUsd >= 0 ? "text-success" : "text-destructive",
                )}
              >
                {enr.pnlUsd >= 0 ? "+" : ""}{formatUsd(enr.pnlUsd, locale)}
                <span className="ml-1 text-[10px]">
                  ({enr.pnlPct >= 0 ? "+" : ""}{enr.pnlPct.toFixed(1)}%)
                </span>
              </span>
            </div>
          )}
        </div>
      </div>

      <div className="mt-3 space-y-3">
        {agg.positions.map((p, i) => (
          <PositionDetail
            key={`${p.walletId}-${p.itemName}-${i}`}
            pos={p}
            tokenSlots={tokenSlots}
          />
        ))}
      </div>
    </div>
  );
}

function PositionDetail({
  pos,
  tokenSlots,
}: {
  pos: LiveProtocolPosition;
  tokenSlots: Map<string, ProtocolTokenSlot> | null;
}) {
  const t = useT();
  const { locale } = useI18n();
  return (
    <div className="rounded border border-border bg-background/40 p-3 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Badge variant="default" className="text-[10px]">{pos.itemName}</Badge>
          <Badge variant="muted" className="text-[10px]">{pos.walletName}</Badge>
          <Badge variant="outline" className={cn("uppercase text-[10px]", pos.chain === "sol" && "text-[#14F195]")}>
            {pos.chain}
          </Badge>
          {pos.healthRate != null && (
            <Badge
              variant={pos.healthRate < 1.5 ? "warning" : "success"}
              className="text-[10px]"
            >
              Health {pos.healthRate.toFixed(2)}
            </Badge>
          )}
        </div>
        <div className="font-semibold tabular-nums">
          {formatUsd(pos.netUsd, locale)}
        </div>
      </div>

      <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
        {pos.supply.length > 0 && (
          <TokenList
            title={t("live.item.supply")}
            lines={pos.supply}
            color="success"
            tokenSlots={tokenSlots}
          />
        )}
        {pos.borrow.length > 0 && (
          <TokenList title={t("live.item.borrow")} lines={pos.borrow} color="destructive" />
        )}
        {pos.rewards.length > 0 && (
          <TokenList title={t("live.item.rewards")} lines={pos.rewards} color="success" />
        )}
      </div>
    </div>
  );
}

function TokenList({
  title,
  lines,
  color,
  tokenSlots,
}: {
  title: string;
  lines: { symbol: string; amount: number; usd: number }[];
  color: "success" | "destructive";
  tokenSlots?: Map<string, ProtocolTokenSlot> | null;
}) {
  const { locale } = useI18n();
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{title}</div>
      <ul className="mt-1 space-y-1.5">
        {lines.map((l, i) => {
          const currentPricePerUnit = l.amount > 0 ? l.usd / l.amount : 0;
          const slot = tokenSlots?.get(l.symbol) ?? null;
          // Cost basis блок показываем только для supply (не для borrow/rewards)
          // и только если у нас есть данные cost basis по этому токену.
          const showCost =
            color === "success" &&
            slot != null &&
            slot.amount > 1e-9 &&
            slot.avgCost > 0;
          let pnlUsd = 0;
          let pnlPct = 0;
          if (showCost) {
            // PnL = текущая стоимость − cost basis (на остаток в позиции)
            pnlUsd = l.amount * (currentPricePerUnit - slot!.avgCost);
            pnlPct = slot!.avgCost > 0
              ? ((currentPricePerUnit - slot!.avgCost) / slot!.avgCost) * 100
              : 0;
          }
          return (
            <li key={`${l.symbol}-${i}`} className="flex items-start justify-between gap-2">
              <div className="flex flex-col">
                <span className="font-medium">{l.symbol}</span>
                {showCost && (
                  <span className="text-[10px] text-muted-foreground tabular-nums">
                    avg ${slot!.avgCost.toFixed(2)} · now ${currentPricePerUnit.toFixed(2)}
                  </span>
                )}
              </div>
              <span className="text-right">
                <span className="block tabular-nums">{formatNumber(l.amount, locale, 6)}</span>
                <span
                  className={cn(
                    "block text-[10px] tabular-nums",
                    color === "success" ? "text-success" : "text-destructive",
                  )}
                >
                  {formatUsd(l.usd, locale)}
                </span>
                {showCost && (
                  <span
                    className={cn(
                      "block text-[10px] tabular-nums font-medium",
                      pnlUsd >= 0 ? "text-success" : "text-destructive",
                    )}
                    title={`Cost basis: ${formatUsd(slot!.costUsd, locale)} · Avg: $${slot!.avgCost.toFixed(2)}/${l.symbol}`}
                  >
                    {pnlUsd >= 0 ? "+" : ""}
                    {formatUsd(pnlUsd, locale)} ({pnlPct >= 0 ? "+" : ""}{pnlPct.toFixed(1)}%)
                  </span>
                )}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Stat({
  icon,
  label,
  value,
  hint,
  accent,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  hint?: string | undefined;
  accent?: boolean | undefined;
  tone?: "warn" | undefined;
}) {
  return (
    <Card className="relative overflow-hidden">
      {accent && (
        <span className="pointer-events-none absolute -top-px left-6 right-6 h-px bg-brand-gradient" />
      )}
      <CardContent className="p-4">
        <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-muted-foreground">
          <span className={cn("text-brand-cyan [&_svg]:h-4 [&_svg]:w-4", tone === "warn" && "text-warning")}>
            {icon}
          </span>
          {label}
        </div>
        <div className="mt-1 text-2xl font-semibold tracking-tight tabular-nums">{value}</div>
        {hint && <div className="text-[11px] text-muted-foreground">{hint}</div>}
      </CardContent>
    </Card>
  );
}

function Th({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <th className={cn("px-4 py-3 text-left font-medium", className)}>{children}</th>;
}
