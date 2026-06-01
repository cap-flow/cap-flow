import { z } from "zod";

import { api } from "@/lib/api/client";

const settingValueSchema = z.union([z.number(), z.boolean(), z.string()]);

export const resolvedSettingSchema = z.object({
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
export type ResolvedSetting = z.infer<typeof resolvedSettingSchema>;

const listSchema = z.array(resolvedSettingSchema);
const okSchema = z.object({ ok: z.literal(true) });

export const adminAppSettingsApi = {
  list: () => api.get("/v1/admin/app-settings", listSchema),
  set: (key: string, value: number | boolean | string) =>
    api.patch(
      `/v1/admin/app-settings/${encodeURIComponent(key)}`,
      { value },
      okSchema,
    ),
  reset: (key: string) =>
    api.delete(
      `/v1/admin/app-settings/${encodeURIComponent(key)}`,
      okSchema,
    ),
};
