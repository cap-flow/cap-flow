import { z } from "zod";

import { api } from "@/lib/api/client";

export const notificationChannelSchema = z.enum(["email", "telegram"]);
export type NotificationChannel = z.infer<typeof notificationChannelSchema>;

export const subscriptionSchema = z.object({
  type: z.string(),
  channel: notificationChannelSchema,
  enabled: z.boolean(),
  updatedAt: z.string(),
});
export type NotificationSubscription = z.infer<typeof subscriptionSchema>;

const listSchema = z.array(subscriptionSchema);

export interface UpsertSubscriptionInput {
  readonly type: string;
  readonly channel: NotificationChannel;
  readonly enabled: boolean;
}

/**
 * Canonical alert types the worker can emit. Frontend renders one row per
 * (type × channel) so the user can toggle email/telegram independently.
 *
 * Keep this list in sync with what `NotificationsService.send({type})`
 * actually fires — backend treats unknown types gracefully but the toggle
 * won't appear unless we add it here.
 */
export const KNOWN_NOTIFICATION_TYPES: ReadonlyArray<{
  readonly key: string;
  readonly label: string;
  readonly description: string;
}> = [
  {
    key: "portfolio_change_5pct",
    label: "Изменение портфеля > 5%",
    description: "Резкие движения суммарного TVL за сутки.",
  },
  {
    key: "refresh_failed",
    label: "Сбой обновления",
    description: "Когда автоматический refresh не смог дотянуться до данных.",
  },
  {
    key: "aave_hf_low",
    label: "Aave: низкий Health Factor",
    description: "HF < 1.15 в любой Aave-позиции.",
  },
  {
    key: "payment_received",
    label: "Получена оплата",
    description: "USDT зачислен и подписка продлена.",
  },
];

export const notificationsApi = {
  list: () => api.get("/v1/me/notifications", listSchema),
  upsert: (body: UpsertSubscriptionInput) =>
    api.put("/v1/me/notifications", body, subscriptionSchema),
};
