import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

import type { AppSettingsService } from "./app-settings.service.js";

/**
 * Публичная (authed, не admin) выдача frontend-кнобов для веба.
 * Веб дёргает это на boot и применяет к пагинации истории / авто-рефрешу.
 * Ключи — те же, что `scope:'frontend'` в каталоге (см. catalog), значения —
 * число/boolean/строка. Сейчас все frontend-кнобы числовые.
 */
const configSchema = z.record(
  z.string(),
  z.union([z.number(), z.boolean(), z.string()]),
);

interface MeAppConfigRoutesOptions {
  readonly service: AppSettingsService;
}

export async function meAppConfigRoutes(
  app: FastifyInstance,
  opts: MeAppConfigRoutesOptions,
): Promise<void> {
  const route = app.withTypeProvider<ZodTypeProvider>();
  route.addHook("preHandler", app.requireAuth);

  route.get(
    "/",
    { schema: { response: { 200: configSchema } } },
    async () => opts.service.frontendConfig(),
  );
}
