import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownRight,
  ArrowUpRight,
  Banknote,
  Coins,
  FileJson,
  Layers,
  PiggyBank,
  Receipt,
  RotateCw,
  Trash2,
  Upload,
} from "lucide-react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader2 } from "lucide-react";
import { useIntegrations } from "@/lib/integrations";
import { useI18n, useT } from "@/i18n/I18nProvider";
import { formatNumber, formatRub, formatUsd } from "@/i18n/format";
import { parseLedgerExport } from "@/lib/ledger/import";
import { useLedger } from "@/lib/ledger/store";
import { buildPositions, buildSummary } from "@/lib/ledger/positions";
import { generateManualLedger } from "@/lib/ledger/generate";
import {
  enrichOps,
  useOpAnnotations,
  type EnrichedOp,
} from "@/lib/ledger/annotations";
import { AnnotateOpButton } from "@/components/ledger/AnnotateOpButton";
import type {
  LedgerPosition,
  LedgerSummary,
  ManualOp,
} from "@/lib/ledger/types";
import { useLoadedWallets } from "@/components/data/LoadedWalletsProvider";
import { LiveStateView } from "@/components/portfolio/LiveStateView";
import { useWallets } from "@/lib/wallets";
import { cn } from "@/lib/utils";

type Tab = "positions" | "operations" | "summary";

