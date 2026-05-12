import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

import { UnauthorizedError } from "../../core/errors.js";

import type { BillingService } from "./billing.service.js";

const userIdParamSchema = z.object({ id: z.string().uuid() });

const creditBodySchema = z.object({
  amountUsd: z.number().positive(),
  note: z.string().max(500).optional(),
});

const refundBodySchema = z.object({
  paymentId: z.string().uuid(),
  note: z.string().max(500).optional(),
});

const subscriptionResponseSchema = z.object({
  status: z.enum(["beta", "active", "grace", "expired"]),
  periodEnd: z.string().datetime().nullable(),
  graceUntil: z.string().datetime().nullable(),
  daysLeft: z.number().nullable(),
  plan: z.string().nullable(),
  amountUsd: z.string().nullable(),
});

const paymentRowSchema = z.object({
  id: z.string().uuid(),
  kind: z.string(),
  plan: z.string(),
  amountUsd: z.string(),
  horizonMonths: z.number(),
  paidAt: z.string().datetime(),
  periodEnd: z.string().datetime().nullable(),
  note: z.string().nullable(),
});

interface AdminBillingRoutesOptions {
  readonly service: BillingService;
}

export async function adminBillingRoutes(
  app: FastifyInstance,
  opts: AdminBillingRoutesOptions
): Promise<void> {
  const route = app.withTypeProvider<ZodTypeProvider>();
  route.addHook("preHandler", app.requireAdmin);

  route.get(
    "/:id/billing",
    {
      schema: {
        params: userIdParamSchema,
        response: {
          200: z.object({
            subscription: subscriptionResponseSchema,
            history: z.array(paymentRowSchema),
          }),
        },
      },
    },
    async (req) => {
      const sub = await opts.service.getSubscription(req.params.id);
      const history = await opts.service.getHistory(req.params.id);
      return {
        subscription: {
          status: sub.status,
          periodEnd: sub.periodEnd ? sub.periodEnd.toISOString() : null,
          graceUntil: sub.graceUntil ? sub.graceUntil.toISOString() : null,
          daysLeft: sub.daysLeft,
          plan: sub.latestPayment?.plan ?? null,
          amountUsd: sub.latestPayment?.amountUsd ?? null,
        },
        history: history.map((r) => ({
          id: r.id,
          kind: r.kind,
          plan: r.plan,
          amountUsd: r.amountUsd,
          horizonMonths: r.horizonMonths,
          paidAt: r.paidAt.toISOString(),
          periodEnd: r.periodEnd ? r.periodEnd.toISOString() : null,
          note: r.note,
        })),
      };
    }
  );

  route.post(
    "/:id/billing/credit",
    {
      schema: {
        params: userIdParamSchema,
        body: creditBodySchema,
        response: { 201: paymentRowSchema },
      },
    },
    async (req, reply) => {
      const u = req.user;
      if (!u) throw new UnauthorizedError();
      const row = await opts.service.creditManual({
        userId: req.params.id,
        amountUsd: req.body.amountUsd,
        ...(req.body.note ? { note: req.body.note } : {}),
        actorAdminId: u.id,
      });
      return reply.status(201).send({
        id: row.id,
        kind: row.kind,
        plan: row.plan,
        amountUsd: row.amountUsd,
        horizonMonths: row.horizonMonths,
        paidAt: row.paidAt.toISOString(),
        periodEnd: row.periodEnd ? row.periodEnd.toISOString() : null,
        note: row.note,
      });
    }
  );

  route.post(
    "/:id/billing/refund",
    {
      schema: {
        params: userIdParamSchema,
        body: refundBodySchema,
        response: { 201: paymentRowSchema },
      },
    },
    async (req, reply) => {
      const u = req.user;
      if (!u) throw new UnauthorizedError();
      const row = await opts.service.refundForUser({
        userId: req.params.id,
        paymentId: req.body.paymentId,
        ...(req.body.note ? { note: req.body.note } : {}),
        actorAdminId: u.id,
      });
      return reply.status(201).send({
        id: row.id,
        kind: row.kind,
        plan: row.plan,
        amountUsd: row.amountUsd,
        horizonMonths: row.horizonMonths,
        paidAt: row.paidAt.toISOString(),
        periodEnd: row.periodEnd ? row.periodEnd.toISOString() : null,
        note: row.note,
      });
    }
  );
}
