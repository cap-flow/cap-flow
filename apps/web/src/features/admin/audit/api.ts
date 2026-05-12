import { z } from "zod";

import { api } from "@/lib/api/client";

export const auditEntrySchema = z.object({
  id: z.string().uuid(),
  actorId: z.string().uuid().nullable(),
  asAdmin: z.boolean(),
  targetUserId: z.string().uuid().nullable(),
  accountId: z.string().uuid().nullable(),
  action: z.string(),
  target: z.string().nullable(),
  payload: z.unknown().nullable(),
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  occurredAt: z.string().datetime(),
});
export type AuditEntry = z.infer<typeof auditEntrySchema>;

export const actionCountSchema = z.object({
  action: z.string(),
  n: z.number(),
});
export type ActionCount = z.infer<typeof actionCountSchema>;

const auditListSchema = z.array(auditEntrySchema);
const actionCountsListSchema = z.array(actionCountSchema);

export interface AuditFilter {
  readonly action?: string | undefined;
  readonly asAdmin?: boolean | undefined;
  readonly actorId?: string | undefined;
  readonly targetUserId?: string | undefined;
  readonly accountId?: string | undefined;
  readonly sinceHours?: number | undefined;
  readonly limit?: number | undefined;
}

function toQuery(f: AuditFilter): string {
  const p = new URLSearchParams();
  if (f.action) p.set("action", f.action);
  if (f.asAdmin !== undefined) p.set("asAdmin", String(f.asAdmin));
  if (f.actorId) p.set("actorId", f.actorId);
  if (f.targetUserId) p.set("targetUserId", f.targetUserId);
  if (f.accountId) p.set("accountId", f.accountId);
  if (f.sinceHours) p.set("sinceHours", String(f.sinceHours));
  if (f.limit) p.set("limit", String(f.limit));
  const s = p.toString();
  return s ? `?${s}` : "";
}

export const adminAuditApi = {
  list: (filter: AuditFilter = {}) =>
    api.get(`/v1/admin/audit${toQuery(filter)}`, auditListSchema),
  actionCounts: (hours: number) =>
    api.get(
      `/v1/admin/audit/action-counts?hours=${hours}`,
      actionCountsListSchema
    ),
};