export function LedgerPage(): JSX.Element {
  const t = useT();

  // Источник 1: данные из блокчейна (через провайдер)
  const { loadedById, loadAll, busyId, progress, error: loadError } = useLoadedWallets();
  const wallets = useWallets();
  const [integrations] = useIntegrations();
  const debankKey = integrations.debankAccessKey.trim();
  const heliusKey = integrations.heliusApiKey.trim();

  // Автозагрузка при заходе на страницу: если есть кошельки и ключи,
  // но ничего ещё не загружено — стартуем сразу.
  const autoTriggeredRef = useRef(false);
  useEffect(() => {
    if (autoTriggeredRef.current) return;
    if (busyId) return;
    if (wallets.list.length === 0) return;
    if (Object.keys(loadedById).length > 0) return;
    const hasAnyKey = wallets.list.some((w) =>
      w.chain === "sol" ? Boolean(heliusKey) : Boolean(debankKey),
    );
    if (!hasAnyKey) return;
    autoTriggeredRef.current = true;
    void loadAll();
  }, [wallets.list, loadedById, busyId, debankKey, heliusKey, loadAll]);

  // Источник 2: ручной импорт (опционально, для сверки)
  const [manualLedger, setManualLedger] = useLedger();

  const [tab, setTab] = useState<Tab>("positions");
  const [showSource, setShowSource] = useState<"auto" | "manual">("auto");
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  /* ------------------------- генерация авто-учёта ------------------------- */

  const [annotations] = useOpAnnotations();

  const generated = useMemo(() => {
    const loaded = Object.values(loadedById);
    if (loaded.length === 0) return null;
    const result = generateManualLedger({
      loaded: loaded.map((l) => ({
        walletName: l.wallet.name,
        walletAddress: l.wallet.address,
        ops: l.ops,
      })),
    });
    return {
      ...result,
      enriched: enrichOps(result.manual, result.hashByManualId, annotations),
    };
  }, [loadedById, wallets.list, annotations]);

  /* ------------------------- активный набор ------------------------------- */

  const activeOps = useMemo<ManualOp[]>(() => {
    if (showSource === "manual" && manualLedger) return manualLedger.operations;
    if (!generated) return [];
    // Фильтруем операции, помеченные пользователем как "скрыть из учёта".
    return generated.enriched.filter((op) => !op.annotation?.hidden);
  }, [showSource, manualLedger, generated]);

  const positions = useMemo(() => buildPositions(activeOps), [activeOps]);
  const summary = useMemo<LedgerSummary | null>(
    () => (activeOps.length ? buildSummary(activeOps, positions) : null),
    [activeOps, positions],
  );

  /* ------------------------- импорт ручного эталона ----------------------- */

  async function handleFile(file: File) {
    setError(null);
    try {
      const text = await file.text();
      const parsed = parseLedgerExport(JSON.parse(text));
      setManualLedger(parsed);
      setShowSource("manual");
    } catch (e) {
      setError((e as Error).message);
    }
  }

  function clearManual() {
    if (window.confirm("Удалить импортированный ручной учёт?")) {
      setManualLedger(null);
      setShowSource("auto");
    }
  }

  const loadedList = useMemo(() => Object.values(loadedById), [loadedById]);
  const hasLive = loadedList.some((l) => l.live);
  const noData = activeOps.length === 0 && !hasLive;

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{t("ledger.title")}</h1>
          <p className="text-sm text-muted-foreground">
            {showSource === "auto"
              ? t("ledger.generated.sub")
              : t("ledger.subtitle")}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {Object.keys(loadedById).length > 0 && (
            <Button
              variant="outline"
              onClick={() => loadAll()}
              disabled={Boolean(busyId)}
            >
              <RotateCw />
              {t("ledger.regenerate")}
            </Button>
          )}
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void handleFile(f);
              e.target.value = "";
            }}
          />
          <Button variant="ghost" onClick={() => fileRef.current?.click()}>
            <Upload />
            {manualLedger ? t("ledger.import.replace") : t("ledger.import.compare")}
          </Button>
          {manualLedger && (
            <Button variant="ghost" onClick={clearManual}>
              <Trash2 />
              {t("ledger.clear")}
            </Button>
          )}
        </div>
      </header>

      {error && (
        <Card>
          <CardContent className="py-4 text-sm text-destructive">{error}</CardContent>
        </Card>
      )}

      {/* Source toggle — показываем только когда есть оба источника */}
      {generated && manualLedger && (
        <div className="flex gap-1 rounded-md border border-border bg-secondary p-1 w-fit">
          <SourceBtn
            active={showSource === "auto"}
            onClick={() => setShowSource("auto")}
            label={`${t("ledger.source.auto")} (${generated.manual.length})`}
          />
          <SourceBtn
            active={showSource === "manual"}
            onClick={() => setShowSource("manual")}
            label={`${t("ledger.source.manual")} (${manualLedger.operations.length})`}
          />
        </div>
      )}

      {noData ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
            {busyId ? (
              <>
                <Loader2 className="h-10 w-10 animate-spin text-brand-cyan" />
                <div className="text-base font-semibold">{t("common.loading")}</div>
                <p className="text-sm text-muted-foreground">
                  {progress?.loaded ?? 0} ops · {progress?.pages ?? 0} pages
                </p>
              </>
            ) : (
              <>
                <FileJson className="h-10 w-10 text-muted-foreground" />
                <div className="text-base font-semibold">{t("ledger.empty.title")}</div>
                <p className="max-w-md text-sm text-muted-foreground">
                  {wallets.list.length === 0
                    ? t("ledger.empty.sub")
                    : t("ledger.noLoaded")}
                </p>
                {loadError && (
                  <p className="max-w-md text-xs text-destructive">{loadError}</p>
                )}
                {wallets.list.length > 0 && (
                  <Button onClick={() => void loadAll()} className="mt-2">
                    <RotateCw />
                    {t("ledger.regenerate")}
                  </Button>
                )}
              </>
            )}
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Live state — что прямо сейчас на кошельках и в DeFi */}
          {hasLive && <LiveStateView loaded={loadedList} />}

          {/* Verification banner для auto */}
          {showSource === "auto" && (
            <Card>
              <CardContent className="flex flex-wrap items-center justify-between gap-3 py-3 text-xs text-muted-foreground">
                <div className="flex items-center gap-2">
                  <Badge variant="default">{t("ledger.source.auto")}</Badge>
                  <span>
                    {t("ledger.generated.title")} ·{" "}
                    {Object.keys(loadedById).length} wallet(s) ·{" "}
                    {generated?.manual.length ?? 0} ops
                  </span>
                </div>
                <span>{t("ledger.generated.sub")}</span>
              </CardContent>
            </Card>
          )}

          {summary && <SummaryCards summary={summary} />}

          <div className="flex gap-1 rounded-md border border-border bg-secondary p-1 w-fit">
            <TabBtn active={tab === "positions"} onClick={() => setTab("positions")} icon={<Layers className="h-4 w-4" />} label={t("ledger.tab.positions")} />
            <TabBtn active={tab === "operations"} onClick={() => setTab("operations")} icon={<Receipt className="h-4 w-4" />} label={t("ledger.tab.operations")} />
            <TabBtn active={tab === "summary"} onClick={() => setTab("summary")} icon={<PiggyBank className="h-4 w-4" />} label={t("ledger.tab.summary")} />
          </div>

          {tab === "positions" && <PositionsList positions={positions} />}
          {tab === "operations" && <OperationsTable operations={activeOps} />}
          {tab === "summary" && summary && (
            <SummaryView summary={summary} ops={activeOps} />
          )}
        </>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function TabBtn({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "inline-flex items-center gap-2 rounded px-3 py-1.5 text-sm font-medium transition-colors",
        active
          ? "bg-background text-foreground shadow-sm"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {icon}
      {label}
    </button>
  );
}

