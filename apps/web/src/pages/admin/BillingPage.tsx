import { useState } from "react";

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
import {
  useAdminCredit,
  useAdminRefund,
  useAdminUserBilling,
} from "@/features/admin/billing/hooks";
import { useAdminUsers } from "@/features/admin/users/hooks";
import { PageHeader } from "./_PageHeader";

/**
 * Admin billing console: pick a user from the table on the left, see their
 * subscription + history on the right, with manual credit / refund actions.
 *
 * Phase 8 ships manual-credit as the primary tool — auto-credit needs real
 * blockchain providers wired (Phase 8b). Refund records a negative-amount
 * row; admin can additionally suspend the user via /admin/users if needed.
 */
export function AdminBillingPage(): JSX.Element {
  const users = useAdminUsers({});
  const [selected, setSelected] = useState<string | null>(null);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Биллинг"
        description="Подписки и платежи пользователей."
      />

      <div className="grid gap-4 lg:grid-cols-[320px,1fr]">
        <Card className="self-start">
          <CardHeader>
            <CardTitle className="text-base">Пользователи</CardTitle>
            <CardDescription>Кликните для выбора</CardDescription>
          </CardHeader>
          <CardContent className="max-h-[60vh] overflow-y-auto">
            {users.isLoading ? (
              <p className="text-sm text-muted-foreground">Загружаем…</p>
            ) : (
              <ul className="space-y-1 text-sm">
                {users.data?.map((u) => (
                  <li key={u.id}>
                    <button
                      type="button"
                      onClick={() => setSelected(u.id)}
                      className={`w-full rounded-md px-2 py-1.5 text-left transition ${
                        selected === u.id
                          ? "bg-primary/10 text-primary"
                          : "hover:bg-muted/60"
                      }`}
                    >
                      <div className="font-medium">{u.email ?? "—"}</div>
                      <div className="text-xs text-muted-foreground">
                        {u.role} · {u.status}
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        {selected ? (
          <UserBillingPanel userId={selected} />
        ) : (
          <Card>
            <CardContent className="py-12 text-center text-sm text-muted-foreground">
              Выберите пользователя слева, чтобы увидеть его подписку и историю.
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}

function UserBillingPanel({ userId }: { readonly userId: string }): JSX.Element {
  const billing = useAdminUserBilling(userId);
  const credit = useAdminCredit(userId);
  const refund = useAdminRefund(userId);

  const [amount, setAmount] = useState("100");
  const [note, setNote] = useState("");
  const [creditError, setCreditError] = useState<string | null>(null);

  async function onCredit(): Promise<void> {
    setCreditError(null);
    try {
      await credit.mutateAsync({
        amountUsd: Number(amount),
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      setAmount("100");
      setNote("");
    } catch (err) {
      setCreditError(err instanceof Error ? err.message : "Ошибка");
    }
  }

  async function onRefund(paymentId: string): Promise<void> {
    try {
      await refund.mutateAsync({ paymentId });
    } catch {
      // toast omitted — error visible via row state
    }
  }

  if (billing.isLoading) {
    return (
      <Card>
        <CardContent className="py-8 text-sm text-muted-foreground">
          Загружаем биллинг пользователя…
        </CardContent>
      </Card>
    );
  }
  if (!billing.data) {
    return (
      <Card>
        <CardContent className="py-8 text-sm text-destructive">
          Не удалось загрузить.
        </CardContent>
      </Card>
    );
  }

  const sub = billing.data.subscription;
  const history = billing.data.history;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Подписка</CardTitle>
          <CardDescription>
            Статус: <b>{sub.status}</b>{" "}
            {sub.daysLeft !== null && (
              <span className="text-muted-foreground">
                · осталось {sub.daysLeft} д
              </span>
            )}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-2 text-sm sm:grid-cols-2">
          <Field label="Тариф" value={sub.plan ?? "—"} />
          <Field label="Сумма, USD" value={sub.amountUsd ?? "—"} />
          <Field
            label="Активна до"
            value={
              sub.periodEnd ? new Date(sub.periodEnd).toLocaleString("ru") : "—"
            }
          />
          <Field
            label="Льготный период до"
            value={
              sub.graceUntil
                ? new Date(sub.graceUntil).toLocaleString("ru")
                : "—"
            }
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Ручной credit</CardTitle>
          <CardDescription>
            $100 → 3 мес, $180 → 6 мес, $300 → 12 мес. Меньшие суммы
            отклоняются.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-2 sm:grid-cols-[1fr,2fr,auto]">
            <div>
              <Label htmlFor="amount">USD</Label>
              <Input
                id="amount"
                type="number"
                min={1}
                step={1}
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                disabled={credit.isPending}
              />
            </div>
            <div>
              <Label htmlFor="note">Комментарий</Label>
              <Input
                id="note"
                type="text"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                disabled={credit.isPending}
              />
            </div>
            <div className="flex items-end">
              <Button
                type="button"
                onClick={() => void onCredit()}
                disabled={credit.isPending || !amount}
              >
                {credit.isPending ? "Зачисляем…" : "Зачислить"}
              </Button>
            </div>
          </div>
          {creditError && (
            <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {creditError}
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">История</CardTitle>
        </CardHeader>
        <CardContent>
          {history.length === 0 ? (
            <p className="text-sm text-muted-foreground">Платежей пока нет.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-muted-foreground">
                <tr>
                  <th className="py-2">Дата</th>
                  <th className="py-2">Тип</th>
                  <th className="py-2">Тариф</th>
                  <th className="py-2 text-right">USD</th>
                  <th className="py-2">Период до</th>
                  <th className="py-2 text-right" />
                </tr>
              </thead>
              <tbody>
                {history.map((p) => (
                  <tr key={p.id} className="border-t">
                    <td className="py-2">
                      {new Date(p.paidAt).toLocaleString("ru")}
                    </td>
                    <td className="py-2">{p.kind}</td>
                    <td className="py-2">{p.plan}</td>
                    <td className="py-2 text-right">{p.amountUsd}</td>
                    <td className="py-2">
                      {p.periodEnd
                        ? new Date(p.periodEnd).toLocaleDateString("ru")
                        : "—"}
                    </td>
                    <td className="py-2 text-right">
                      {p.kind === "subscription" && (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => void onRefund(p.id)}
                          disabled={refund.isPending}
                        >
                          Refund
                        </Button>
                      )}
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

function Field({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}): JSX.Element {
  return (
    <div className="flex justify-between gap-4">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}
