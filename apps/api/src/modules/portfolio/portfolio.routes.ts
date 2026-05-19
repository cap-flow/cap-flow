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

const historyResponseSchema = z.object({
  accountId: z.string().uuid(),
  /** Granularity hint for the chart. "hour" for short periods, "day" for long. */
  granularity: z.enum(["hour", "day"]),
  points: z.array(
    z.object({
      t: z.number(), // unix ms
      totalUsd: z.number(),
    })
  ),
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

/**
 * Bucket-and-pick downsampling: split time-range into `target` slots and
 * take the LAST observation in each. Preserves the rightmost edge of
 * the series (most-recent point). O(n).
 */
function downsample<T extends { t: number }>(arr: T[], target: number): T[] {
  if (arr.length === 0 || target <= 0) return arr;
  const first = arr[0]!.t;
  const last = arr[arr.length - 1]!.t;
  if (last <= first) return arr;
  const slot = (last - first) / target;
  const buckets = new Map<number, T>();
  for (const p of arr) {
    const idx = Math.min(target - 1, Math.floor((p.t - first) / slot));
    buckets.set(idx, p); // overwrite → keep the latest in each slot
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, v]) => v);
}

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
        // Pre-prod (2026-05-18, security-hardening): restored production
        // ceiling. Manual portfolio refresh fans out into DeBank /
        // Alchemy / Helius calls that hit admin-paid quotas — a tight
        // per-user cap blocks both runaway clients and intentional
        // quota-burn. Admin/QA can still hammer via /upstream/* directly
        // (subject to upstream-proxy rate-limit).
        rateLimit: { max: 10, timeWindow: "1 minute" },
      },
    },
    async (req, reply) => {
      const u = req.user;
      if (!u) throw new UnauthorizedError();
      const account = await opts.accounts.getById(req.params.id, u);

      // H4 (2026-05-14): restored subscription-expired gate.
      //
      // Admin bypasses (ops access + they implicitly pay). For everyone
      // else, only `status === "expired"` (past graceDays) blocks —
      // `active` and `grace` both still allow refresh so we nudge
      // gently before cutting off.
      //
      // Impersonation: when an admin is acting-as-user we keep the
      // bypass — otherwise debugging an expired user's portfolio is
      // impossible.
      const isAdminContext =
        u.role === "admin" || !!u.impersonation;
      if (!isAdminContext) {
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

  /**
   * H17 (2026-05-14): TVL historical chart endpoint.
   *
   * Returns `[{t, totalUsd}]` points for the last `days` days. Server
   * downsamples to ≤ 200 points to keep payloads small and Recharts
   * snappy. Granularity hint lets the frontend pick a sensible x-axis
   * tick format.
   */
  route.get(
    "/:id/history",
    {
      schema: {
        params: idParam,
        querystring: z.object({
          days: z.coerce.number().int().positive().max(365).default(30),
        }),
        response: { 200: historyResponseSchema },
      },
    },
    async (req) => {
      const u = req.user;
      if (!u) throw new UnauthorizedError();
      const account = await opts.accounts.getById(req.params.id, u);
      const days = req.query.days;
      const since = new Date(Date.now() - days * 86_400_000);

      const snaps = await opts.portfolio.snapshotsSince(account.id, since);

      // Extract totalUsd from `metrics` JSON. Missing/non-numeric → skip.
      // Snapshots written before metrics had `totalUsd` are silently
      // dropped from the series so the chart doesn't dip to 0.
      const raw: Array<{ t: number; totalUsd: number }> = [];
      for (const s of snaps) {
        const m = s.metrics as { totalUsd?: unknown } | null;
        const v = m && typeof m.totalUsd === "number" ? m.totalUsd : null;
        if (v === null || !Number.isFinite(v)) continue;
        raw.push({ t: s.createdAt.getTime(), totalUsd: v });
      }

      // Downsample: keep ≤200 points. For 30d at 1pt/hr we'd have 720
      // points → reduce 3-4×. Strategy: bucket the time-range into N
      // equal slots, take the LAST point inside each slot (so the chart
      // shows the most recent value, which matches user intuition).
      const TARGET = 200;
      const points =
        raw.length <= TARGET ? raw : downsample(raw, TARGET);

      const granularity: "day" | "hour" = days > 7 ? "day" : "hour";
      return {
        accountId: account.id,
        granularity,
        points,
      };
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