function SourceBtn({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "rounded px-3 py-1.5 text-sm font-medium transition-colors",
        active
          ? "bg-background text-foreground shadow-sm"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {label}
    </button>
  );
}

function SummaryCards({ summary }: { summary: LedgerSummary }) {
  const t = useT();
  const { locale } = useI18n();
  return (
    <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <Stat icon={<Banknote />} label={t("ledger.summary.startCapitalRub")} value={summary.startingCapitalRub > 0 ? formatRub(summary.startingCapitalRub, locale) : "—"} />
      <Stat icon={<Coins />} label={t("ledger.summary.startCapitalUsdt")} value={`${formatNumber(summary.startingCapitalUsdt, locale, 2)} USDT`} />
      <Stat icon={<Banknote />} label={t("ledger.summary.avgRate")} value={summary.avgRubPerUsdt ? formatNumber(summary.avgRubPerUsdt, locale, 4) : "—"} />
      <Stat icon={<Layers />} label={t("ledger.summary.openPositions")} value={`${summary.openPositionsCount} / ${summary.positionsCount}`} hint={`${summary.closedPositionsCount} ${t("ledger.summary.closedPositions").toLowerCase()}`} />
    </section>
  );
}

function Stat({
  icon,
  label,
  value,
  hint,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <Card className="relative overflow-hidden">
      <span className="pointer-events-none absolute -top-px left-6 right-6 h-px bg-brand-gradient opacity-70" />
      <CardContent className="p-4">
        <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-muted-foreground">
          <span className="text-brand-cyan [&_svg]:h-4 [&_svg]:w-4">{icon}</span>
          {label}
        </div>
        <div className="mt-1 text-2xl font-semibold tracking-tight tabular-nums">{value}</div>
        {hint && <div className="text-[11px] text-muted-foreground">{hint}</div>}
      </CardContent>
    </Card>
  );
}

/* ------------------------------ Positions --------------------------------- */

function PositionsList({ positions }: { positions: LedgerPosition[] }) {
  if (positions.length === 0) {
    return (
      <Card>
        <CardContent className="py-12 text-center text-muted-foreground">—</CardContent>
      </Card>
    );
  }
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      {positions.map((p) => <PositionCard key={p.id} position={p} />)}
    </div>
  );
}

