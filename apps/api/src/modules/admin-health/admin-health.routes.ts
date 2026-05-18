/**
 * F3: admin health observability.
 *
 * Aggregates сигналы из разных subsystems в один JSON для admin UI:
 *   - DB pool stats (capacity / idle / waiting)
 *   - Redis ping latency
 *   - BullMQ queue depths (portfolio-refresh + payment-monitor)
 *   - Wallet sync state (total / with errors / oldest sync)
 *   - CEX account state (total / with errors)
 *   - Process uptime + node version
 *
 * Admin-only через requireAdmin hook. Каждый сектор fail-soft: если
 * subsystem недоступен — ставим status='error' и продолжаем.
 */
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { Redis } from "ioredis";
import { z } from "zod";

import type { Database } from "@cap-flow/db";
import { schema } from "@cap-flow/db";
import { count, eq, isNotNull, sql } from "drizzle-orm";

import type { PortfolioRefreshQueue } from "../queue/portfolio-refresh.queue.js";

const sectionStatusSchema = z.enum(["ok", "warn", "error"]);
type SectionStatus = z.infer<typeof sectionStatusSchema>;

const healthResponseSchema = z.object({
  ok: z.boolean(),
  overallStatus: sectionStatusSchema,
  generatedAt: z.string().datetime(),
  uptimeSec: z.number(),
  nodeVersion: z.string(),
  db: z.object({
    status: sectionStatusSchema,
    poolTotal: z.number().nullable(),
    poolIdle: z.number().nullable(),
    poolWaiting: z.number().nullable(),
    pingMs: z.number().nullable(),
    error: z.string().nullable(),
  }),
  redis: z.object({
    status: sectionStatusSchema,
    pingMs: z.number().nullable(),
    error: z.string().nullable(),
  }),
  queue: z.object({
    status: sectionStatusSchema,
    counts: z.object({
      active: z.number(),
      waiting: z.number(),
      delayed: z.number(),
      completed: z.number(),
      failed: z.number(),
    }),
    error: z.string().nullable(),
  }),
  wallets: z.object({
    status: sectionStatusSchema,
    total: z.number(),
    withErrors: z.number(),
    oldestSyncIso: z.string().nullable(),
  }),
  cexAccounts: z.object({
    status: sectionStatusSchema,
    total: z.number(),
    withErrors: z.number(),
  }),
});

interface AdminHealthRoutesOptions {
  readonly db: Database;
  readonly redis: Redis;
  readonly queue: PortfolioRefreshQueue;
}

function worst(...statuses: SectionStatus[]): SectionStatus {
  if (statuses.includes("error")) return "error";
  if (statuses.includes("warn")) return "warn";
  return "ok";
}

export async function adminHealthRoutes(
  app: FastifyInstance,
  opts: AdminHealthRoutesOptions,
): Promise<void> {
  const route = app.withTypeProvider<ZodTypeProvider>();
  route.addHook("preHandler", app.requireAdmin);

  route.get(
    "/health",
    { schema: { response: { 200: healthResponseSchema } } },
    async () => {
      const generatedAt = new Date().toISOString();
      const uptimeSec = Math.floor(process.uptime());
      const nodeVersion = process.version;

      // ─── DB section ───────────────────────────────────────────────
      const db = await checkDb(opts.db);

      // ─── Redis section ────────────────────────────────────────────
      const redis = await checkRedis(opts.redis);

      // ─── Queue section ────────────────────────────────────────────
      const queue = await checkQueue(opts.queue);

      // ─── Wallets section ──────────────────────────────────────────
      const wallets = await checkWallets(opts.db);

      // ─── CEX section ──────────────────────────────────────────────
      const cexAccounts = await checkCex(opts.db);

      const overall = worst(
        db.status,
        redis.status,
        queue.status,
        wallets.status,
        cexAccounts.status,
      );
      return {
        ok: overall === "ok",
        overallStatus: overall,
        generatedAt,
        uptimeSec,
        nodeVersion,
        db,
        redis,
        queue,
        wallets,
        cexAccounts,
      };
    },
  );
}

