/**
 * Admin → User detail (карточка клиента).
 *
 * Показывает полную информацию о юзере: basic info, подключённые портфели
 * (accounts), последние snapshots, активность. Доступна по клику с
 * `/admin/users` (на email) или прямой ссылкой `/admin/users/:id`.
 *
 * Источники данных:
 *   - adminUsersApi.list(search=email)   — basic info (email, name, role,
 *                                          status, registration, last login)
 *   - adminPortfoliosApi.list()          — все аккаунты, фильтруем по ownerId
 *                                          (each account = один портфель с
 *                                          подключенными wallets / CEX)
 *
 * Что **пока не показывается** (нужен новый backend endpoint):
 *   - Список конкретных wallets / CEX per account
 *   - История операций (purchases) по датам
 *   - Audit log этого юзера (есть в /admin/audit, фильтр по targetId)
 *
 * Workaround для глубокой проверки: использовать кнопку «Impersonate»
 * (view-mode) — увидеть всё что видит юзер.
 */

import { useMemo } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  useAdminUsers,
  useImpersonateUser,
} from "@/features/admin/users/hooks";
import { useAuth } from "@/features/auth/AuthProvider";
import { useQuery } from "@tanstack/react-query";
import { adminPortfoliosApi } from "@/features/admin/portfolios/api";

import { PageHeader } from "./_PageHeader";

