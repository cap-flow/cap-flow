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
  KNOWN_NOTIFICATION_TYPES,
  type NotificationChannel,
} from "@/features/notifications/api";
import {
  useNotificationSubscriptions,
  useUpsertSubscription,
} from "@/features/notifications/hooks";
import type { TelegramStart } from "@/features/telegram/api";
import {
  useStartTelegramLink,
  useTelegramStatus,
  useUnlinkTelegram,
} from "@/features/telegram/hooks";

export function PreferencesPage(): JSX.Element {
  return (
    <div className="space-y-6 p-4">
      <h1 className="text-2xl font-semibold">Уведомления и интеграции</h1>
      <TelegramSection />
      <SubscriptionsSection />
    </div>
  );
}

function TelegramSection(): JSX.Element {
  const status = useTelegramStatus();
  const start = useStartTelegramLink();
  const unlink = useUnlinkTelegram();
  const [issued, setIssued] = useState<TelegramStart | null>(null);

  async function onStart(): Promise<void> {
    // Просто запрашиваем deep-link у сервера. НЕ открываем попап
    // программно: window.open блокируется popup-blocker'ами, sandboxed
    // preview-окружениями (Claude Preview разрешает только localhost),
    // и в любом случае требует второй клик пользователя на «доверить».
    // Вместо этого после получения deepLink рендерим прямую <a>-кнопку
    // CTA — нативный <a target="_blank"> работает в любом окружении.
    const r = await start.mutateAsync();
    setIssued(r);
  }
  async function onUnlink(): Promise<void> {
    await unlink.mutateAsync();
    setIssued(null);
  }

  const state = status.data?.state ?? "none";

  return (
    <Card>
      <CardHeader>
        <CardTitle>Telegram</CardTitle>
        <CardDescription>
          Привяжите Telegram, чтобы получать алерты в чат. По кнопке ниже
          откроется новая вкладка с готовой ссылкой авторизации —
          подтвердите в боте, и канал заработает.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm">
          Текущее состояние:{" "}
          <b>
            {state === "linked"
              ? "привязан"
              : state === "pending"
              ? "ожидаем /start от бота"
              : "не привязан"}
          </b>
        </p>
        {state === "linked" && status.data && (
          <div className="rounded-md border border-green-500/30 bg-green-500/10 px-3 py-2 text-sm">
            <div className="font-medium text-green-700 dark:text-green-300">
              ✓ Telegram авторизация подтверждена
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              chat_id: <code>{status.data.chatId}</code>
              {status.data.telegramUsername && (
                <>
                  {" · "}
                  @{status.data.telegramUsername}
                </>
              )}
            </div>
            <div className="mt-2 text-xs text-foreground/80">
              Уведомления будут приходить в этот чат. Чтобы они корректно
              отображались в карточке клиента — свяжите этот Telegram-профиль
              со своей карточкой ниже (в разделе «Подписки» выберите типы
              событий, которые хотите получать).
            </div>
          </div>
        )}
        {state === "pending" && !issued && (
          <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm">
            <div className="font-medium text-amber-700 dark:text-amber-300">
              Не завершённая привязка
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              Вы начинали привязку Telegram, но не подтвердили /start в
              боте. Нажмите «Авторизоваться в Telegram» ниже — будет
              сгенерирована новая одноразовая ссылка.
            </div>
          </div>
        )}
        {state === "pending" && issued && (
          <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm">
            <div className="font-medium text-amber-700 dark:text-amber-300">
              Ожидаем подтверждение от бота…
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              Нажмите <b>Start</b> в боте Telegram. Этот блок обновится сам
              в течение нескольких секунд после подтверждения.
            </div>
          </div>
        )}

        {issued && issued.deepLink && state !== "linked" && (
          <div className="rounded-md border border-primary/30 bg-primary/5 px-3 py-3 text-sm">
            <div className="font-medium">Ссылка готова — откройте бот:</div>
            <a
              href={issued.deepLink}
              target="_blank"
              rel="noreferrer"
              className="mt-2 inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
            >
              Открыть бот в Telegram →
            </a>
            <div className="mt-2 text-xs text-muted-foreground">
              Откроется новая вкладка / Telegram-приложение. Внутри нажмите
              кнопку <b>Start</b> — этот блок обновится автоматически.
              <br />
              Код одноразовый:{" "}
              <code className="break-all">{issued.code}</code>
            </div>
          </div>
        )}
        {issued && !issued.deepLink && (
          <div className="rounded-md border bg-muted/40 px-3 py-2 text-sm">
            <div className="font-medium">Код активации (одноразовый):</div>
            <code className="break-all">{issued.code}</code>
            <div className="mt-2 text-xs text-muted-foreground">
              Бот пока не настроен — попросите админа подключить
              TELEGRAM_BOT_USERNAME в /admin/integrations.
            </div>
          </div>
        )}

        <div className="flex gap-2">
          {state !== "linked" && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void onStart()}
              disabled={start.isPending}
            >
              {start.isPending
                ? "Готовим ссылку…"
                : "Авторизоваться в Telegram"}
            </Button>
          )}
          {state !== "none" && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void onUnlink()}
              disabled={unlink.isPending}
            >
              {unlink.isPending ? "Отвязываем…" : "Отвязать"}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function SubscriptionsSection(): JSX.Element {
  const subs = useNotificationSubscriptions();
  const upsert = useUpsertSubscription();

  function isEnabled(type: string, channel: NotificationChannel): boolean {
    const row = subs.data?.find(
      (s) => s.type === type && s.channel === channel
    );
    // Default: enabled if no row (matches backend `isEnabled` semantics).
    return row ? row.enabled : true;
  }

  function onToggle(
    type: string,
    channel: NotificationChannel,
    enabled: boolean
  ): void {
    upsert.mutate({ type, channel, enabled });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Подписки</CardTitle>
        <CardDescription>
          Выберите, какие события вы хотите получать по каждому каналу.
          Транзакционные письма (сброс пароля, приглашение) приходят всегда.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {/* Desktop */}
        <table className="hidden md:table w-full text-sm">
          <thead className="text-left text-muted-foreground">
            <tr>
              <th className="py-2">Событие</th>
              <th className="py-2 text-center">Email</th>
              <th className="py-2 text-center">Telegram</th>
            </tr>
          </thead>
          <tbody>
            {KNOWN_NOTIFICATION_TYPES.map((t) => (
              <tr key={t.key} className="border-t align-top">
                <td className="py-3 pr-4">
                  <div className="font-medium">{t.label}</div>
                  <div className="text-xs text-muted-foreground">
                    {t.description}
                  </div>
                </td>
                <td className="py-3 text-center">
                  <input
                    type="checkbox"
                    checked={isEnabled(t.key, "email")}
                    onChange={(e) =>
                      onToggle(t.key, "email", e.target.checked)
                    }
                    disabled={upsert.isPending}
                  />
                </td>
                <td className="py-3 text-center">
                  <input
                    type="checkbox"
                    checked={isEnabled(t.key, "telegram")}
                    onChange={(e) =>
                      onToggle(t.key, "telegram", e.target.checked)
                    }
                    disabled={upsert.isPending}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* Mobile */}
        <ul className="md:hidden divide-y divide-border">
          {KNOWN_NOTIFICATION_TYPES.map((t) => (
            <li key={t.key} className="py-3 text-sm">
              <div className="font-medium">{t.label}</div>
              <div className="mt-0.5 text-xs text-muted-foreground">
                {t.description}
              </div>
              <div className="mt-2 grid grid-cols-2 gap-2">
                <label className="flex items-center justify-between gap-2 rounded border border-border bg-secondary/30 px-3 py-2">
                  <span className="text-xs">Email</span>
                  <input
                    type="checkbox"
                    checked={isEnabled(t.key, "email")}
                    onChange={(e) => onToggle(t.key, "email", e.target.checked)}
                    disabled={upsert.isPending}
                  />
                </label>
                <label className="flex items-center justify-between gap-2 rounded border border-border bg-secondary/30 px-3 py-2">
                  <span className="text-xs">Telegram</span>
                  <input
                    type="checkbox"
                    checked={isEnabled(t.key, "telegram")}
                    onChange={(e) => onToggle(t.key, "telegram", e.target.checked)}
                    disabled={upsert.isPending}
                  />
                </label>
              </div>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