function PositionCard({ position }: { position: LedgerPosition }) {
  const t = useT();
  const { locale } = useI18n();

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={position.isOpen ? "default" : "muted"}>
              {position.isOpen ? t("ledger.position.open") : t("ledger.position.closed")}
            </Badge>
            <Badge variant="outline">{position.id}</Badge>
            {position.posType && <Badge variant="muted">{position.posType}</Badge>}
            {position.funds === "borrowed" && (
              <Badge variant="warning">{t("ledger.position.borrowed")}</Badge>
            )}
          </div>
          <CardTitle className="mt-2 text-base">
            {position.project} · {formatNumber(position.initialAmount, locale, 6)}{" "}
            {position.initialCurrency}
          </CardTitle>
          <CardDescription>
            {position.openOp.date}
            {position.network ? ` · ${position.network}` : ""}
            {position.initialUsd != null
              ? ` · ${formatUsd(position.initialUsd, locale)}`
              : ""}
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {position.posType === "Пул ликвидности" && position.openOp.lpVersion && (
          <div className="rounded-md border border-border bg-secondary/30 p-3 text-xs">
            <div className="font-medium">
              {position.openOp.lpVersion} · {position.openOp.lpPair}
            </div>
            {position.openOp.lpPriceLow != null && position.openOp.lpPriceHigh != null && (
              <div className="mt-1 text-muted-foreground">
                {t("ledger.position.lpRange")}:{" "}
                {formatNumber(position.openOp.lpPriceLow, locale, 2)} —{" "}
                {formatNumber(position.openOp.lpPriceHigh, locale, 2)}
                {position.openOp.lpFeeTier != null
                  ? ` · ${t("ledger.position.lpFee")} ${position.openOp.lpFeeTier}%`
                  : ""}
              </div>
            )}
          </div>
        )}

        {(position.totalBorrowedUsd > 0 || position.totalDividendsUsd > 0) && (
          <div className="grid grid-cols-2 gap-2 rounded-md border border-border bg-secondary/30 p-3 text-xs">
            {position.totalBorrowedUsd > 0 && (
              <div>
                <div className="text-muted-foreground">{t("ledger.position.totalBorrowed")}</div>
                <div className="font-medium tabular-nums">{formatUsd(position.totalBorrowedUsd, locale)}</div>
              </div>
            )}
            {position.totalDividendsUsd > 0 && (
              <div>
                <div className="text-muted-foreground">{t("ledger.position.totalDividends")}</div>
                <div className="font-medium text-success tabular-nums">+{formatUsd(position.totalDividendsUsd, locale)}</div>
              </div>
            )}
          </div>
        )}

        <Events position={position} />

        {position.closeOp && (
          <div className="rounded-md border border-border bg-secondary/30 p-3 text-xs">
            <div className="font-medium text-success">
              ✓ {t("ledger.position.closed")} · {position.closeOp.date}
            </div>
            {position.closeOp.closeTokenAmount != null && (
              <div className="mt-1 text-muted-foreground tabular-nums">
                ← {formatNumber(position.closeOp.closeTokenAmount, locale, 6)}{" "}
                {position.closeOp.closeCur2 ?? position.closeOp.cur1}
              </div>
            )}
            {position.closeOp.comment && (
              <div className="mt-1 text-muted-foreground">{position.closeOp.comment}</div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Events({ position }: { position: LedgerPosition }) {
  const t = useT();
  const { locale } = useI18n();

  const events: { time: string; node: React.ReactNode; key: string }[] = [];

  for (const op of position.loans) {
    events.push({
      time: op.date,
      key: op.id,
      node: (
        <span className="inline-flex items-center gap-2">
          <ArrowUpRight className="h-3 w-3 text-warning" />
          {t("ledger.position.loanTake")}{" "}
          <span className="font-medium tabular-nums">
            {formatNumber(op.amount1 ?? 0, locale, 4)} {op.cur1}
          </span>
          {op.loanLtv != null && (
            <span className="text-[10px] text-muted-foreground">LTV {op.loanLtv}%</span>
          )}
        </span>
      ),
    });
  }
  for (const op of position.loanReturns) {
    events.push({
      time: op.date,
      key: op.id,
      node: (
        <span className="inline-flex items-center gap-2">
          <ArrowDownRight className="h-3 w-3 text-success" />
          {t("ledger.position.loanReturn")}{" "}
          <span className="font-medium tabular-nums">
            {formatNumber(op.amount1 ?? 0, locale, 6)} {op.cur1}
          </span>
          <span className="text-[10px] text-muted-foreground">
            ({op.returnType === "collateral" ? t("ledger.position.collateral") : t("ledger.position.debt")})
          </span>
        </span>
      ),
    });
  }
  for (const op of position.dividends) {
    events.push({
      time: op.date,
      key: op.id,
      node: (
        <span className="inline-flex items-center gap-2">
          <PiggyBank className="h-3 w-3 text-success" />
          {t("ledger.position.dividend")}{" "}
          <span className="font-medium text-success tabular-nums">
            +{formatNumber(op.amount1 ?? 0, locale, 4)} {op.cur1}
          </span>
        </span>
      ),
    });
  }

  if (events.length === 0) return null;
  events.sort((a, b) => (a.time < b.time ? -1 : 1));

  return (
    <div>
      <div className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">
        {t("ledger.position.events")}
      </div>
      <ul className="space-y-1 text-xs">
        {events.map((e) => (
          <li key={e.key} className="flex items-center justify-between gap-2 rounded border border-border bg-secondary/20 px-2 py-1">
            {e.node}
            <span className="text-[10px] text-muted-foreground">{e.time}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ------------------------------ Operations -------------------------------- */

const OP_VARIANT: Record<ManualOp["type"], Parameters<typeof Badge>[0]["variant"]> = {
  buy: "default",
  open: "default",
  close: "muted",
  loan_take: "warning",
  loan_return: "muted",
  dividend: "success",
  fee: "muted",
  reinvest: "default",
  bridge: "default",
};

function OperationsTable({ operations }: { operations: ManualOp[] }) {
  const t = useT();
  const { locale } = useI18n();

  // Приводим к EnrichedOp, чтобы кнопка-аннотатор могла читать txHash.
  const rows = operations as EnrichedOp[];

  return (
    <Card>
      <CardContent className="px-0 pb-0">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-border bg-secondary/40 text-xs uppercase tracking-wider text-muted-foreground">
              <tr>
                <Th className="w-20">{t("ledger.col.id")}</Th>
                <Th className="w-28">{t("ledger.col.date")}</Th>
                <Th className="w-32">{t("ledger.col.type")}</Th>
                <Th className="w-32">{t("ledger.col.from")}</Th>
                <Th className="w-32">{t("ledger.col.to")}</Th>
                <Th>{t("ledger.col.movement")}</Th>
                <Th className="w-32">{t("ledger.col.posType")}</Th>
                <Th className="w-24">{t("ledger.col.funds")}</Th>
                <Th className="w-24">{t("ledger.col.network")}</Th>
                <Th>{t("ledger.col.comment")}</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((op) => (
                <tr key={op.id} className="hover:bg-accent/40">
                  <td className="px-3 py-2 font-mono text-xs">
                    <span className="font-medium">{op.id}</span>
                    {op.source === "auto" && (
                      <span className="ml-1 inline-block rounded bg-primary/10 px-1 text-[9px] uppercase text-primary">
                        auto
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground tabular-nums">{op.date}</td>
                  <td className="px-3 py-2">
                    <Badge variant={OP_VARIANT[op.type]}>{op.type}</Badge>
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">{op.from ?? "—"}</td>
                  <td className="px-3 py-2 text-muted-foreground">{op.to ?? "—"}</td>
                  <td className="px-3 py-2 text-xs">
                    {op.amount1 != null && op.cur1 && (
                      <div className="tabular-nums">
                        {formatNumber(op.amount1, locale, 6)} {op.cur1}
                      </div>
                    )}
                    {op.amount2 != null && op.cur2 && (
                      <div className="text-muted-foreground tabular-nums">
                        → {formatNumber(op.amount2, locale, 6)} {op.cur2}
                      </div>
                    )}
                    {op.price != null && op.type === "open" && (
                      <div className="text-[10px] text-muted-foreground">
                        ≈ {formatUsd(op.price, locale)}
                      </div>
                    )}
                    {op.avgPrice != null && op.type === "buy" && (
                      <div className="text-[10px] text-muted-foreground">
                        avg {formatNumber(op.avgPrice, locale, 4)}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">{op.posType ?? "—"}</td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">{op.funds ?? "—"}</td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">{op.network ?? "—"}</td>
                  <td className="px-3 py-2 text-xs text-muted-foreground max-w-[320px]">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate">
                        {op.comment || (op.loanPosId ? `→ ${op.loanPosId}` : op.returnPosId ? `← ${op.returnPosId}` : "")}
                      </span>
                      {op.source === "auto" && (
                        <AnnotateOpButton op={op} />
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

function Th({ children, className }: { children: React.ReactNode; className?: string }) {
  return <th className={cn("px-3 py-3 text-left font-medium", className)}>{children}</th>;
}

/* ------------------------------ Summary ----------------------------------- */

function SummaryView({
  summary,
  ops,
}: {
  summary: LedgerSummary;
  ops: ManualOp[];
}) {
  const t = useT();
  const { locale } = useI18n();

  const projects = Array.from(new Set(ops.map((o) => o.to).filter(Boolean))) as string[];
  const tokens = Array.from(new Set(ops.flatMap((o) => [o.cur1, o.cur2]).filter(Boolean))) as string[];

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>{t("ledger.summary.fees")}</CardTitle>
        </CardHeader>
        <CardContent>
          {Object.keys(summary.feesByNetwork).length === 0 ? (
            <p className="text-sm text-muted-foreground">—</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {Object.entries(summary.feesByNetwork).map(([net, amount]) => (
                <li key={net} className="flex items-center justify-between rounded border border-border bg-secondary/20 px-3 py-2">
                  <Badge variant="outline">{net}</Badge>
                  <span className="font-medium tabular-nums">{formatNumber(amount, locale, 6)}</span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Projects / Tokens</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div>
            <div className="mb-1 text-xs uppercase tracking-wider text-muted-foreground">Projects</div>
            <div className="flex flex-wrap gap-1">
              {projects.map((p) => <Badge key={p} variant="outline">{p}</Badge>)}
            </div>
          </div>
          <div>
            <div className="mb-1 text-xs uppercase tracking-wider text-muted-foreground">Tokens</div>
            <div className="flex flex-wrap gap-1">
              {tokens.map((tk) => <Badge key={tk} variant="default">{tk}</Badge>)}
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
