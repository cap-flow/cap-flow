import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useActiveAccount } from "@/features/accounts/hooks";
import {
  importItemsSchema,
  type ImportItem,
  type Operation,
  type OperationsListFilter,
} from "@/features/operations/api";
import {
  useImportOperations,
  useOperations,
  useOperationStats,
} from "@/features/operations/hooks";
import { useI18n, useT } from "@/i18n/I18nProvider";
import { formatNumber } from "@/i18n/format";
import { cn } from "@/lib/utils";

const IMPORT_EXAMPLE: ImportItem[] = [
  {
    legacyId: "example-1",
    date: "2026-01-15",
    type: "buy",
    cur1: "ETH",
    amount1: "1.0",
    cur2: "USDC",
    amount2: "2400",
    fromName: "Binance",
    toName: "Wallet",
    network: "ethereum",
    comment: "Sample buy",
  },
  {
    legacyId: "example-2",
    date: "2026-02-10",
    type: "swap",
    cur1: "USDC",
    amount1: "500",
    cur2: "SOL",
    amount2: "3.2",
    network: "solana",
  },
];

export function OperationsPage(): JSX.Element {
  const t = useT();
  const primary = useActiveAccount();

  if (primary === undefined) {
    return (
      <div className="p-4 text-sm text-muted-foreground">
        {t("common.loading")}
      </div>
    );
  }
  if (primary === null) {
    return (
      <div className="p-4 text-sm text-muted-foreground">
        У вас ещё нет аккаунта.
      </div>
    );
  }
  return <OperationsContent accountId={primary.id} />;
}

