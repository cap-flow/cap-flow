import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

import { ForbiddenError, UnauthorizedError } from "../../core/errors.js";
import type { AccountsService } from "../accounts/accounts.service.js";
import type { BillingService } from "../billing/billing.service.js";
import type { PortfolioRefreshQueue } from "../queue/portfolio-refresh.queue.js";

import type { IPortfolioRepository } from "./portfolio.repository.js";

const idParam = z.object({ id: z.string().uuid() });

const refreshResponseSchema = z.object({
  jobId: z.string(),
  accountId: z.string().uuid(),
});

const statusResponseSchema = z.object({
  accountId: z.string().uuid(),
  lastSnapshot: z
    .object({
      id: z.string().uuid(),
      date: z.string(),
      createdAt: z.string().datetime(),
      metrics: z.unknown(),
    })
    .nullable(),
  recentJobs: z.array(
    z.object({
      id: z.string(),
      state: z.string(),
      trigger: z.string(),
      timestamp: z.number().nullable(),
      finishedOn: z.number().nullable(),
      failedReason: z.string().nullable(),
    })
  ),
});

interface PortfolioRoutesOptions {
  readonly accounts: AccountsService;
  readonly portfolio: IPortfolioRepository;
  readonly queue: PortfolioRefreshQueue;
  readonly billing: BillingService;
}

export async function portfolioRoutes(
  app: FastifyInstance,
  opts: PortfolioRoutesOptions
): Promise<void> {
  const route = app.withTypeProvider<ZodTypeProvider>();
  route.addHook("preHandler", app.requireAuth);

  /**
   * Trigger a manual refresh for an account.
   *
   * Phase 4 policy: users *can* trigger their own refresh. Tightening that
   * to admin-only later is a one-line check here.
   */
  route.post(
    "/:id/refresh",
    {
      schema: {
        params: idParam,
        response: { 202: refreshResponseSchema },
      },
      config: {
        // Each manual refresh consumes upstream API calls; keep the per-IP
        // ceiling tight so a runaway client can't loop on this endpoint.
        rateLimit: { max: 10, timeWindow: "1 minute" },
      },
    },
    async (req, reply) => {
      const u = req.user;
      if (!u) throw new UnauthorizedError();
      const account = await opts.accounts.getById(req.params.id, u);

      // Phase 8: gate manual refresh on subscription. Admins are never
      // blocked (they pay implicitly + need ops access). For others,
      // `expired` (past grace) is the only state that fails — `grace`
      // still lets them keep working while we nudge them to pay.
      if (u.role !== "admin") {
        const sub = await opts.billing.getSubscription(account.ownerId);
        if (sub.status === "expired") {
          throw new ForbiddenError(
            "Subscription expired — top up to resume manual refresh."
          );
        }
      }

      const trigger: "admin" | "user" = u.role === "admin" ? "admin" : "user";
      const jobId = await opts.queue.enqueueManual(account.id, u.id, trigger);
      return reply.status(202).send({ jobId, accountId: account.id });
    }
  );

  route.get(
    "/:id/refresh-status",
    {
      schema: {
        params: idParam,
        response: { 200: statusResponseSchema },
      },
    },
    async (req) => {
      const u = req.user;
      if (!u) throw new UnauthorizedError();
      const account = await opts.accounts.getById(req.params.id, u);
      const [snap, jobs] = await Promise.all([
        opts.portfolio.latestSnapshot(account.id),
        opts.queue.recentForAccount(account.id, 10),
      ]);
      const recentJobs = await Promise.all(
        jobs.map(async (j) => ({
          id: j.id ?? "unknown",
          state: await j.getState(),
          trigger: String(j.data.trigger),
          timestamp: j.timestamp ?? null,
          finishedOn: j.finishedOn ?? null,
          failedReason: j.failedReason ?? null,
        }))
      );
      return {
        accountId: account.id,
        lastSnapshot: snap
          ? {
              id: snap.id,
              date: snap.date,
              createdAt: snap.createdAt.toISOString(),
              metrics: snap.metrics,
            }
          : null,
        recentJobs,
      };
    }
  );
}
