import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

import type { AdminAuditService, AuditFilter } from "./admin-audit.service.js";

const listFilterSchema = z.object({
  actorId: z.string().uuid().optional(),
  targetUserId: z.string().uuid().optional(),
  action: z.string().max(80).optional(),
  asAdmin: z.coerce.boolean().optional(),
  accountId: z.string().uuid().optional(),
  sinceHours: z.coerce.number().int().positive().max(24 * 90).optional(),
  limit: z.coerce.number().int().positive().max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

const entryResponseSchema = z.object({
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

const actionsCountSchema = z.array(
  z.object({ action: z.string(), n: z.number() })
);

interface AdminAuditRoutesOptions {
  readonly service: AdminAuditService;
}

export async function adminAuditRoutes(
  app: FastifyInstance,
  opts: AdminAuditRoutesOptions
): Promise<void> {
  const route = app.withTypeProvider<ZodTypeProvider>();
  route.addHook("preHandler", app.requireAdmin);

  route.get(
    "/",
    {
      schema: {
        querystring: listFilterSchema,
        response: { 200: z.array(entryResponseSchema) },
      },
    },
    async (req) => {
      const f: AuditFilter = {
        ...(req.query.actorId ? { actorId: req.query.actorId } : {}),
        ...(req.query.targetUserId
          ? { targetUserId: req.query.targetUserId }
          : {}),
        ...(req.query.action ? { action: req.query.action } : {}),
        ...(req.query.asAdmin !== undefined
          ? { asAdmin: req.query.asAdmin }
          : {}),
        ...(req.query.accountId ? { accountId: req.query.accountId } : {}),
        ...(req.query.sinceHours
          ? {
              since: new Date(
                Date.now() - req.query.sinceHours * 60 * 60 * 1000
              ),
            }
          : {}),
        limit: req.query.limit,
        offset: req.query.offset,
      };

      const rows = await opts.service.list(f);
      return rows.map((r) => ({
        id: r.id,
        actorId: r.actorId,
        asAdmin: r.asAdmin,
        targetUserId: r.targetUserId,
        accountId: r.accountId,
        action: r.action,
        target: r.target,
        payload: r.payload,
        ip: r.ip,
        userAgent: r.userAgent,
        occurredAt: r.occurredAt.toISOString(),
      }));
    }
  );

  route.get(
    "/action-counts",
    {
      schema: {
        querystring: z.object({
          hours: z.coerce.number().int().positive().max(24 * 90).default(24),
        }),
        response: { 200: actionsCountSchema },
      },
    },
    async (req) => {
      const since = new Date(Date.now() - req.query.hours * 60 * 60 * 1000);
      return opts.service.actionCounts(since);
    }
  );
}