function OperationsContent({
  accountId,
}: {
  readonly accountId: string;
}): JSX.Element {
  const t = useT();
  const { locale } = useI18n();

  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [importOpen, setImportOpen] = useState(false);

  const filter: OperationsListFilter = {
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    limit: 500,
  };

  const ops = useOperations(accountId, filter);
  const stats = useOperationStats(accountId);

  const lastUpdated = stats.data?.lastUpdatedAt
    ? new Date(stats.data.lastUpdatedAt).toLocaleString(
        locale === "ru" ? "ru-RU" : "en-US"
      )
    : t("operations.stats.never");

  return (
    <div className="mx-auto max-w-7xl space-y-6 p-4">
      <header className="flex items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {t("operations.title")}
          </h1>
          <p className="text-sm text-muted-foreground">
            {t("operations.subtitle")}
          </p>
        </div>
        <Button
          variant={importOpen ? "outline" : "default"}
          onClick={() => setImportOpen((v) => !v)}
        >
          {importOpen ? t("operations.import.close") : t("operations.import.toggle")}
        </Button>
      </header>

      {importOpen && (
        <ImportPanel accountId={accountId} onClose={() => setImportOpen(false)} />
      )}

      <section className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Card>
          <CardContent className="p-4">
            <div className="text-xs uppercase tracking-wider text-muted-foreground">
              {t("operations.stats.count")}
            </div>
            <div className="mt-1 text-2xl font-semibold tabular-nums">
              {stats.data ? formatNumber(stats.data.count, locale, 0) : "—"}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-xs uppercase tracking-wider text-muted-foreground">
              {t("operations.stats.lastUpdated")}
            </div>
            <div className="mt-1 text-sm font-medium">{lastUpdated}</div>
          </CardContent>
        </Card>
      </section>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {t("operations.title")} ({ops.data?.length ?? 0})
          </CardTitle>
          <CardDescription>
            <div className="flex flex-wrap items-end gap-3 pt-2">
              <div>
                <Label htmlFor="op-from" className="text-xs">
                  {t("operations.filter.from")}
                </Label>
                <Input
                  id="op-from"
                  type="date"
                  value={from}
                  onChange={(e) => setFrom(e.target.value)}
                  className="h-8 w-40"
                />
              </div>
              <div>
                <Label htmlFor="op-to" className="text-xs">
                  {t("operations.filter.to")}
                </Label>
                <Input
                  id="op-to"
                  type="date"
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                  className="h-8 w-40"
                />
              </div>
              {(from || to) && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setFrom("");
                    setTo("");
                  }}
                >
                  {t("operations.filter.reset")}
                </Button>
              )}
            </div>
          </CardDescription>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          {ops.isLoading ? (
            <p className="px-4 py-8 text-sm text-muted-foreground">
              {t("common.loading")}
            </p>
          ) : ops.isError ? (
            <p className="px-4 py-8 text-sm text-destructive">
              {t("operations.error")}
            </p>
          ) : !ops.data || ops.data.length === 0 ? (
            <div className="px-4 py-12 text-center">
              <div className="text-base font-semibold">
                {t("operations.empty.title")}
              </div>
              <p className="mt-1 text-sm text-muted-foreground">
                {t("operations.empty.sub")}
              </p>
            </div>
          ) : (
            <OperationsTable operations={ops.data} />
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function ImportPanel({
  accountId,
  onClose,
}: {
  readonly accountId: string;
  readonly onClose: () => void;
}): JSX.Element {
  const t = useT();
  const importMut = useImportOperations(accountId);

  const [text, setText] = useState("");
  const [parseError, setParseError] = useState<string | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    inserted: number;
    updated: number;
    total: number;
  } | null>(null);

  function loadExample(): void {
    setText(JSON.stringify(IMPORT_EXAMPLE, null, 2));
    setParseError(null);
    setValidationError(null);
    setResult(null);
  }

  async function onSubmit(): Promise<void> {
    setParseError(null);
    setValidationError(null);
    setResult(null);

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      setParseError((err as Error).message);
      return;
    }

    const check = importItemsSchema.safeParse(parsed);
    if (!check.success) {
      const first = check.error.issues[0];
      const path = first?.path.join(".") || "(root)";
      setValidationError(`${path}: ${first?.message ?? "invalid"}`);
      return;
    }

    try {
      const r = await importMut.mutateAsync(check.data);
      setResult(r);
    } catch (err) {
      setValidationError(err instanceof Error ? err.message : String(err));
    }
  }

  const busy = importMut.isPending;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("operations.import.title")}</CardTitle>
        <CardDescription>{t("operations.import.hint")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={12}
          spellCheck={false}
          disabled={busy}
          placeholder={`[\n  { "legacyId": "...", "date": "2026-01-01", "type": "buy", ... }\n]`}
          className={cn(
            "w-full rounded-md border border-input bg-background px-3 py-2",
            "font-mono text-xs leading-relaxed text-foreground",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            "disabled:opacity-50"
          )}
        />

        {parseError && (
          <p className="text-xs text-destructive">
            <strong>{t("operations.import.errorParse")}</strong> {parseError}
          </p>
        )}
        {validationError && (
          <p className="text-xs text-destructive">
            <strong>{t("operations.import.errorValidation")}</strong>{" "}
            {validationError}
          </p>
        )}
        {result && (
          <p className="text-xs text-success">
            {t(
              "operations.import.success",
              result.inserted,
              result.updated,
              result.total
            )}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            onClick={() => void onSubmit()}
            disabled={busy || !text.trim()}
          >
            {busy
              ? t("operations.import.submitting")
              : t("operations.import.submit")}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={loadExample}
            disabled={busy}
          >
            {t("operations.import.example")}
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={onClose}
            disabled={busy}
          >
            {t("operations.import.close")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

const TYPE_VARIANT: Record<
  Operation["type"],
  Parameters<typeof Badge>[0]["variant"]
> = {
  buy: "default",
  sell: "muted",
  swap: "default",
  transfer: "outline",
  deposit: "default",
  withdraw: "muted",
  fee: "muted",
  open: "default",
  close: "muted",
  loan: "warning",
  loan_take: "warning",
  loan_repay: "muted",
  div: "success",
  other: "outline",
};

function OperationsTable({
  operations,
}: {
  readonly operations: Operation[];
}): JSX.Element {
  const t = useT();
  const { locale } = useI18n();

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="border-b border-border bg-secondary/40 text-xs uppercase tracking-wider text-muted-foreground">
          <tr>
            <Th className="w-28">{t("ledger.col.date")}</Th>
            <Th className="w-28">{t("ledger.col.type")}</Th>
            <Th className="w-32">{t("ledger.col.from")}</Th>
            <Th className="w-32">{t("ledger.col.to")}</Th>
            <Th>{t("operations.col.amount")}</Th>
            <Th className="w-32">{t("operations.col.value")}</Th>
            <Th className="w-24">{t("ledger.col.network")}</Th>
            <Th>{t("ledger.col.comment")}</Th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {operations.map((op) => (
            <tr key={op.id} className="hover:bg-accent/40">
              <td className="px-3 py-2 tabular-nums text-muted-foreground">
                {op.date}
              </td>
              <td className="px-3 py-2">
                <Badge variant={TYPE_VARIANT[op.type]}>{op.type}</Badge>
              </td>
              <td className="px-3 py-2 text-muted-foreground">
                {op.fromName ?? "—"}
              </td>
              <td className="px-3 py-2 text-muted-foreground">
                {op.toName ?? "—"}
              </td>
              <td className="px-3 py-2 text-xs">
                {op.amount1 && op.cur1 && (
                  <div className="tabular-nums">
                    {formatNumber(Number(op.amount1), locale, 6)} {op.cur1}
                  </div>
                )}
                {op.amount2 && op.cur2 && (
                  <div className="text-muted-foreground tabular-nums">
                    → {formatNumber(Number(op.amount2), locale, 6)} {op.cur2}
                  </div>
                )}
              </td>
              <td className="px-3 py-2 text-xs tabular-nums text-muted-foreground">
                {op.priceUsd
                  ? `$${formatNumber(Number(op.priceUsd), locale, 2)}`
                  : "—"}
              </td>
              <td className="px-3 py-2 text-xs text-muted-foreground">
                {op.network ?? "—"}
              </td>
              <td className="max-w-[320px] truncate px-3 py-2 text-xs text-muted-foreground">
                {op.comment || "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Th({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <th className={cn("px-3 py-3 text-left font-medium", className)}>
      {children}
    </th>
  );
}
