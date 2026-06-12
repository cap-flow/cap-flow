/**
 * B5 — POST /accounts/:id/ucb/shadow-diff.
 *
 * The browser POSTs its own computed positions; the server diffs them against
 * the account's latest server shadow (ucb_shadow_results), persists the summary
 * onto that row, and returns it. Auth + account-ownership via the standard
 * pattern (requireAuth preHandler + accounts.getById, which throws unless the
 * caller owns the account or is admin). Body is loose `positions[]` — this is an
 * internal observability surface, not a public contract.
 */
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

import type { OpenPosition } from "@cap-flow/ucb/open_positions";

import { UnauthorizedError } from "../../core/errors.js";
import type { AccountsService } from "../accounts/accounts.service.js";
import type { Database } from "@cap-flow/db";

import { runShadowDiff } from "./ucb-shadow-diff.handler.js";
import type { UcbShadowRepository } from "./ucb-shadow.repository.js";
import { decideServePositions } from "./ucb-serve-positions.js";
import {
  buildUcbRunnerStackFromDb,
  type UcbStackEnv,
} from "./ucb-runner.factory.js";
import { AccountsRepository } from "../accounts/accounts.repository.js";
import {
  LotMethodologyRepository,
  coerceMethodology,
} from "../preferences/lot-methodology.repository.js";

const idParam = z.object({ id: z.string().uuid() });
const shadowDiffBody = z.object({ positions: z.array(z.unknown()) });

/** B6 per-user serving flag (default OFF). Distinct from the B5 compute flag. */
export const UCB_SERVER_CANONICAL_FLAG = "capflow.feature.ucbServerCanonical";

/** Resolves whether a feature flag is enabled for a given user/account. */
export interface FlagResolverLike {
  enabled(
    key: string,
    ctx: { userId?: string | null; accountId?: string | null },
  ): Promise<boolean>;
}

/** Reads the account's latest portfolio snapshot time (freshness gate). */
export interface SnapshotTimeSource {
  latestSnapshot(accountId: string): Promise<{ createdAt: Date } | null>;
}

export interface UcbRoutesOptions {
  accounts: AccountsService;
  shadowRepo: Pick<
    UcbShadowRepository,
    "findLatestForAccount" | "updateDiffSummary"
  >;
  /** B6: per-user canonical-serving flag resolver. */
  featureFlags: FlagResolverLike;
  /** B6: snapshot freshness source. */
  portfolioRepo: SnapshotTimeSource;
  /**
   * Для POST /:id/ucb/recompute (server-only UX): on-demand пересчёт аккаунта
   * под сохранённой методикой владельца. db+env — для runner-стека (как в
   * admin-роутах). Отсутствуют → роут recompute не регистрируется (тесты).
   */
  db?: Database;
  env?: UcbStackEnv;
}

export async function ucbRoutes(
  app: FastifyInstance,
  opts: UcbRoutesOptions,
): Promise<void> {
  const route = app.withTypeProvider<ZodTypeProvider>();
  route.addHook("preHandler", app.requireAuth);

  route.post(
    "/:id/ucb/shadow-diff",
    { schema: { params: idParam, body: shadowDiffBody } },
    async (req) => {
      const u = req.user;
      if (!u) throw new UnauthorizedError();
      // Throws Forbidden/NotFound unless the caller owns this account (or admin).
      const account = await opts.accounts.getById(req.params.id, u);
      return runShadowDiff(
        { shadowRepo: opts.shadowRepo },
        account.id,
        req.body.positions as unknown as readonly OpenPosition[],
      );
    },
  );

  // B6: serve the server-computed canonical positions (flag-gated, default OFF).
  // The client adopts these only when `serve` is true and keeps its own recompute
  // as a permanent fallback (R16). A read-only, account-owner-scoped surface.
  route.get(
    "/:id/ucb/positions",
    { schema: { params: idParam } },
    async (req) => {
      const u = req.user;
      if (!u) throw new UnauthorizedError();
      const account = await opts.accounts.getById(req.params.id, u);
      const [flagEnabled, shadow, snapshot] = await Promise.all([
        opts.featureFlags.enabled(UCB_SERVER_CANONICAL_FLAG, {
          userId: u.id,
          accountId: account.id,
        }),
        opts.shadowRepo.findLatestForAccount(account.id),
        opts.portfolioRepo.latestSnapshot(account.id),
      ]);
      return decideServePositions({
        flagEnabled,
        shadow,
        latestSnapshotAt: snapshot?.createdAt ?? null,
      });
    },
  );

  // Server-only UX (2026-06-12): on-demand пересчёт аккаунта на сервере.
  // Нужен для мгновенной реакции на переключение FIFO/LIFO/WAC — без него
  // server-only режим показывает пусто до следующего worker-refresh.
  // Методика берётся из users.lot_methodology владельца (methodologyResolver),
  // поэтому вызывать ПОСЛЕ PUT /v1/me/lot-methodology. In-flight lock —
  // конкурентные клики ждут один и тот же прогон, не плодят DeBank-фетчи.
  if (opts.db && opts.env) {
    const db = opts.db;
    const accountsRepo = new AccountsRepository(db);
    const methRepo = new LotMethodologyRepository(db);
    const stack = buildUcbRunnerStackFromDb(db, opts.env, {
      flags: {
        enabled: (key, ctx) =>
          opts.featureFlags.enabled(key, { accountId: ctx.accountId ?? null }),
      },
      engineVersion: "user-recompute",
      methodologyResolver: {
        forAccount: async (accountId) => {
          const a = await accountsRepo.findById(accountId);
          if (!a) return "FIFO";
          return coerceMethodology(await methRepo.get(a.ownerId));
        },
      },
    });
    const inflight = new Map<string, Promise<{ positionCount: number | null; error: string | null }>>();

    route.post(
      "/:id/ucb/recompute",
      { schema: { params: idParam } },
      async (req) => {
        const u = req.user;
        if (!u) throw new UnauthorizedError();
        const account = await opts.accounts.getById(req.params.id, u);
        const existing = inflight.get(account.id);
        if (existing) return existing;
        const job = (async () => {
          try {
            // Дозаполнить кэш hist-цен перед прогоном (как admin compute).
            const wallets = await stack.opsRepo.loadComputeWalletsForAccount(
              account.id,
            );
            const ops = wallets.flatMap((w) => w.ops);
            const { missing } = await stack.opPricingService.priceMapForOps(ops);
            if (missing.length > 0)
              await stack.opPricingService.fillMissing(missing);
            const run = await stack.runner.run(account.id, "manual");
            return {
              positionCount: run.positionCount ?? null,
              error: run.error ?? (run.skipped ? "shadow flag off" : null),
            };
          } finally {
            inflight.delete(account.id);
          }
        })();
        inflight.set(account.id, job);
        return job;
      },
    );
  }
}
