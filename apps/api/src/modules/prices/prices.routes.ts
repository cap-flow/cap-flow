import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

import { UnauthorizedError } from "../../core/errors.js";
import type { AccountsService } from "../accounts/accounts.service.js";

import type { PricesService } from "./prices.service.js";

const paramsSchema = z.object({
  id: z.string().uuid(),
  symbol: z.string().min(1).max(20).toUpperCase(),
});

const priceResponseSchema = z.object({
  symbol: z.string(),
  coingeckoId: z.string(),
  resolvedFrom: z.string(),
  priceUsd: z.number(),
  fetchedAt: z.string().datetime(),
  source: z.string(),
});

interface PricesRoutesOptions {
  readonly prices: PricesService;
  readonly accounts: AccountsService;
}

export async function pricesRoutes(
  app: FastifyInstance,
  opts: PricesRoutesOptions
): Promise<void> {
  const route = app.withTypeProvider<ZodTypeProvider>();
  route.addHook("preHandler", app.requireAuth);

  // Mounted under `/accounts/:id/prices/...` so tenant context is implicit.
  route.get(
    "/:symbol",
    {
      schema: {
        params: paramsSchema,
        response: { 200: priceResponseSchema },
      },
      config: {
        // Tight per-IP cap on top of the per-user quota — defence in depth.
        rateLimit: { max: 60, timeWindow: "1 minute" },
      },
    },
    async (req) => {
      const u = req.user;
      if (!u) throw new UnauthorizedError();

      // Tenant check — confirms the user owns (or admins) this account.
      const account = await opts.accounts.getById(req.params.id, u);

      const quote = await opts.prices.getCurrent(
        req.params.symbol,
        account.id,
        u.id,
        {
          ip: req.ip ?? null,
          userAgent: req.headers["user-agent"] ?? null,
        }
      );
      return quote;
    }
  );
}
