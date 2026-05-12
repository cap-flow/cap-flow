import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

import { UnauthorizedError } from "../../core/errors.js";

import type { BillingService } from "./billing.service.js";

const networkEnum = z.enum(["trc20", "erc20"]);

const subscriptionResponseSchema = z.object({
  status: z.enum(["beta", "active", "grace", "expired"]),
  periodEnd: z.string().datetime().nullable(),
  graceUntil: z.string().datetime().nullable(),
  daysLeft: z.number().nullable(),
  plan: z.string().nullable(),
  amountUsd: z.string().nullable(),
});

const addressResponseSchema = z.object({
  id: z.string().uuid(),
  network: networkEnum,
  address: z.string(),
  createdAt: z.string().datetime(),
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

interface BillingRoutesOptions {
  readonly service: BillingService;
}

export async function billingRoutes(
  app: FastifyInstance,
  opts: BillingRoutesOptions
): Promise<void> {
  const route = app.withTypeProvider<ZodTypeProvider>();
  route.addHook("preHandler", app.requireAuth);

  route.get(
    "/",
    { schema: { response: { 200: subscriptionResponseSchema } } },
    async (req) => {
      const u = req.user;
      if (!u) throw new UnauthorizedError();
      const info = await opts.service.getSubscription(u.id);
      return {
        status: info.status,
        periodEnd: info.periodEnd ? info.periodEnd.toISOString() : null,
        graceUntil: info.graceUntil ? info.graceUntil.toISOString() : null,
        daysLeft: info.daysLeft,
        plan: info.latestPayment?.plan ?? null,
        amountUsd: info.latestPayment?.amountUsd ?? null,
      };
    }
  );

  route.post(
    "/payment-address",
    {
      schema: {
        body: z.object({ network: networkEnum }),
        response: { 200: addressResponseSchema },
      },
    },
    async (req) => {
      const u = req.user;
      if (!u) throw new UnauthorizedError();
      const row = await opts.service.getOrAllocateAddress(
        u.id,
        req.body.network
      );
      return {
        id: row.id,
        network: row.network as "trc20" | "erc20",
        address: row.address,
        createdAt: row.createdAt.toISOString(),
      };
    }
  );

  route.get(
    "/payments",
    { schema: { response: { 200: z.array(paymentRowSchema) } } },
    async (req) => {
      const u = req.user;
      if (!u) throw new UnauthorizedError();
      const rows = await opts.service.getHistory(u.id);
      return rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        plan: r.plan,
        amountUsd: r.amountUsd,
        horizonMonths: r.horizonMonths,
        paidAt: r.paidAt.toISOString(),
        periodEnd: r.periodEnd ? r.periodEnd.toISOString() : null,
        note: r.note,
      }));
    }
  );
}
