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

import { runShadowDiff } from "./ucb-shadow-diff.handler.js";
import type { UcbShadowRepository } from "./ucb-shadow.repository.js";
import { decideServePositions } from "./ucb-serve-positions.js";

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
}
