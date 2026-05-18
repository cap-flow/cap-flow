/**
 * CEX exchanges panel for the Registry page.
 *
 * Lets users connect API keys to Bybit / OKX / Bitget / MEXC. Surfaces
 * per-exchange "how to create a read-only key" instructions, lists
 * connected accounts with their last-sync status, and exposes a manual
 * "Sync now" button.
 *
 * Server contract (apps/api/src/modules/cex/*):
 *   - POST /v1/cex/        — connect (probes for read-perm, encrypts AES-GCM)
 *   - GET  /v1/cex/        — list active connections (no secrets)
 *   - DELETE /v1/cex/:id   — soft-delete (audit-logged)
 *   - POST /v1/cex/:id/sync — pull balance + new trades
 */

import { useState } from "react";
import {
  AlertCircle,
  ArrowDownToLine,
  ArrowUpFromLine,
  CheckCircle2,
  ChevronDown,
  FileUp,
  Info,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  Wallet,
  X,
} from "lucide-react";

import {
  EXCHANGES_REQUIRING_PASSPHRASE,
  SUPPORTED_EXCHANGES,
  type CexAccount,
  type CexPermissions,
  type ExchangeId,
  type PermStatus,
} from "@/features/cex/api";
import {
  useAnnotateP2pOrder,
  useCexAccounts,
  useCexP2pOrders,
  useCexTransfers,
  useConnectCex,
  useCreateManualP2pOrder,
  useDisconnectCex,
  useImportP2pCsv,
  useImportTradesCsv,
  useReProbeCex,
  useSyncCexAll,
  useSyncCexP2p,
  useSyncCexTransfers,
} from "@/features/cex/hooks";
import { useActiveAccount } from "@/features/accounts/hooks";
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
import { cn } from "@/lib/utils";

/**
 * Surface server-side ValidationError details. The api-client throws an
 * ApiError with `body = { error, message, issues: [...] }` for 400s
 * from Fastify-Zod. Without this helper the user only sees "Request
 * failed: 400 Bad Request" with no clue which field broke.
 */
function formatConnectError(err: unknown): string {
  const e = err as {
    message?: string;
    status?: number;
    body?: { message?: string; issues?: Array<{ path?: unknown[]; instancePath?: string; message?: string; keyword?: string }>; error?: string };
  };
  const body = e.body;
  if (body?.issues && body.issues.length > 0) {
    const parts = body.issues
      .map((iss) => {
        const path = iss.instancePath ?? (Array.isArray(iss.path) ? `/${iss.path.join("/")}` : "");
        return path
          ? `${path.replace(/^\//, "")} — ${iss.message ?? iss.keyword ?? "invalid"}`
          : iss.message ?? "invalid";
      })
      .join("; ");
    return `Проверьте поля: ${parts}`;
  }
  if (body?.message) return body.message;
  if (e.message) return e.message;
  return "Не удалось подключить ключ.";
}

const EXCHANGE_LABELS: Record<ExchangeId, string> = {
  bybit: "Bybit",
  okx: "OKX",
  bitget: "Bitget",
  mexc: "MEXC",
  bingx: "BingX",
};

/**
 * Per-exchange instructions for creating a *read-only* API key. We never
 * accept trade/withdraw keys (the server explicitly probes for `read` and
 * refuses if absent), but the UI still walks the user through making the
 * safest key — exchanges default to "read + trade" otherwise.
 */
const EXCHANGE_INSTRUCTIONS: Record<ExchangeId, string[]> = {
  bybit: [
    'Зайдите в Bybit → API Management → "Create New Key".',
    'System-generated → выберите "API Transaction" → Read-Only.',
    "В разрешениях: ✓ Read account info, ✓ Read trade history. Никаких write/withdraw/trade.",
    "Сохраните apiKey и secret. Capflow никогда не получит trade/withdraw — даже если случайно включили, мы откажем.",
  ],
  okx: [
    'OKX → Profile → API → "Create V5 API key".',
    "Permissions: ✓ Read только. Passphrase придумываете САМИ — она показана ОДИН раз.",
    "IP whitelist не нужен.",
    "Скопируйте apiKey, secret и passphrase — все три обязательны для OKX.",
  ],
  bitget: [
    "Bitget → API Management → Create API Key.",
    "Тип: System-generated. Permissions: только Read.",
    "Passphrase создаёте сами — Bitget использует её как третий параметр HMAC.",
    "Сохраните apiKey, secret и passphrase.",
  ],
  mexc: [
    'MEXC → Account → API Management → "Create API".',
    "Permissions: только Read Info.",
    "IP whitelist опционально.",
    "Сохраните apiKey и secret. Passphrase у MEXC нет.",
  ],
  bingx: [
    "BingX → Account → API Management → Create API Key.",
    "Permissions: только Read (НЕ включайте Trade / Withdraw).",
    "IP whitelist опционально.",
    "Сохраните apiKey и secret. Passphrase у BingX нет.",
  ],
};

