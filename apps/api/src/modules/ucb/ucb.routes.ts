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

const idParam = z.object({ id: z.string().uuid() });
const shadowDiffBody = z.object({ positions: z.array(z.unknown()) });

export interface UcbRoutesOptions {
  accounts: AccountsService;
  shadowRepo: Pick<
    UcbShadowRepository,
    "findLatestForAccount" | "updateDiffSummary"
  >;
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
}
