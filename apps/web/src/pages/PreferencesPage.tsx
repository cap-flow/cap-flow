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
          Привяжите Telegram, чтобы получать алерты в чат. Бот сейчас в
          разработке — код вы получите, но сообщения начнут приходить, когда
          мы запустим бот.
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
          <div className="text-sm text-muted-foreground">
            chat_id: <code>{status.data.chatId}</code>
            {status.data.telegramUsername && (
              <>
                {" · "}
                @{status.data.telegramUsername}
              </>
            )}
          </div>
        )}

        {issued && (
          <div className="rounded-md border bg-muted/40 px-3 py-2 text-sm">
            <div className="font-medium">Код активации (одноразовый):</div>
            <code className="break-all">{issued.code}</code>
            {issued.deepLink ? (
              <div className="mt-2">
                <a
                  href={issued.deepLink}
                  target="_blank"
                  rel="noreferrer"
                  className="text-primary hover:underline"
                >
                  Открыть в Telegram
                </a>
              </div>
            ) : (
              <div className="mt-2 text-xs text-muted-foreground">
                Бот пока не настроен — сохраните код, мы свяжемся для
                ручной активации.
              </div>
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
              {start.isPending ? "Генерируем код…" : "Получить код активации"}
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
