import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

import { UnauthorizedError } from "../../core/errors.js";
import type { AuditService } from "../audit/audit.service.js";

import type { AppSettingsService } from "./app-settings.service.js";

const settingValueSchema = z.union([z.number(), z.boolean(), z.string()]);

const resolvedSettingSchema = z.object({
  key: z.string(),
  scope: z.enum(["backend", "frontend"]),
  group: z.string(),
  label: z.string(),
  description: z.string(),
  valueType: z.enum(["number", "boolean", "string"]),
  defaultValue: settingValueSchema,
  min: z.number().optional(),
  max: z.number().optional(),
  hotReload: z.enum(["live", "restart"]),
  currentValue: settingValueSchema,
  source: z.enum(["db", "default"]),
  editedAt: z.string().nullable(),
});

interface AppSettingsRoutesOptions {
  readonly service: AppSettingsService;
  readonly audit: AuditService;
}

export async function adminAppSettingsRoutes(
  app: FastifyInstance,
  opts: AppSettingsRoutesOptions,
): Promise<void> {
  const route = app.withTypeProvider<ZodTypeProvider>();
  route.addHook("preHandler", app.requireAdmin);

  route.get(
    "/",
    { schema: { response: { 200: z.array(resolvedSettingSchema) } } },
    async () => opts.service.listResolved(),
  );

  /** Задать значение кноба. Значения НЕсекретны → можно логировать. */
  route.patch(
    "/:key",
    {
      schema: {
        params: z.object({ key: z.string().min(1).max(80) }),
        body: z.object({ value: settingValueSchema }),
        response: { 200: z.object({ ok: z.literal(true) }) },
      },
    },
    async (req) => {
      const u = req.user;
      if (!u) throw new UnauthorizedError();
      await opts.service.set(req.params.key, req.body.value, u.id);
      await opts.audit.log({
        actorUserId: u.id,
        action: "app_setting.updated",
        payload: { key: req.params.key, value: req.body.value },
      });
      return { ok: true as const };
    },
  );

  /** Сброс кноба к дефолту (удаляет DB-override). */
  route.delete(
    "/:key",
    {
      schema: {
        params: z.object({ key: z.string().min(1).max(80) }),
        response: { 200: z.object({ ok: z.literal(true) }) },
      },
    },
    async (req) => {
      const u = req.user;
      if (!u) throw new UnauthorizedError();
      await opts.service.reset(req.params.key, u.id);
      await opts.audit.log({
        actorUserId: u.id,
        action: "app_setting.reset",
        payload: { key: req.params.key },
      });
      return { ok: true as const };
    },
  );
}
