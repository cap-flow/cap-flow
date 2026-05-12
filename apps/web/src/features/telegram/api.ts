import { z } from "zod";

import { api } from "@/lib/api/client";

export const telegramStatusSchema = z.object({
  state: z.enum(["linked", "pending", "none"]),
  chatId: z.number().nullable(),
  telegramUsername: z.string().nullable(),
  linkedAt: z.string().nullable(),
});
export type TelegramStatus = z.infer<typeof telegramStatusSchema>;

export const telegramStartSchema = z.object({
  code: z.string(),
  deepLink: z.string(),
  expiresAt: z.string(),
});
export type TelegramStart = z.infer<typeof telegramStartSchema>;

export const telegramApi = {
  status: () => api.get("/v1/me/telegram", telegramStatusSchema),
  start: () =>
    api.post("/v1/me/telegram/start", undefined as unknown, telegramStartSchema),
  unlink: () =>
    api.delete("/v1/me/telegram", z.object({ revoked: z.number() })),
};
