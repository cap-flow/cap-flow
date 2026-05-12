import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  useAllocateAddress,
  useBillingSummary,
  usePaymentsHistory,
} from "@/features/billing/hooks";
import type {
  CryptoNetwork,
  PaymentAddress,
  SubscriptionStatus,
} from "@/features/billing/api";

const STATUS_LABELS: Record<SubscriptionStatus, string> = {
  beta: "Beta — без подписки",
  active: "Активна",
  grace: "Период льготы",
  expired: "Истекла",
};

const STATUS_TONE: Record<SubscriptionStatus, string> = {
  beta:
    "bg-muted text-muted-foreground border-muted-foreground/20",
  active: "bg-emerald-500/15 text-emerald-600 border-emerald-500/30",
  grace: "bg-amber-500/15 text-amber-700 border-amber-500/30",
  expired: "bg-destructive/15 text-destructive border-destructive/30",
};

export function BillingPage(): JSX.Element {
  const summary = useBillingSummary();
  const payments = usePaymentsHistory();
  const allocate = useAllocateAddress();

  const [trc20, setTrc20] = useState<PaymentAddress | null>(null);
  const [erc20, setErc20] = useState<PaymentAddress | null>(null);
  const [allocError, setAllocError] = useState<string | null>(null);

  async function onAllocate(network: CryptoNetwork): Promise<void> {
    setAllocError(null);
    try {
      const addr = await allocate.mutateAsync(network);
      if (network === "trc20") setTrc20(addr);
      else setErc20(addr);
    } catch (err) {
      setAllocError(
        err instanceof Error ? err.message : "Не удалось выделить адрес"
      );
    }
  }

  const s = summary.data;
  const status = s?.status ?? "beta";

  return (
    <div className="space-y-6 p-4">
      <h1 className="text-2xl font-semibold">Подписка</h1>

      <Card>
        <CardHeader>
          <CardTitle>Статус</CardTitle>
          <CardDescription>
            {summary.isLoading ? "Загружаем…" : null}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <span
            className={`inline-block rounded-md border px-3 py-1 text-sm ${STATUS_TONE[status]}`}
          >
            {STATUS_LABELS[status]}
          </span>
          {s && (
            <div className="grid gap-2 text-sm">
              <Row label="Тариф" value={s.plan ?? "—"} />
              <Row label="Стоимость, USD" value={s.amountUsd ?? "—"} />
              <Row
                label="Активна до"
                value={s.periodEnd ? new Date(s.periodEnd).toLocaleString("ru") : "—"}
              />
              <Row
                label="Льготный период до"
                value={
                  s.graceUntil
                    ? new Date(s.graceUntil).toLocaleString("ru")
                    : "—"
                }
              />
              <Row
                label="Осталось дней"
                value={s.daysLeft !== null ? String(s.daysLeft) : "—"}
              />
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Оплата</CardTitle>
          <CardDescription>
            Получите личный адрес для приёма USDT. Оплачивать можно с любого
            кошелька — мы автоматически зачтём поступление при подтверждении.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <AddressCard
              network="trc20"
              title="USDT TRC20 (Tron)"
              addr={trc20}
              onAllocate={() => onAllocate("trc20")}
              loading={allocate.isPending && allocate.variables === "trc20"}
            />
            <AddressCard
              network="erc20"
              title="USDT ERC20 (Ethereum)"
              addr={erc20}
              onAllocate={() => onAllocate("erc20")}
              loading={allocate.isPending && allocate.variables === "erc20"}
            />
          </div>
          {allocError && (
            <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {allocError}
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>История платежей</CardTitle>
        </CardHeader>
        <CardContent>
          {payments.isLoading ? (
            <p className="text-sm text-muted-foreground">Загружаем…</p>
          ) : !payments.data || payments.data.length === 0 ? (
            <p className="text-sm text-muted-foreground">Платежей пока нет.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-muted-foreground">
                <tr>
                  <th className="py-2">Дата</th>
                  <th className="py-2">Тип</th>
                  <th className="py-2">Тариф</th>
                  <th className="py-2 text-right">Сумма, USD</th>
                  <th className="py-2">До</th>
                </tr>
              </thead>
              <tbody>
                {payments.data.map((p) => (
                  <tr key={p.id} className="border-t">
                    <td className="py-2">
                      {new Date(p.paidAt).toLocaleDateString("ru")}
                    </td>
                    <td className="py-2">{p.kind}</td>
                    <td className="py-2">{p.plan}</td>
                    <td className="py-2 text-right">{p.amountUsd}</td>
                    <td className="py-2">
                      {p.periodEnd
                        ? new Date(p.periodEnd).toLocaleDateString("ru")
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Row({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}): JSX.Element {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}

function AddressCard({
  network,
  title,
  addr,
  onAllocate,
  loading,
}: {
  readonly network: CryptoNetwork;
  readonly title: string;
  readonly addr: PaymentAddress | null;
  readonly onAllocate: () => void;
  readonly loading: boolean;
}): JSX.Element {
  return (
    <div className="rounded-lg border p-3">
      <p className="text-sm font-medium">{title}</p>
      {addr ? (
        <div className="mt-2 space-y-2">
          <p className="break-all rounded-md bg-muted px-2 py-1 font-mono text-xs">
            {addr.address}
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void navigator.clipboard.writeText(addr.address)}
          >
            Скопировать
          </Button>
        </div>
      ) : (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="mt-2"
          onClick={onAllocate}
          disabled={loading}
        >
          {loading ? "Создаём…" : `Получить ${network.toUpperCase()} адрес`}
        </Button>
      )}
    </div>
  );
}
