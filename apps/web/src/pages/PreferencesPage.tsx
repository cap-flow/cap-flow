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
    // Открываем placeholder синхронно ВНУТРИ user-gesture, иначе
    // popup-blocker зарубит окно после await. Подменяем location
    // как только бэк вернёт готовый deep-link.
    const popup = window.open("about:blank", "_blank", "noopener");
    try {
      const r = await start.mutateAsync();
      setIssued(r);
      if (r.deepLink && popup && !popup.closed) {
        popup.location.href = r.deepLink;
      } else if (popup && !popup.closed) {
        // Бот не настроен или попап заблокирован — закрываем плейсхолдер.
        // Юзер увидит карточку с кодом ниже и сможет открыть ссылку
        // вручную (если deepLink есть, но popup ровно нулевой —
        // edge case старого Safari, fallback ниже сработает).
        popup.close();
      }
    } catch (e) {
      if (popup && !popup.closed) popup.close();
      throw e;
    }
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
        {state === "pending" && (
          <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm">
            <div className="font-medium text-amber-700 dark:text-amber-300">
              Ожидаем подтверждение от бота…
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              Откройте бот в Telegram (вкладка должна была открыться
              автоматически) и нажмите кнопку <b>Start</b>. Этот блок
              обновится сам, как только бот примет код.
            </div>
          </div>
        )}

        {issued && (
          <div className="rounded-md border bg-muted/40 px-3 py-2 text-sm">
            {issued.deepLink ? (
              <>
                <div className="font-medium">
                  Вкладка с авторизацией открыта в Telegram.
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  Если вкладка не открылась автоматически —{" "}
                  <a
                    href={issued.deepLink}
                    target="_blank"
                    rel="noreferrer"
                    className="text-primary hover:underline"
                  >
                    откройте ссылку вручную
                  </a>
                  . Код одноразовый, действует ограниченное время:{" "}
                  <code className="break-all">{issued.code}</code>
                </div>
              </>
            ) : (
              <>
                <div className="font-medium">Код активации (одноразовый):</div>
                <code className="break-all">{issued.code}</code>
                <div className="mt-2 text-xs text-muted-foreground">
                  Бот пока не настроен — сохраните код, мы свяжемся для
                  ручной активации.
                </div>
              </>
            )}
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
        <table className="w-full text-sm">
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
      </CardContent>
    </Card>
  );
}
