/**
 * Admin anomaly detector surface (Epic C):
 *   POST /v1/admin/anomaly/scan   { account } → run the post-port detector on
 *     demand for an accountId/email, persisting findings to anomaly_flags.
 *   GET  /v1/admin/anomaly/flags?accountId=&status=  → list flags.
 *
 * Behind requireAdminOrImpersonator. The continuous BullMQ sweep is a follow-up;
 * this is the manual trigger + the C6 report surface.
 */
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

import { type Database } from "@cap-flow/db";

import type { AccountsRepository } from "../accounts/accounts.repository.js";
import type { AuthRepository } from "../auth/auth.repository.js";
import { WalletsRepository } from "../wallets/wallets.repository.js";
import { UcbShadowRepository } from "../ucb/ucb-shadow.repository.js";
import { GoldenRepository } from "../golden/golden.repository.js";

import { AnomalyFlagsRepository } from "./anomaly-flags.repository.js";
import { AnomalyDetectorService } from "./anomaly-detector.service.js";

const DETECTOR_VERSION = "detector@dev";

const scanBody = z.object({ account: z.string().min(1).max(200) });
const flagsQuery = z.object({
  accountId: z.string().uuid().optional(),
  status: z.enum(["open", "acknowledged", "resolved", "promoted"]).optional(),
});

export interface AnomalyAdminRoutesOptions {
  db: Database;
  accountsRepo: AccountsRepository;
  authRepo: AuthRepository;
}

export async function anomalyAdminRoutes(
  app: FastifyInstance,
  opts: AnomalyAdminRoutesOptions,
): Promise<void> {
  const route = app.withTypeProvider<ZodTypeProvider>();
  route.addHook("preHandler", app.requireAdminOrImpersonator);

  const walletsRepo = new WalletsRepository(opts.db);
  const flagsRepo = new AnomalyFlagsRepository(opts.db);
  const detector = new AnomalyDetectorService({
    shadowRepo: new UcbShadowRepository(opts.db),
    goldenRepo: new GoldenRepository(opts.db),
    flagsRepo,
    walletIdsForAccount: async (accountId) =>
      (await walletsRepo.listByAccount(accountId)).map((w) => w.id),
    detectorVersion: DETECTOR_VERSION,
  });

  route.post("/scan", { schema: { body: scanBody } }, async (req) => {
    const { account } = req.body;
    const ids: string[] = [];
    if (/^[0-9a-f-]{36}$/i.test(account)) {
      const a = await opts.accountsRepo.findById(account);
      if (a) ids.push(a.id);
    } else {
      const user = await opts.authRepo.findUserByEmail(account);
      if (user) for (const a of await opts.accountsRepo.findActiveByOwner(user.id)) ids.push(a.id);
    }
    if (ids.length === 0) return { notFound: true, accounts: [] };
    const results = [];
    for (const id of ids) {
      results.push({ accountId: id, ...(await detector.scanAccount(id)) });
    }
    return { accounts: results };
  });

  route.get("/flags", { schema: { querystring: flagsQuery } }, async (req) => {
    const rows = await flagsRepo.list({
      ...(req.query.accountId && { accountId: req.query.accountId }),
      ...(req.query.status && { status: req.query.status }),
    });
    return { flags: rows };
  });
}