async function checkDb(db: Database): Promise<{
  status: SectionStatus;
  poolTotal: number | null;
  poolIdle: number | null;
  poolWaiting: number | null;
  pingMs: number | null;
  error: string | null;
}> {
  const start = Date.now();
  try {
    await db.execute(sql`select 1 as ok`);
    const pingMs = Date.now() - start;
    // Drizzle exposes underlying pg pool через client. Шейп зависит от драйвера —
    // ловим best-effort через `(db as any).$client.pool` для node-postgres.
    const dbAny = db as unknown as {
      $client?: { totalCount?: number; idleCount?: number; waitingCount?: number };
    };
    const pool = dbAny.$client;
    return {
      status: pingMs > 1000 ? "warn" : "ok",
      poolTotal: pool?.totalCount ?? null,
      poolIdle: pool?.idleCount ?? null,
      poolWaiting: pool?.waitingCount ?? null,
      pingMs,
      error: null,
    };
  } catch (err) {
    return {
      status: "error",
      poolTotal: null,
      poolIdle: null,
      poolWaiting: null,
      pingMs: null,
      error: err instanceof Error ? err.message.slice(0, 200) : "db error",
    };
  }
}

async function checkRedis(redis: Redis): Promise<{
  status: SectionStatus;
  pingMs: number | null;
  error: string | null;
}> {
  const start = Date.now();
  try {
    await redis.ping();
    const pingMs = Date.now() - start;
    return {
      status: pingMs > 500 ? "warn" : "ok",
      pingMs,
      error: null,
    };
  } catch (err) {
    return {
      status: "error",
      pingMs: null,
      error: err instanceof Error ? err.message.slice(0, 200) : "redis error",
    };
  }
}

async function checkQueue(queue: PortfolioRefreshQueue): Promise<{
  status: SectionStatus;
  counts: {
    active: number;
    waiting: number;
    delayed: number;
    completed: number;
    failed: number;
  };
  error: string | null;
}> {
  try {
    const c = await queue.queue.getJobCounts(
      "active",
      "waiting",
      "delayed",
      "completed",
      "failed",
    );
    const counts = {
      active: c.active ?? 0,
      waiting: c.waiting ?? 0,
      delayed: c.delayed ?? 0,
      completed: c.completed ?? 0,
      failed: c.failed ?? 0,
    };
    // Heuristics: failed > 10 = warn; failed > 100 OR waiting > 1000 = error.
    let status: SectionStatus = "ok";
    if (counts.failed > 100 || counts.waiting > 1000) status = "error";
    else if (counts.failed > 10 || counts.waiting > 200) status = "warn";
    return { status, counts, error: null };
  } catch (err) {
    return {
      status: "error",
      counts: { active: 0, waiting: 0, delayed: 0, completed: 0, failed: 0 },
      error: err instanceof Error ? err.message.slice(0, 200) : "queue error",
    };
  }
}

async function checkWallets(db: Database): Promise<{
  status: SectionStatus;
  total: number;
  withErrors: number;
  oldestSyncIso: string | null;
}> {
  try {
    const totalRows = await db
      .select({ n: count() })
      .from(schema.wallets);
    const total = Number(totalRows[0]?.n ?? 0);

    const errRows = await db
      .select({ n: count() })
      .from(schema.wallets)
      .where(isNotNull(schema.wallets.lastOpsSyncError));
    const withErrors = Number(errRows[0]?.n ?? 0);

    const oldestRows = await db
      .select({ ts: sql<Date | null>`min(${schema.wallets.lastOpsSyncAt})` })
      .from(schema.wallets);
    const oldestTs = oldestRows[0]?.ts ?? null;

    const errPct = total > 0 ? withErrors / total : 0;
    let status: SectionStatus = "ok";
    if (errPct >= 0.5) status = "error";
    else if (errPct >= 0.1) status = "warn";

    return {
      status,
      total,
      withErrors,
      oldestSyncIso: oldestTs ? new Date(oldestTs).toISOString() : null,
    };
  } catch (err) {
    return {
      status: "error",
      total: 0,
      withErrors: 0,
      oldestSyncIso: null,
    };
  }
}

async function checkCex(db: Database): Promise<{
  status: SectionStatus;
  total: number;
  withErrors: number;
}> {
  try {
    const totalRows = await db
      .select({ n: count() })
      .from(schema.cexAccounts)
      .where(eq(schema.cexAccounts.archivedAt, sql`NULL` as unknown as Date));
    const total = Number(totalRows[0]?.n ?? 0);

    const errRows = await db
      .select({ n: count() })
      .from(schema.cexAccounts)
      .where(isNotNull(schema.cexAccounts.lastSyncError));
    const withErrors = Number(errRows[0]?.n ?? 0);

    const errPct = total > 0 ? withErrors / total : 0;
    let status: SectionStatus = "ok";
    if (errPct >= 0.5) status = "error";
    else if (errPct >= 0.1) status = "warn";

    return { status, total, withErrors };
  } catch (err) {
    return { status: "error", total: 0, withErrors: 0 };
  }
}