export function CexExchangesPanel(): JSX.Element {
  const primary = useActiveAccount();
  const [formOpen, setFormOpen] = useState(false);
  const accountsQ = useCexAccounts();
  // UCB unified-bulk: одна кнопка "Синхронизировать все биржи" в header
  // запускает syncAll на каждый CEX account параллельно (Promise.all).
  // Отдельные per-account кнопки остаются — для targeted sync.
  const syncAllBulk = useSyncCexAll();
  const [bulkSyncing, setBulkSyncing] = useState(false);

  const accounts = accountsQ.data ?? [];
  const hasAny = accounts.length > 0;

  const syncAllAccounts = async () => {
    if (bulkSyncing || accounts.length === 0) return;
    setBulkSyncing(true);
    try {
      await Promise.allSettled(
        accounts.map((acc) => syncAllBulk.mutateAsync(acc.id)),
      );
    } finally {
      setBulkSyncing(false);
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div>
          <CardTitle className="flex items-center gap-2">
            <span className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-brand-cyan/15 text-[11px] font-bold text-brand-cyan">
              CEX
            </span>
            Биржи (API-ключи)
          </CardTitle>
          <CardDescription>
            Подключите Bybit, OKX, Bitget, MEXC через READ-ONLY ключ —
            Capflow подтянет балансы и историю сделок.
          </CardDescription>
        </div>
        <div className="flex items-center gap-2">
          {hasAny && (
            <Button
              variant="default"
              size="sm"
              onClick={syncAllAccounts}
              disabled={bulkSyncing}
              title={`Синхронизировать ВСЕ подключённые биржи (${accounts.length}) параллельно: баланс + сделки + переводы + внутренние переводы + P2P + ledger`}
            >
              {bulkSyncing ? (
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="mr-1 h-3.5 w-3.5" />
              )}
              {bulkSyncing
                ? `Синхронизация всех бирж…`
                : `Синхронизировать все (${accounts.length})`}
            </Button>
          )}
          <Button
            variant={formOpen ? "ghost" : "outline"}
            size="sm"
            onClick={() => setFormOpen((v) => !v)}
            disabled={!primary}
            aria-expanded={formOpen}
          >
            {formOpen ? (
              <>
                <ChevronDown className="rotate-180 transition-transform" />
                Скрыть
              </>
            ) : (
              <>
                <Plus />
                {hasAny ? "Добавить ещё" : "Подключить биржу"}
              </>
            )}
          </Button>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {!primary && (
          <p className="text-sm text-muted-foreground">
            Сначала выберите аккаунт.
          </p>
        )}

        {accountsQ.isLoading && (
          <p className="inline-flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Загрузка…
          </p>
        )}

        {hasAny && (
          <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {accounts.map((acc) => (
              <CexAccountCard key={acc.id} account={acc} />
            ))}
          </ul>
        )}

        <div
          className={cn(
            "grid transition-[grid-template-rows] duration-200 ease-out",
            formOpen ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
          )}
        >
          <div className="overflow-hidden">
            {formOpen && primary && (
              <ConnectExchangeForm
                accountId={primary.id}
                onDone={() => setFormOpen(false)}
              />
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

/* ─── UCB B1.4: PermissionsCard ─── */

const PERM_STATUS_LABEL: Record<PermStatus, { text: string; cls: string; icon: string }> = {
  ok:          { text: "✓ Доступ",          cls: "text-success",         icon: "✓" },
  denied:      { text: "✗ Запрещено",       cls: "text-destructive",     icon: "✗" },
  unsupported: { text: "— Не поддерживается", cls: "text-muted-foreground italic", icon: "—" },
  unknown:     { text: "? Не проверено",     cls: "text-muted-foreground", icon: "?" },
};

function PermissionsCard({
  account,
  exchangeLabel,
}: {
  readonly account: CexAccount;
  readonly exchangeLabel: string;
}) {
  const reprobe = useReProbeCex();
  const perms = (account.permissions ?? null) as CexPermissions | null;
  // Поля могут отсутствовать у старых аккаунтов, которые ещё не пере-probe'нуты
  // после миграции 0015. Дефолт 'unknown' даёт честный UI.
  const tradeHistory: PermStatus = perms?.tradeHistory ?? "unknown";
  const deposits: PermStatus = perms?.deposits ?? "unknown";
  const withdrawals: PermStatus = perms?.withdrawals ?? "unknown";

  const needsAttention =
    tradeHistory === "denied" || deposits === "denied" || withdrawals === "denied";

  return (
    <div
      className={cn(
        "mt-3 rounded-md border px-3 py-2 text-[11px]",
        needsAttention
          ? "border-warning/40 bg-warning/5"
          : "border-border/60 bg-secondary/20",
      )}
    >
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <div className="font-medium text-foreground">
          Sync coverage{" "}
          <span className="font-normal text-muted-foreground">
            (что API-key может читать)
          </span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-[10px]"
          onClick={() => reprobe.mutate(account.id)}
          disabled={reprobe.isPending}
          title="Re-probe permissions — после того как изменили права API-key на бирже"
        >
          {reprobe.isPending ? (
            <Loader2 className="mr-1 h-3 w-3 animate-spin" />
          ) : (
            <RefreshCw className="mr-1 h-3 w-3" />
          )}
          Re-probe
        </Button>
      </div>
      <ul className="grid grid-cols-3 gap-1.5">
        <PermissionLine label="Trades" status={tradeHistory} />
        <PermissionLine label="Deposits" status={deposits} />
        <PermissionLine label="Withdrawals" status={withdrawals} />
      </ul>
      {account.lastTradesSyncError && tradeHistory !== "ok" && (
        <p className="mt-2 text-[11px] text-warning">
          ⚠ {account.lastTradesSyncError}
        </p>
      )}
      {tradeHistory === "denied" && (
        <div className="mt-2 rounded border border-warning/40 bg-warning/10 px-2 py-1.5 text-[11px] leading-relaxed text-muted-foreground">
          <p className="mb-1 font-medium text-warning">
            Как починить trade history на {exchangeLabel}:
          </p>
          <ol className="ml-4 list-decimal space-y-0.5">
            <li>Откройте бирже → API Management → текущий ключ → Edit</li>
            <li>
              Включите чекбокс «Read Spot Trade History» (или аналогичный
              «Spot Trade» в read-only-режиме)
            </li>
            <li>Сохраните изменения на бирже</li>
            <li>
              Нажмите «Re-probe» выше — должно стать ✓ Доступ — затем
              «Синхронизировать»
            </li>
          </ol>
        </div>
      )}
      {reprobe.data && (
        <p className="mt-2 text-[11px] text-success">
          ✓ Permissions обновлены{" "}
          {reprobe.data.permissions?.lastProbedAt
            ? `(${new Date(reprobe.data.permissions.lastProbedAt).toLocaleTimeString()})`
            : ""}
        </p>
      )}
    </div>
  );
}

function PermissionLine({
  label,
  status,
}: {
  readonly label: string;
  readonly status: PermStatus;
}) {
  const meta = PERM_STATUS_LABEL[status];
  return (
    <li className="flex items-center justify-between gap-1 rounded border border-border/40 bg-card/40 px-1.5 py-1">
      <span className="text-muted-foreground">{label}</span>
      <span className={cn("tabular-nums", meta.cls)} title={meta.text}>
        {meta.icon}
      </span>
    </li>
  );
}

function CexAccountCard({ account }: { account: CexAccount }) {
  const syncAll = useSyncCexAll();
  const disconnect = useDisconnectCex();
  const exchangeId = account.exchange as ExchangeId;
  const label = EXCHANGE_LABELS[exchangeId] ?? account.exchange;
  const lastSync = account.lastSyncedAt
    ? new Date(account.lastSyncedAt).toLocaleString()
    : null;

  return (
    <li className="rounded-lg border border-border bg-card/60 p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate text-sm font-semibold">{label}</h3>
            {account.label && (
              <Badge variant="muted" className="text-[10px]">
                {account.label}
              </Badge>
            )}
          </div>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            {lastSync
              ? `Last sync: ${lastSync}`
              : "Ещё не синхронизировано"}
          </p>
          {account.lastSyncError && (
            <p className="mt-1 inline-flex items-start gap-1 text-[11px] text-destructive">
              <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
              <span className="line-clamp-2">{account.lastSyncError}</span>
            </p>
          )}
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 text-destructive hover:text-destructive"
          title="Отключить"
          onClick={() => {
            if (
              window.confirm(
                `Отключить ${label}? Сохранённые данные останутся в БД, но обновляться не будут.`,
              )
            ) {
              disconnect.mutate(account.id);
            }
          }}
          disabled={disconnect.isPending}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>

      <div className="mt-3 flex items-center justify-end gap-2">
        {/* UCB unified-sync UX: ОДНА кнопка дёргает ВСЁ за раз —
            balance + trades + transfers (deposits/withdrawals) + internal
            transfers (sub-accounts) + P2P + ledger (master record:
            interest, staking, rebates, funding rates). 6 sync endpoints
            chained с fail-soft semantics. */}
        <Button
          size="sm"
          onClick={() => syncAll.mutate(account.id)}
          disabled={syncAll.isPending}
          title="Полная синхронизация: баланс + сделки + переводы + внутренние переводы + P2P + ledger (interest/staking/rebates/funding). Все за один клик."
        >
          {syncAll.isPending ? (
            <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="mr-1 h-3.5 w-3.5" />
          )}
          {syncAll.isPending ? "Синхронизация…" : "Синхронизировать всё"}
        </Button>
      </div>
      {/* Unified sync result panel */}
      {syncAll.data && syncAll.variables === account.id && (
        <div className="mt-2 space-y-0.5 rounded-md border border-success/30 bg-success/5 px-2 py-1.5 text-[11px]">
          <div className="font-medium text-success">
            ✓ Синхронизация завершена
          </div>
          <div className="text-muted-foreground">
            • Баланс: {syncAll.data.main.balanceCount} активов
          </div>
          <div className="text-muted-foreground">
            • Сделки: +{syncAll.data.main.newTrades}
          </div>
          <div className="text-muted-foreground">
            • Депозиты/выводы: +{syncAll.data.transfers.newDeposits}/{" "}
            +{syncAll.data.transfers.newWithdrawals}
            {syncAll.data.transfers.error && (
              <span className="text-warning">
                {" "}· {syncAll.data.transfers.error}
              </span>
            )}
          </div>
          <div className="text-muted-foreground">
            • Внутренние переводы: +{syncAll.data.internal.newCount}
            {syncAll.data.internal.error && (
              <span className="text-warning opacity-70">
                {" "}· не поддерживается биржей
              </span>
            )}
          </div>
          <div className="text-muted-foreground">
            • P2P:{" "}
            {syncAll.data.p2p.supported ? (
              <>+{syncAll.data.p2p.newOrders}</>
            ) : (
              <span className="opacity-60">не поддерживается</span>
            )}
          </div>
          <div className="text-muted-foreground">
            • Ledger (interest/staking/rebates/funding): +
            {syncAll.data.ledger.newCount}
            {syncAll.data.ledger.error && (
              <span className="text-warning opacity-70">
                {" "}· {syncAll.data.ledger.error.slice(0, 40)}
              </span>
            )}
          </div>
        </div>
      )}

      {/* UCB B1.4: что API-key реально может читать на этой бирже. Для
          Bob @ bob@example.com BingX trade history будет 'denied' пока
          ключ не пере-issued с правильными permissions. */}
      <PermissionsCard account={account} exchangeLabel={label} />

      {/* UCB B6: импорт trade-history из выгруженного CSV/XLSX. Нужно
          когда biржа жёстко лимитит API lookback (Bybit 2 года, MEXC
          90 дней, и т.п.) — а в web-UI биржи можно скачать всю историю. */}
      <TradesCsvImporter accountId={account.id} exchangeLabel={label} />

      {/* tradesWarning surfaced through syncAll result (covers main /sync
          response). Standalone sync.data warning panel removed — old
          "quick refresh" button consolidated в Sync All. */}
      {syncAll.data?.main?.tradesWarning &&
        syncAll.variables === account.id && (
          <div className="mt-2 flex items-start gap-1 rounded-md border border-warning/40 bg-warning/10 px-2 py-1 text-[11px] text-warning">
            <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
            <span>{syncAll.data.main.tradesWarning}</span>
          </div>
        )}

      <CexP2pSubPanel accountId={account.id} exchange={exchangeId} />
      <CexTransfersSubPanel accountId={account.id} />
    </li>
  );
}

/**
 * Collapsible P2P sub-panel inside a CEX card. Lets the user:
 *   - pull P2P history (auto-sync — works only on exchanges where we
 *     have a real adapter, currently Bitget)
 *   - bulk-import CSV (Bitget export format; could extend to others)
 *   - manually add a P2P trade (universal — works for every exchange
 *     including ones without any public P2P API, e.g. BingX)
 *   - view stored orders (newest first, last 200)
 *
 * For exchanges without an auto-sync adapter (Bybit/OKX/MEXC/BingX),
 * the panel STILL works — the user can record their P2P trades by
 * hand and they participate in the cost-basis chain just like
 * API-synced rows.
 */
const P2P_SUPPORTED: ReadonlySet<ExchangeId> = new Set(["bitget"]);

const P2P_UNSUPPORTED_REASON: Partial<Record<ExchangeId, string>> = {
  bybit: "Bybit P2P API не реализован в Capflow (нужен отдельный HMAC-клиент).",
  okx: "OKX P2P API не реализован в Capflow (нужен отдельный HMAC-клиент).",
  mexc: "MEXC не публикует retail P2P API.",
  bingx: "BingX не публикует P2P API — записывайте сделки вручную.",
};

function CexP2pSubPanel({
  accountId,
  exchange,
}: {
  accountId: string;
  exchange: ExchangeId;
}) {
  const [open, setOpen] = useState(false);
  const [addingManual, setAddingManual] = useState(false);
  const supported = P2P_SUPPORTED.has(exchange);
  const sync = useSyncCexP2p();
  const orders = useCexP2pOrders(open ? accountId : null);

  return (
    <div className="mt-3 border-t border-border/60 pt-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between text-[11px] text-muted-foreground hover:text-foreground"
      >
        <span className="inline-flex items-center gap-1">
          <Wallet className="h-3 w-3" />
          P2P / Фиат
        </span>
        <ChevronDown
          className={cn(
            "h-3 w-3 transition-transform",
            open && "rotate-180",
          )}
        />
      </button>

      {open && (
        <div className="mt-2 space-y-2">
          {!supported && (
            <p className="rounded-md border border-warning/30 bg-warning/5 px-2 py-1 text-[11px] text-warning">
              ⓘ {P2P_UNSUPPORTED_REASON[exchange] ?? "Auto-sync недоступен для этой биржи."}{" "}
              Можно добавлять сделки вручную или импортировать CSV.
            </p>
          )}

          <div className="flex flex-wrap items-center gap-2">
            {supported && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => sync.mutate(accountId)}
                disabled={sync.isPending}
              >
                {sync.isPending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="h-3.5 w-3.5" />
                )}
                Подтянуть P2P-историю
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={() => setAddingManual(true)}
            >
              <Plus className="h-3.5 w-3.5" />
              Добавить вручную
            </Button>
          </div>

          {sync.data && supported && (
            <div
              className={cn(
                "inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px]",
                sync.data.ok
                  ? "border-success/40 bg-success/10 text-success"
                  : "border-destructive/40 bg-destructive/10 text-destructive",
              )}
            >
              {sync.data.ok ? (
                <>
                  <CheckCircle2 className="h-3 w-3" />
                  +{sync.data.newOrders} новых P2P-ордеров
                </>
              ) : (
                <>
                  <AlertCircle className="h-3 w-3" />
                  {sync.data.supported
                    ? sync.data.error ?? "Ошибка"
                    : "Биржа не поддерживается"}
                </>
              )}
            </div>
          )}

          <CexP2pCsvImporter accountId={accountId} />
          <CexP2pOrdersList
            accountId={accountId}
            rows={orders.data ?? []}
            loading={orders.isLoading}
          />

          {addingManual && (
            <P2pManualAddDialog
              accountId={accountId}
              onClose={() => setAddingManual(false)}
            />
          )}
        </div>
      )}
    </div>
  );
}

/* ───────────── manual add P2P dialog ───────────── */

function P2pManualAddDialog({
  accountId,
  onClose,
}: {
  accountId: string;
  onClose: () => void;
}) {
  const create = useCreateManualP2pOrder(accountId);
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [asset, setAsset] = useState("USDT");
  const [amount, setAmount] = useState("");
  const [fiatCurrency, setFiatCurrency] = useState("RUB");
  const [fiatAmount, setFiatAmount] = useState("");
  const [counterparty, setCounterparty] = useState("");
  const [paymentMethod, setPaymentMethod] = useState("");
  const [date, setDate] = useState(() => {
    // Default to "now" in local timezone, sliced to <input type="datetime-local"> format
    const d = new Date();
    const off = d.getTimezoneOffset() * 60_000;
    return new Date(d.getTime() - off).toISOString().slice(0, 16);
  });
  const [error, setError] = useState<string | null>(null);

  const amountN = parseFloat(amount);
  const fiatN = parseFloat(fiatAmount);
  const unit =
    Number.isFinite(amountN) && amountN > 0 && Number.isFinite(fiatN) && fiatN > 0
      ? fiatN / amountN
      : null;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!asset.trim() || !fiatCurrency.trim()) {
      setError("Укажите крипто-актив и фиатную валюту");
      return;
    }
    if (!Number.isFinite(amountN) || amountN <= 0) {
      setError("Количество крипты должно быть > 0");
      return;
    }
    if (!Number.isFinite(fiatN) || fiatN <= 0) {
      setError("Сумма фиата должна быть > 0");
      return;
    }
    const iso = new Date(date).toISOString();
    create.mutate(
      {
        side,
        asset: asset.trim().toUpperCase(),
        amount: amountN,
        fiatCurrency: fiatCurrency.trim().toUpperCase(),
        fiatAmount: fiatN,
        counterparty: counterparty.trim() || null,
        paymentMethod: paymentMethod.trim() || null,
        executedAt: iso,
      },
      {
        onSuccess: onClose,
        onError: (err) => setError((err as Error).message ?? "Не удалось сохранить"),
      },
    );
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-xl border border-border bg-card p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-start justify-between">
          <div>
            <h3 className="text-sm font-semibold">Добавить P2P-сделку вручную</h3>
            <p className="text-[11px] text-muted-foreground">
              Используйте если биржа не отдаёт P2P через API или вы хотите
              записать старую сделку.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <form onSubmit={submit} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label>Сторона</Label>
              <div className="flex gap-1">
                <button
                  type="button"
                  onClick={() => setSide("buy")}
                  className={cn(
                    "flex-1 rounded-md border px-2 py-1 text-xs transition-colors",
                    side === "buy"
                      ? "border-success/60 bg-success/10 text-success"
                      : "border-border bg-secondary text-muted-foreground hover:text-foreground",
                  )}
                >
                  buy (купил крипту)
                </button>
                <button
                  type="button"
                  onClick={() => setSide("sell")}
                  className={cn(
                    "flex-1 rounded-md border px-2 py-1 text-xs transition-colors",
                    side === "sell"
                      ? "border-destructive/60 bg-destructive/10 text-destructive"
                      : "border-border bg-secondary text-muted-foreground hover:text-foreground",
                  )}
                >
                  sell (продал крипту)
                </button>
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="m-date">Дата / время</Label>
              <Input
                id="m-date"
                type="datetime-local"
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="m-asset">Крипто</Label>
              <Input
                id="m-asset"
                value={asset}
                onChange={(e) => setAsset(e.target.value)}
                placeholder="USDT / BTC / ETH"
                autoComplete="off"
                className="font-mono uppercase"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="m-amount">Кол-во крипты</Label>
              <Input
                id="m-amount"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="100"
                inputMode="decimal"
                autoComplete="off"
                className="font-mono"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="m-fiat-cur">Фиат валюта</Label>
              <Input
                id="m-fiat-cur"
                value={fiatCurrency}
                onChange={(e) => setFiatCurrency(e.target.value)}
                placeholder="RUB / USD / VND"
                autoComplete="off"
                className="font-mono uppercase"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="m-fiat-amt">Сумма фиата</Label>
              <Input
                id="m-fiat-amt"
                value={fiatAmount}
                onChange={(e) => setFiatAmount(e.target.value)}
                placeholder="9550"
                inputMode="decimal"
                autoComplete="off"
                className="font-mono"
              />
            </div>
          </div>

          {unit != null && (
            <p className="text-[11px] text-muted-foreground">
              Курс: <span className="font-mono">{unit.toFixed(6)}</span>{" "}
              {fiatCurrency.toUpperCase()} за 1 {asset.toUpperCase()}
            </p>
          )}

          <div className="space-y-1">
            <Label htmlFor="m-cp">Контрагент (опц.)</Label>
            <Input
              id="m-cp"
              value={counterparty}
              onChange={(e) => setCounterparty(e.target.value)}
              placeholder="merchant name / nickname"
              autoComplete="off"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="m-pm">Способ оплаты (опц.)</Label>
            <Input
              id="m-pm"
              value={paymentMethod}
              onChange={(e) => setPaymentMethod(e.target.value)}
              placeholder="Sberbank / Tinkoff / Binance Pay"
              autoComplete="off"
            />
          </div>

          {error && <p className="text-[12px] text-destructive">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={onClose}>
              Отмена
            </Button>
            <Button type="submit" size="sm" disabled={create.isPending}>
              {create.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : null}
              Сохранить
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

interface P2pRowView {
  readonly id: string;
  readonly side: string;
  readonly asset: string;
  readonly amount: string;
  readonly fiatCurrency: string | null;
  readonly fiatAmount: string | null;
  readonly unitPrice: string | null;
  readonly counterparty: string | null;
  readonly paymentMethod: string | null;
  readonly status: string;
  readonly fiatSource: string;
  readonly executedAt: string;
  readonly mergedCount: number;
}

function CexP2pOrdersList({
  accountId,
  rows,
  loading,
}: {
  accountId: string;
  rows: ReadonlyArray<P2pRowView>;
  loading: boolean;
}) {
  const [editing, setEditing] = useState<P2pRowView | null>(null);
  if (loading) {
    return (
      <p className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" />
        Загрузка ордеров…
      </p>
    );
  }
  if (rows.length === 0) {
    return (
      <p className="text-[11px] text-muted-foreground">
        Нет P2P-ордеров. Нажмите «Подтянуть» — если у вас были P2P-сделки на
        Bitget, они появятся здесь.
      </p>
    );
  }
  return (
    <div className="space-y-1">
      <p className="text-[10px] text-muted-foreground">
        ⓘ Bitget retail API возвращает только криптовалютную часть P2P-сделок.
        Фиат можно заполнить вручную (кнопка ✏ на строке) или импортом
        CSV-выгрузки из Bitget (форма выше). Колонка <b>«Источник»</b>: api =
        пусто, manual = вручную, csv = из CSV.
      </p>
      <div className="overflow-x-auto rounded-md border border-border">
      <table className="w-full text-[11px]">
        <thead className="border-b border-border bg-secondary/40 text-[10px] uppercase tracking-wider text-muted-foreground">
          <tr>
            <th className="px-2 py-1 text-left font-medium">Дата</th>
            <th className="px-2 py-1 text-left font-medium">Сторона</th>
            <th className="px-2 py-1 text-left font-medium">Крипто</th>
            <th className="px-2 py-1 text-right font-medium">Кол-во</th>
            <th className="px-2 py-1 text-left font-medium">Фиат</th>
            <th className="px-2 py-1 text-right font-medium">Сумма</th>
            <th className="px-2 py-1 text-right font-medium">Курс</th>
            <th className="px-2 py-1 text-left font-medium">Метод</th>
            <th className="px-2 py-1 text-left font-medium">Источник</th>
            <th className="px-2 py-1 text-left font-medium">Статус</th>
            <th className="px-2 py-1 text-right font-medium">✏</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((r) => (
            <tr key={r.id}>
              <td className="px-2 py-1 whitespace-nowrap tabular-nums text-muted-foreground">
                {new Date(r.executedAt).toLocaleString()}
              </td>
              <td className="px-2 py-1">
                {r.side === "buy" ? (
                  <span className="inline-flex items-center gap-1 text-success">
                    <ArrowDownToLine className="h-3 w-3" /> buy
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 text-destructive">
                    <ArrowUpFromLine className="h-3 w-3" /> sell
                  </span>
                )}
              </td>
              <td className="px-2 py-1 font-mono uppercase">
                {r.asset}
                {r.mergedCount > 1 && (
                  <span
                    className="ml-1 rounded border border-border bg-secondary px-1 py-px text-[9px] normal-case text-muted-foreground"
                    title={`Bitget разбил эту сделку на ${r.mergedCount} строк журнала (escrow / fee / release). Мы свернули их в одну.`}
                  >
                    ×{r.mergedCount}
                  </span>
                )}
              </td>
              <td className="px-2 py-1 text-right tabular-nums">{r.amount}</td>
              <td className="px-2 py-1 font-mono uppercase text-muted-foreground">
                {r.fiatCurrency ?? "—"}
              </td>
              <td className="px-2 py-1 text-right tabular-nums text-muted-foreground">
                {r.fiatAmount ?? "—"}
              </td>
              <td className="px-2 py-1 text-right tabular-nums text-muted-foreground">
                {r.unitPrice ?? "—"}
              </td>
              <td className="px-2 py-1 text-muted-foreground">
                {r.paymentMethod ?? "—"}
              </td>
              <td className="px-2 py-1">
                <span
                  className={cn(
                    "rounded border px-1 py-px text-[9px] uppercase",
                    r.fiatSource === "manual"
                      ? "border-brand-cyan/40 bg-brand-cyan/10 text-brand-cyan"
                      : r.fiatSource === "csv"
                        ? "border-purple-500/40 bg-purple-500/10 text-purple-400"
                        : "border-border bg-secondary text-muted-foreground",
                  )}
                >
                  {r.fiatSource}
                </span>
              </td>
              <td className="px-2 py-1">
                <span
                  className={cn(
                    "rounded border px-1 py-px text-[10px] uppercase",
                    r.status === "completed"
                      ? "border-success/40 bg-success/10 text-success"
                      : r.status === "cancelled" || r.status === "appealed"
                        ? "border-destructive/40 bg-destructive/10 text-destructive"
                        : "border-border bg-secondary text-muted-foreground",
                  )}
                >
                  {r.status}
                </span>
              </td>
              <td className="px-2 py-1 text-right">
                <button
                  type="button"
                  onClick={() => setEditing(r)}
                  className="text-muted-foreground hover:text-brand-cyan"
                  title="Указать фиат"
                >
                  <Pencil className="h-3 w-3" />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
      {editing && (
        <P2pFiatDialog
          accountId={accountId}
          order={editing}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

/* ───────────── manual fiat dialog ───────────── */

function P2pFiatDialog({
  accountId,
  order,
  onClose,
}: {
  accountId: string;
  order: P2pRowView;
  onClose: () => void;
}) {
  const annotate = useAnnotateP2pOrder(accountId);
  const [fiatCurrency, setFiatCurrency] = useState(
    order.fiatCurrency ?? "RUB",
  );
  const [fiatAmount, setFiatAmount] = useState(order.fiatAmount ?? "");
  const [counterparty, setCounterparty] = useState(order.counterparty ?? "");
  const [paymentMethod, setPaymentMethod] = useState(
    order.paymentMethod ?? "",
  );
  const [error, setError] = useState<string | null>(null);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const amount = parseFloat(fiatAmount);
    if (!isFinite(amount) || amount <= 0) {
      setError("Сумма фиата должна быть > 0");
      return;
    }
    if (!fiatCurrency.trim()) {
      setError("Укажите валюту (RUB / USD / EUR / VND / …)");
      return;
    }
    annotate.mutate(
      {
        orderId: order.id,
        fiatCurrency: fiatCurrency.trim().toUpperCase(),
        fiatAmount: amount,
        counterparty: counterparty.trim() || null,
        paymentMethod: paymentMethod.trim() || null,
      },
      {
        onSuccess: () => onClose(),
        onError: (e) =>
          setError((e as Error).message ?? "Не удалось сохранить"),
      },
    );
  }

  // Crypto amount fixed; we compute unit price live.
  const cryptoAmount = parseFloat(order.amount);
  const unit =
    cryptoAmount > 0 && parseFloat(fiatAmount) > 0
      ? parseFloat(fiatAmount) / cryptoAmount
      : null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-xl border border-border bg-card p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-start justify-between">
          <div>
            <h3 className="text-sm font-semibold">Указать фиат</h3>
            <p className="text-[11px] text-muted-foreground">
              {order.side === "buy" ? "Покупка" : "Продажа"}{" "}
              <span className="font-mono">{order.amount} {order.asset}</span> ·{" "}
              {new Date(order.executedAt).toLocaleString()}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <form onSubmit={submit} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="fiat-currency">Валюта</Label>
              <Input
                id="fiat-currency"
                value={fiatCurrency}
                onChange={(e) => setFiatCurrency(e.target.value)}
                placeholder="RUB / USD / EUR / VND"
                autoComplete="off"
                spellCheck={false}
                className="font-mono uppercase"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="fiat-amount">Сумма фиата</Label>
              <Input
                id="fiat-amount"
                value={fiatAmount}
                onChange={(e) => setFiatAmount(e.target.value)}
                placeholder="9550"
                inputMode="decimal"
                autoComplete="off"
                className="font-mono"
              />
            </div>
          </div>
          {unit != null && (
            <p className="text-[11px] text-muted-foreground">
              Курс: <span className="font-mono">{unit.toFixed(6)}</span>{" "}
              {fiatCurrency.toUpperCase()} за 1 {order.asset}
            </p>
          )}
          <div className="space-y-1">
            <Label htmlFor="fiat-cp">Контрагент (опц.)</Label>
            <Input
              id="fiat-cp"
              value={counterparty}
              onChange={(e) => setCounterparty(e.target.value)}
              placeholder="merchant name / nickname"
              autoComplete="off"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="fiat-pm">Способ оплаты (опц.)</Label>
            <Input
              id="fiat-pm"
              value={paymentMethod}
              onChange={(e) => setPaymentMethod(e.target.value)}
              placeholder="Sberbank / Tinkoff / Binance Pay"
              autoComplete="off"
            />
          </div>
          {error && (
            <p className="text-[12px] text-destructive">{error}</p>
          )}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onClose}
            >
              Отмена
            </Button>
            <Button type="submit" size="sm" disabled={annotate.isPending}>
              {annotate.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : null}
              Сохранить
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

/* ───────────── CSV importer ───────────── */

/**
 * Bitget P2P CSV export columns we know about (header names vary by
 * locale). The parser is lenient — matches by lower-cased substring
 * so EN/RU exports both work.
 */
const BITGET_CSV_HEADER_HINTS: Record<keyof BitgetCsvRow, readonly string[]> = {
  orderId: ["order number", "order id", "номер ордера", "order no", "orderid"],
  side: ["order type", "side", "тип", "тип сделки"],
  asset: ["crypto", "coin", "криптовалют"],
  amount: ["crypto amount", "amount", "сумма крипто", "сумма (крипто)"],
  fiatCurrency: ["fiat", "fiat currency", "валюта", "currency"],
  fiatAmount: ["fiat amount", "total", "сумма фиат", "сумма (фиат)"],
  unitPrice: ["unit price", "price", "цена"],
  counterparty: ["counterparty", "merchant", "контрагент"],
  paymentMethod: ["payment method", "способ оплаты"],
};

interface BitgetCsvRow {
  orderId?: string;
  side?: string;
  asset?: string;
  amount?: string;
  fiatCurrency?: string;
  fiatAmount?: string;
  unitPrice?: string;
  counterparty?: string;
  paymentMethod?: string;
}

function parseBitgetCsv(text: string): {
  rows: Array<{
    orderId: string;
    fiatCurrency: string;
    fiatAmount: number;
    unitPrice?: number;
    counterparty?: string | null;
    paymentMethod?: string | null;
  }>;
  warnings: string[];
} {
  const warnings: string[] = [];
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) {
    return { rows: [], warnings: ["CSV пустой или только заголовок"] };
  }
  const headerCells = splitCsvLine(lines[0]!).map((h) =>
    h.toLowerCase().trim(),
  );
  // Map header → field by hint substring matching.
  const fieldIndex: Partial<Record<keyof BitgetCsvRow, number>> = {};
  for (const [field, hints] of Object.entries(BITGET_CSV_HEADER_HINTS) as [
    keyof BitgetCsvRow,
    readonly string[],
  ][]) {
    const idx = headerCells.findIndex((h) => hints.some((hint) => h.includes(hint)));
    if (idx >= 0) fieldIndex[field] = idx;
  }
  if (fieldIndex.orderId == null) {
    warnings.push("Не нашёл колонку с номером ордера");
  }
  if (fieldIndex.fiatAmount == null) {
    warnings.push("Не нашёл колонку с фиатной суммой");
  }
  if (fieldIndex.fiatCurrency == null) {
    warnings.push("Не нашёл колонку с фиатной валютой");
  }
  if (warnings.length > 0) return { rows: [], warnings };

  const rows: Array<{
    orderId: string;
    fiatCurrency: string;
    fiatAmount: number;
    unitPrice?: number;
    counterparty?: string | null;
    paymentMethod?: string | null;
  }> = [];
  let skipped = 0;
  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]!);
    const orderId = cells[fieldIndex.orderId!]?.trim();
    const fiatCurrency = cells[fieldIndex.fiatCurrency!]?.trim()?.toUpperCase();
    const fiatAmount = parseFloat(
      (cells[fieldIndex.fiatAmount!] ?? "").replace(/[^0-9.\-]/g, ""),
    );
    if (!orderId || !fiatCurrency || !isFinite(fiatAmount) || fiatAmount <= 0) {
      skipped++;
      continue;
    }
    const unitPriceRaw =
      fieldIndex.unitPrice != null ? cells[fieldIndex.unitPrice]?.trim() : "";
    const unitPrice = unitPriceRaw
      ? parseFloat(unitPriceRaw.replace(/[^0-9.\-]/g, ""))
      : NaN;
    const cp =
      fieldIndex.counterparty != null
        ? cells[fieldIndex.counterparty]?.trim() || null
        : null;
    const pm =
      fieldIndex.paymentMethod != null
        ? cells[fieldIndex.paymentMethod]?.trim() || null
        : null;
    rows.push({
      orderId,
      fiatCurrency,
      fiatAmount,
      ...(isFinite(unitPrice) && unitPrice > 0 ? { unitPrice } : {}),
      counterparty: cp,
      paymentMethod: pm,
    });
  }
  if (skipped > 0) {
    warnings.push(`Пропущено ${skipped} строк без orderId/валюты/суммы`);
  }
  return { rows, warnings };
}

/**
 * Lenient CSV split: handles double-quote-escaped fields and commas
 * inside quotes. Sufficient for Bitget's well-formed exports.
 */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (c === "," && !inQuotes) {
      out.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

/**
 * UCB B6: импорт spot-trade-history из CSV/XLSX-выгрузки биржи.
 * Поддерживает **множественный выбор файлов** — можно зараз скормить
 * частями (за разные годы или с разных pages биржи). Каждый файл
 * парсим отдельно (формат может отличаться), накапливаем результат.
 */
interface FileResult {
  readonly fileName: string;
  readonly source: string;
  readonly inserted: number;
  readonly skipped: number;
  readonly total: number;
  readonly error?: string;
}

function TradesCsvImporter({
  accountId,
  exchangeLabel,
}: {
  readonly accountId: string;
  readonly exchangeLabel: string;
}) {
  const importer = useImportTradesCsv(accountId);
  const [status, setStatus] = useState<
    | { kind: "idle" }
    | { kind: "processing"; currentFile: string; doneCount: number; totalFiles: number }
    | { kind: "done"; results: readonly FileResult[] }
  >({ kind: "idle" });

  async function onFiles(files: FileList) {
    const arr = Array.from(files);
    const results: FileResult[] = [];
    setStatus({
      kind: "processing",
      currentFile: arr[0]?.name ?? "",
      doneCount: 0,
      totalFiles: arr.length,
    });
    // Dynamic-import парсера один раз для всех файлов
    const { parseTradeImportFile } = await import(
      "@/features/cex/trade-import-parsers"
    );
    for (let i = 0; i < arr.length; i++) {
      const file = arr[i]!;
      setStatus({
        kind: "processing",
        currentFile: file.name,
        doneCount: i,
        totalFiles: arr.length,
      });
      try {
        const parsed = await parseTradeImportFile(file);
        if (parsed.error) {
          results.push({
            fileName: file.name,
            source: parsed.source,
            inserted: 0,
            skipped: 0,
            total: 0,
            error: parsed.error,
          });
          continue;
        }
        if (parsed.rows.length === 0) {
          results.push({
            fileName: file.name,
            source: parsed.source,
            inserted: 0,
            skipped: parsed.skipped,
            total: parsed.skipped,
            error: `0 строк (${parsed.source}). Возможно формат изменился.`,
          });
          continue;
        }
        const r = await importer.mutateAsync(parsed.rows);
        results.push({
          fileName: file.name,
          source: parsed.source,
          inserted: r.inserted,
          skipped: r.skipped + parsed.skipped,
          total: r.total + parsed.skipped,
        });
      } catch (e) {
        results.push({
          fileName: file.name,
          source: "unknown",
          inserted: 0,
          skipped: 0,
          total: 0,
          error: (e as Error).message,
        });
      }
    }
    setStatus({ kind: "done", results });
  }

  const totalInserted =
    status.kind === "done"
      ? status.results.reduce((s, r) => s + r.inserted, 0)
      : 0;
  const totalSkipped =
    status.kind === "done"
      ? status.results.reduce((s, r) => s + r.skipped, 0)
      : 0;

  return (
    <div className="mt-2 space-y-1 rounded-md border border-dashed border-brand-cyan/40 bg-brand-cyan/5 p-2 text-[11px]">
      <label className="flex cursor-pointer items-center gap-2 text-muted-foreground hover:text-foreground">
        <FileUp className="h-3.5 w-3.5" />
        <span>
          Импорт сделок CSV/XLSX из {exchangeLabel}{" "}
          <span className="text-[10px] opacity-70">
            (можно выбрать несколько файлов сразу — например за разные годы)
          </span>
        </span>
        <input
          type="file"
          multiple
          accept=".csv,.xlsx,.xls,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          className="hidden"
          onChange={(e) => {
            const files = e.target.files;
            if (files && files.length > 0) void onFiles(files);
            e.target.value = "";
          }}
        />
      </label>
      {status.kind === "processing" && (
        <p className="inline-flex items-center gap-1 text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          [{status.doneCount + 1}/{status.totalFiles}] парсим {status.currentFile}…
        </p>
      )}
      {status.kind === "done" && (
        <div className="space-y-0.5">
          <p className="font-medium text-success">
            ✓ Итого: {totalInserted} сделок импортировано из{" "}
            {status.results.length}{" "}
            {status.results.length === 1 ? "файла" : "файлов"}
            {totalSkipped > 0 && (
              <span className="text-warning"> · {totalSkipped} пропущено</span>
            )}
          </p>
          <ul className="ml-3 space-y-0.5">
            {status.results.map((r, idx) => (
              <li key={idx} className="font-mono text-[10px]">
                {r.error ? (
                  <span className="text-destructive">
                    ✗ {r.fileName}: {r.error}
                  </span>
                ) : (
                  <span className="text-muted-foreground">
                    ✓ {r.fileName} ({r.source}): +{r.inserted}
                    {r.skipped > 0 && `, ⚠ ${r.skipped} пропущено`}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function CexP2pCsvImporter({ accountId }: { accountId: string }) {
  const importer = useImportP2pCsv(accountId);
  const [status, setStatus] = useState<
    | { kind: "idle" }
    | { kind: "parsing"; fileName: string }
    | { kind: "ok"; matched: number; unmatched: number; total: number; warnings: string[] }
    | { kind: "error"; msg: string }
  >({ kind: "idle" });

  async function onFile(file: File) {
    setStatus({ kind: "parsing", fileName: file.name });
    try {
      const text = await file.text();
      const parsed = parseBitgetCsv(text);
      if (parsed.rows.length === 0) {
        setStatus({
          kind: "error",
          msg:
            parsed.warnings.join("; ") ||
            "Не нашёл подходящих строк в файле",
        });
        return;
      }
      const r = await importer.mutateAsync(parsed.rows);
      setStatus({
        kind: "ok",
        matched: r.matched,
        unmatched: r.unmatched,
        total: r.total,
        warnings: parsed.warnings,
      });
    } catch (e) {
      setStatus({ kind: "error", msg: (e as Error).message });
    }
  }

  return (
    <div className="space-y-1 rounded-md border border-dashed border-border bg-secondary/30 p-2 text-[11px]">
      <label className="flex cursor-pointer items-center gap-2 text-muted-foreground hover:text-foreground">
        <FileUp className="h-3.5 w-3.5" />
        <span>
          Импорт CSV из Bitget P2P (Order History → Export Excel/CSV)
        </span>
        <input
          type="file"
          accept=".csv,text/csv,application/vnd.ms-excel"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void onFile(f);
            e.target.value = ""; // reset so the same file can be re-uploaded
          }}
        />
      </label>
      {status.kind === "parsing" && (
        <p className="inline-flex items-center gap-1 text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          Парсим {status.fileName}…
        </p>
      )}
      {status.kind === "ok" && (
        <div className="space-y-0.5">
          <p className="text-success">
            ✓ Импортировано {status.matched} из {status.total} (
            {status.unmatched} не нашли соответствия в API-выгрузке)
          </p>
          {status.warnings.length > 0 && (
            <p className="text-warning">
              ⚠ {status.warnings.join("; ")}
            </p>
          )}
        </div>
      )}
      {status.kind === "error" && (
        <p className="text-destructive">⚠ {status.msg}</p>
      )}
    </div>
  );
}

function ConnectExchangeForm({
  accountId,
  onDone,
}: {
  accountId: string;
  onDone: () => void;
}) {
  const connect = useConnectCex();
  const [exchange, setExchange] = useState<ExchangeId>("bybit");
  const [label, setLabel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [apiSecret, setApiSecret] = useState("");
  const [apiPassphrase, setApiPassphrase] = useState("");
  const [error, setError] = useState<string | null>(null);

  const needsPassphrase = EXCHANGES_REQUIRING_PASSPHRASE.has(exchange);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (apiKey.trim().length < 8 || apiSecret.trim().length < 8) {
      setError("API key и secret должны быть указаны (мин. 8 символов).");
      return;
    }
    if (needsPassphrase && apiPassphrase.trim().length === 0) {
      setError(
        `${EXCHANGE_LABELS[exchange]} требует passphrase — третий параметр, который вы задавали при создании ключа.`,
      );
      return;
    }
    connect.mutate(
      {
        accountId,
        exchange,
        label: label.trim() || null,
        apiKey: apiKey.trim(),
        apiSecret: apiSecret.trim(),
        ...(needsPassphrase
          ? { apiPassphrase: apiPassphrase.trim() }
          : {}),
      },
      {
        onSuccess: () => {
          setLabel("");
          setApiKey("");
          setApiSecret("");
          setApiPassphrase("");
          onDone();
        },
        onError: (err) => {
          // The API returns `{ error, message, issues }` for ValidationError
          // and the api-client packs the body into ApiError.body — surface
          // the per-field issues so user sees WHAT failed, not just "400".
          setError(formatConnectError(err));
        },
      },
    );
  }

  return (
    <form
      onSubmit={submit}
      className="mt-2 grid grid-cols-1 gap-3 rounded-md border border-border bg-secondary/40 p-4 sm:grid-cols-2"
    >
      <div className="space-y-1.5">
        <Label htmlFor="cex-exchange">Биржа</Label>
        <select
          id="cex-exchange"
          value={exchange}
          onChange={(e) => setExchange(e.target.value as ExchangeId)}
          className="flex h-10 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground"
        >
          {SUPPORTED_EXCHANGES.map((ex) => (
            <option key={ex} value={ex}>
              {EXCHANGE_LABELS[ex]}
            </option>
          ))}
        </select>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="cex-label">Метка (опционально)</Label>
        <Input
          id="cex-label"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Main / Trading / etc."
          autoComplete="off"
        />
      </div>

      <div className="space-y-1.5 sm:col-span-2">
        <Label htmlFor="cex-key">API Key</Label>
        <Input
          id="cex-key"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          className="font-mono"
        />
      </div>

      <div className="space-y-1.5 sm:col-span-2">
        <Label htmlFor="cex-secret">API Secret</Label>
        <Input
          id="cex-secret"
          type="password"
          value={apiSecret}
          onChange={(e) => setApiSecret(e.target.value)}
          autoComplete="new-password"
          spellCheck={false}
          className="font-mono"
        />
      </div>

      {needsPassphrase && (
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="cex-passphrase">
            API Passphrase{" "}
            <span className="text-[11px] text-muted-foreground">
              (показывается ОДИН раз при создании ключа на бирже)
            </span>
          </Label>
          <Input
            id="cex-passphrase"
            type="password"
            value={apiPassphrase}
            onChange={(e) => setApiPassphrase(e.target.value)}
            autoComplete="new-password"
            spellCheck={false}
            className="font-mono"
          />
        </div>
      )}

      <ExchangeInstructions exchange={exchange} />

      <div className="flex items-center justify-end gap-2 sm:col-span-2">
        {error && <p className="mr-auto text-xs text-destructive">{error}</p>}
        <Button type="submit" disabled={connect.isPending}>
          {connect.isPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Plus />
          )}
          Подключить
        </Button>
      </div>
    </form>
  );
}

function ExchangeInstructions({ exchange }: { exchange: ExchangeId }) {
  return (
    <div className="sm:col-span-2 rounded-md border border-brand-cyan/30 bg-brand-cyan/5 p-3 text-[12px] text-muted-foreground">
      <div className="mb-1 inline-flex items-center gap-1 font-medium text-brand-cyan">
        <Info className="h-3.5 w-3.5" />
        Как создать READ-ONLY ключ на {EXCHANGE_LABELS[exchange]}
      </div>
      <ol className="ml-4 list-decimal space-y-0.5">
        {EXCHANGE_INSTRUCTIONS[exchange].map((line, i) => (
          <li key={i}>{line}</li>
        ))}
      </ol>
    </div>
  );
}

/* ────────────── Transfers (deposit / withdraw) sub-panel ────────────── */

/**
 * Collapsible "Переводы" sub-panel on each CEX card.
 *
 * Shows crypto deposits TO the CEX and withdrawals FROM it. When a
 * row has a `txHash`, the same hash on the user's on-chain wallet
 * means it's the SAME money movement — Registry renders both as a
 * matched "↔ CEX" pair so cost basis isn't double-counted.
 *
 * Implementation uses CCXT's unified `fetchDeposits` / `fetchWithdrawals`,
 * so all 5 supported exchanges work without per-exchange branching.
 */
function CexTransfersSubPanel({ accountId }: { accountId: string }) {
  const [open, setOpen] = useState(false);
  const sync = useSyncCexTransfers();
  const list = useCexTransfers(open ? accountId : null);
  const rows = list.data ?? [];

  return (
    <div className="mt-3 border-t border-border/60 pt-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between text-[11px] text-muted-foreground hover:text-foreground"
      >
        <span className="inline-flex items-center gap-1">
          <ArrowDownToLine className="h-3 w-3" />
          <ArrowUpFromLine className="h-3 w-3" />
          Переводы (deposit / withdraw)
        </span>
        <ChevronDown
          className={cn(
            "h-3 w-3 transition-transform",
            open && "rotate-180",
          )}
        />
      </button>

      {open && (
        <div className="mt-2 space-y-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => sync.mutate(accountId)}
            disabled={sync.isPending}
          >
            {sync.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            Подтянуть переводы
          </Button>

          {sync.data && sync.variables === accountId && (
            <div
              className={cn(
                "inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px]",
                sync.data.ok
                  ? "border-success/40 bg-success/10 text-success"
                  : "border-warning/40 bg-warning/10 text-warning",
              )}
            >
              {sync.data.ok ? (
                <CheckCircle2 className="h-3 w-3" />
              ) : (
                <AlertCircle className="h-3 w-3" />
              )}
              +{sync.data.newDeposits} deposit · +{sync.data.newWithdrawals} withdrawal
              {sync.data.error && (
                <span className="ml-1 text-[10px] opacity-80">
                  ({sync.data.error})
                </span>
              )}
            </div>
          )}

          <CexTransfersList rows={rows} loading={list.isLoading} />
        </div>
      )}
    </div>
  );
}

function CexTransfersList({
  rows,
  loading,
}: {
  rows: ReadonlyArray<{
    id: string;
    direction: string;
    asset: string;
    amount: string;
    feeAmount: string | null;
    feeCurrency: string | null;
    network: string | null;
    address: string | null;
    txHash: string | null;
    status: string;
    executedAt: string;
  }>;
  loading: boolean;
}) {
  if (loading) {
    return (
      <p className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" />
        Загрузка переводов…
      </p>
    );
  }
  if (rows.length === 0) {
    return (
      <p className="text-[11px] text-muted-foreground">
        Нет переводов. Нажмите «Подтянуть переводы» — если у вас были депозиты/выводы, они появятся здесь.
      </p>
    );
  }
  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <table className="w-full text-[11px]">
        <thead className="border-b border-border bg-secondary/40 text-[10px] uppercase tracking-wider text-muted-foreground">
          <tr>
            <th className="px-2 py-1 text-left font-medium">Дата</th>
            <th className="px-2 py-1 text-left font-medium">Направление</th>
            <th className="px-2 py-1 text-left font-medium">Актив</th>
            <th className="px-2 py-1 text-right font-medium">Сумма</th>
            <th className="px-2 py-1 text-right font-medium">Комиссия</th>
            <th className="px-2 py-1 text-left font-medium">Сеть</th>
            <th className="px-2 py-1 text-left font-medium">Адрес</th>
            <th className="px-2 py-1 text-left font-medium">Hash</th>
            <th className="px-2 py-1 text-left font-medium">Статус</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((r) => (
            <tr key={r.id}>
              <td className="px-2 py-1 whitespace-nowrap tabular-nums text-muted-foreground">
                {new Date(r.executedAt).toLocaleString()}
              </td>
              <td className="px-2 py-1">
                {r.direction === "deposit" ? (
                  <span className="inline-flex items-center gap-1 text-success">
                    <ArrowDownToLine className="h-3 w-3" /> deposit
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 text-destructive">
                    <ArrowUpFromLine className="h-3 w-3" /> withdraw
                  </span>
                )}
              </td>
              <td className="px-2 py-1 font-mono uppercase">{r.asset}</td>
              <td className="px-2 py-1 text-right tabular-nums">{r.amount}</td>
              <td className="px-2 py-1 text-right tabular-nums text-muted-foreground">
                {r.feeAmount != null
                  ? `${r.feeAmount} ${r.feeCurrency ?? ""}`
                  : "—"}
              </td>
              <td className="px-2 py-1 font-mono uppercase text-muted-foreground">
                {r.network ?? "—"}
              </td>
              <td className="px-2 py-1 font-mono text-[10px] text-muted-foreground">
                {r.address
                  ? `${r.address.slice(0, 6)}…${r.address.slice(-4)}`
                  : "—"}
              </td>
              <td className="px-2 py-1 font-mono text-[10px]">
                {r.txHash ? (
                  <span
                    className="text-brand-cyan"
                    title={r.txHash}
                  >
                    {r.txHash.slice(0, 6)}…{r.txHash.slice(-4)}
                  </span>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </td>
              <td className="px-2 py-1">
                <span
                  className={cn(
                    "rounded border px-1 py-px text-[10px] uppercase",
                    r.status === "ok"
                      ? "border-success/40 bg-success/10 text-success"
                      : r.status === "failed" || r.status === "canceled"
                        ? "border-destructive/40 bg-destructive/10 text-destructive"
                        : "border-border bg-secondary text-muted-foreground",
                  )}
                >
                  {r.status}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