export function AdminUserDetailPage(): JSX.Element {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user: me, startImpersonation } = useAuth();
  const impersonate = useImpersonateUser();

  // Загружаем список юзеров (cap 100), находим текущего.
  const usersQ = useAdminUsers({ limit: 100 });
  const user = (usersQ.data?.items ?? []).find((u) => u.id === id) ?? null;

  // Загружаем все portfolios, фильтруем по ownerId.
  const portfoliosQ = useQuery({
    queryKey: ["admin", "portfolios"],
    queryFn: () => adminPortfoliosApi.list(),
  });
  const myPortfolios = useMemo(
    () => (portfoliosQ.data ?? []).filter((a) => a.ownerId === id),
    [portfoliosQ.data, id],
  );

  const isSelf = me?.id === id;

  async function handleImpersonate(): Promise<void> {
    if (!user) return;
    try {
      const res = await impersonate.mutateAsync(user.id);
      await startImpersonation({
        accessToken: res.accessToken,
        impersonatedUserId: user.id,
      });
      navigate("/", { replace: true });
    } catch {
      // error swallowed; toast can be added later
    }
  }

  if (usersQ.isLoading) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="Карточка пользователя"
          description="Загружаем…"
        />
      </div>
    );
  }

  if (!user) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="Пользователь не найден"
          description={`Нет пользователя с id ${id}.`}
        />
      </div>
    );
  }

  const fullValue = myPortfolios.reduce(
    (s, a) => s + (a.lastSnapshotUsd ?? 0),
    0,
  );
  const snapshotsLast24h = myPortfolios.reduce(
    (s, a) => s + a.snapshotCount24h,
    0,
  );
  const errorsLast24h = myPortfolios.reduce((s, a) => s + a.errors24h, 0);
  const accountsActive = myPortfolios.length;

  return (
    <div className="space-y-6">
      <PageHeader
        title={user.email ?? user.name ?? "Пользователь"}
        description={`User ID: ${user.id}`}
        backTo="/admin/users"
      />

      {/* Quick actions */}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          onClick={() => void handleImpersonate()}
          disabled={isSelf || impersonate.isPending}
        >
          {isSelf
            ? "Это вы"
            : impersonate.isPending
              ? "Открываем…"
              : "🔑 Войти как этот пользователь (view-mode)"}
        </Button>
        <Button variant="outline" asChild>
          <Link to={`/admin/audit?targetId=${user.id}`}>
            📋 Audit log этого юзера
          </Link>
        </Button>
        <Button variant="outline" asChild>
          <Link to="/admin/users">← Список пользователей</Link>
        </Button>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Basic info */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Основная информация</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <InfoRow label="Email" value={user.email ?? "—"} />
            <InfoRow label="Имя" value={user.name ?? "—"} />
            <InfoRow
              label="Роль"
              value={
                <Badge
                  variant={user.role === "admin" ? "default" : "outline"}
                  className="text-[10px]"
                >
                  {user.role}
                </Badge>
              }
            />
            <InfoRow
              label="Статус"
              value={
                <Badge
                  variant={user.status === "active" ? "default" : "outline"}
                  className={
                    "text-[10px] " +
                    (user.status === "active"
                      ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
                      : user.status === "blocked"
                        ? "bg-red-500/15 text-red-700 dark:text-red-400"
                        : "")
                  }
                >
                  {user.status}
                </Badge>
              }
            />
            <InfoRow
              label="Зарегистрирован"
              value={formatDate(user.createdAt)}
            />
            <InfoRow
              label="Последний вход"
              value={user.lastLoginAt ? formatDate(user.lastLoginAt) : "ни разу"}
            />
            <InfoRow label="ID" value={<code className="font-mono text-xs">{user.id}</code>} />
          </CardContent>
        </Card>

        {/* Portfolio summary */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Сводка по портфелю</CardTitle>
            <CardDescription>
              Агрегат по всем подключенным аккаунтам/портфелям.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <InfoRow label="Кол-во аккаунтов" value={accountsActive.toString()} />
            <InfoRow
              label="Общая стоимость"
              value={
                <span className="font-semibold">
                  {fullValue > 0 ? `$${fullValue.toFixed(2)}` : "—"}
                </span>
              }
            />
            <InfoRow
              label="Snapshots за 24ч"
              value={snapshotsLast24h.toString()}
            />
            <InfoRow
              label="Ошибок за 24ч"
              value={
                <span
                  className={errorsLast24h > 0 ? "text-red-600" : ""}
                >
                  {errorsLast24h}
                </span>
              }
            />
            <InfoRow
              label="Последний refresh"
              value={
                myPortfolios.length === 0
                  ? "—"
                  : myPortfolios
                        .map((a) => a.lastSnapshotAt)
                        .filter((x): x is string => !!x)
                        .sort()
                        .pop()
                    ? formatDate(
                        myPortfolios
                          .map((a) => a.lastSnapshotAt)
                          .filter((x): x is string => !!x)
                          .sort()
                          .pop()!,
                      )
                    : "ни разу"
              }
            />
          </CardContent>
        </Card>
      </div>

      {/* Accounts list */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Аккаунты ({myPortfolios.length})
          </CardTitle>
          <CardDescription>
            Каждый аккаунт — отдельный портфель с подключенными кошельками и
            биржами. Для детального просмотра кошельков/CEX используй кнопку
            «Войти как этот пользователь» выше — увидишь портфель глазами
            этого юзера.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {portfoliosQ.isLoading ? (
            <p className="text-sm text-muted-foreground">Загружаем…</p>
          ) : myPortfolios.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              У пользователя нет ни одного аккаунта.
            </p>
          ) : (
            <div className="space-y-2">
              {myPortfolios.map((a) => (
                <div
                  key={a.accountId}
                  className="rounded-md border border-border bg-secondary/30 p-3"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{a.accountName}</span>
                        {a.isPrimary && (
                          <Badge variant="outline" className="text-[10px]">
                            primary
                          </Badge>
                        )}
                      </div>
                      <code className="text-[10px] text-muted-foreground">
                        {a.accountId}
                      </code>
                    </div>
                    <div className="text-right text-sm">
                      <div className="font-semibold">
                        {a.lastSnapshotUsd != null
                          ? `$${a.lastSnapshotUsd.toFixed(2)}`
                          : "—"}
                      </div>
                      <div className="text-[10px] text-muted-foreground">
                        {a.lastSnapshotAt
                          ? formatDate(a.lastSnapshotAt)
                          : "нет snapshot'ов"}
                      </div>
                    </div>
                  </div>
                  <div className="mt-2 flex gap-3 text-[10px] text-muted-foreground">
                    <span>Snapshots 24ч: {a.snapshotCount24h}</span>
                    {a.errors24h > 0 && (
                      <span className="text-red-600">
                        Ошибок: {a.errors24h}
                      </span>
                    )}
                    {a.lastTrigger && <span>Триггер: {a.lastTrigger}</span>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Coming soon: detailed wallets/CEX/operations */}
      <Card className="border-dashed">
        <CardHeader>
          <CardTitle className="text-base">Подробная история операций</CardTitle>
          <CardDescription>
            Полный список кошельков, CEX-подключений и операций (покупок) с
            датами — на стороне backend нужны admin endpoints для этих данных.
            Сейчас доступно через «Войти как этот пользователь» (view-mode).
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="space-y-1 text-xs text-muted-foreground">
            <li>📦 Кошельки (EVM / Solana / CoinStats) — TODO endpoint</li>
            <li>🏦 CEX биржи (Bybit / OKX / Bitget / MEXC / BingX) — TODO endpoint</li>
            <li>💰 Покупки (swap / deposit_fiat) с датами и стоимостью — TODO endpoint</li>
            <li>📊 Цикл refresh'ей и triggers — частично уже в /admin/queue</li>
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}

function InfoRow({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}): JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-border/40 py-1.5 last:border-0">
      <span className="text-xs uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <span className="text-right">{value}</span>
    </div>
  );
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString("ru-RU", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}
