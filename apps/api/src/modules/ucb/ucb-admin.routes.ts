/**
 * Admin-only UCB debug surface: compute the canonical server positions for any
 * account/email ON DEMAND (full enrichment, flag forced on) and return them for
 * the admin "UCB Server" page. Read-only — writes a ucb_shadow_results row as a
 * side effect of computing (same as the worker), but serves nothing to users.
 *
 *   POST /v1/admin/ucb/compute   { account, methodology? } → per-account positions
 *
 * Behind `requireAdminOrImpersonator` (same guard as the golden admin API).
 */
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

import type { Database } from "@cap-flow/db";
import type { LotMethodology } from "@cap-flow/ucb/lots/types";

import type { AccountsRepository } from "../accounts/accounts.repository.js";
import type { AuthRepository } from "../auth/auth.repository.js";

import { buildUcbRunnerStackFromDb, type UcbStackEnv } from "./ucb-runner.factory.js";
import { GoldenRepository } from "../golden/golden.repository.js";
import { AdminAllPositionsService } from "./admin-all-positions.service.js";
import {
  matchCanonical,
  runPostPortChecks,
  type CanonicalPosition,
  type GoldenCaseView,
} from "../anomaly/post_port_checks.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
function toCanonical(raw: unknown[]): CanonicalPosition[] {
  return raw.map((r: any) => ({
    id: String(r.id ?? ""),
    walletId: String(r.walletId ?? ""),
    chain: String(r.chain ?? ""),
    protocol: { id: String(r.protocol?.id ?? r.protocol?.name ?? "") },
    lpTokenId: r.lpTokenId ?? null,
    matchedV3TokenId: r.matchedV3TokenId ?? null,
    openHash: r.openHash ?? null,
    startUsd: Number(r.startUsd ?? 0),
    currentUsd: Number(r.currentUsd ?? 0),
    netPnlUsd: Number(r.netPnlUsd ?? 0),
    coverageIncomplete: Boolean(r.coverageIncomplete),
  }));
}
/* eslint-enable @typescript-eslint/no-explicit-any */

function toGoldenView(rows: {
  id: string; walletId: string; chain: string; protocolId: string;
  marketKey: string | null; openHash: string | null; label: string;
  kind: string; status: string; expectedStartUsd: string | null;
  toleranceAbsUsd: string; tolerancePct: string;
}[]): GoldenCaseView[] {
  return rows.map((g) => ({
    id: g.id, walletId: g.walletId, chain: g.chain, protocolId: g.protocolId,
    marketKey: g.marketKey, openHash: g.openHash, label: g.label, kind: g.kind,
    status: g.status,
    expectedStartUsd: g.expectedStartUsd == null ? null : Number(g.expectedStartUsd),
    toleranceAbsUsd: Number(g.toleranceAbsUsd), tolerancePct: Number(g.tolerancePct),
  }));
}

const computeBody = z.object({
  account: z.string().min(1).max(200), // accountId (uuid) OR owner email
  methodology: z.enum(["FIFO", "LIFO", "WAC", "HIFO"]).default("FIFO"),
});

const alwaysOn = { enabled: async () => true };

export interface UcbAdminRoutesOptions {
  db: Database;
  env: UcbStackEnv;
  accountsRepo: AccountsRepository;
  authRepo: AuthRepository;
}

export async function ucbAdminRoutes(
  app: FastifyInstance,
  opts: UcbAdminRoutesOptions,
): Promise<void> {
  const route = app.withTypeProvider<ZodTypeProvider>();
  route.addHook("preHandler", app.requireAdminOrImpersonator);

  const allPositions = new AdminAllPositionsService(opts.db);

  // Global registry: every account's latest canonical positions + open anomalies.
  route.get("/all-positions", async () => allPositions.list());

  route.post("/compute", { schema: { body: computeBody } }, async (req) => {
    const { account, methodology } = req.body;

    // Resolve to one or more account ids (uuid → that account; else email → owner's).
    const targets: { id: string; label: string }[] = [];
    if (/^[0-9a-f-]{36}$/i.test(account)) {
      const a = await opts.accountsRepo.findById(account);
      if (a) targets.push({ id: a.id, label: `account ${a.id.slice(0, 8)}` });
    } else {
      const user = await opts.authRepo.findUserByEmail(account);
      if (user) {
        for (const a of await opts.accountsRepo.findActiveByOwner(user.id)) {
          targets.push({ id: a.id, label: `account ${a.id.slice(0, 8)}` });
        }
      }
    }
    if (targets.length === 0) {
      return { methodology, accounts: [], notFound: true };
    }

    const stack = buildUcbRunnerStackFromDb(opts.db, opts.env, {
      flags: alwaysOn,
      engineVersion: "admin-compute",
      lotMethodology: methodology as LotMethodology,
    });
    const goldenRepo = new GoldenRepository(opts.db);

    const results: Array<{
      accountId: string;
      label: string;
      positionCount: number;
      positions: unknown[];
      golden?: Record<string, { label: string; expectedStartUsd: number; drift: boolean }>;
      findings?: unknown[];
      error?: string;
    }> = [];

    for (const t of targets) {
      try {
        // Warm the op-price cache so cost basis uses block-fixed prices.
        const wallets = await stack.opsRepo.loadComputeWalletsForAccount(t.id);
        const ops = wallets.flatMap((w) => w.ops);
        const { missing } = await stack.opPricingService.priceMapForOps(ops);
        if (missing.length > 0) await stack.opPricingService.fillMissing(missing);

        const run = await stack.runner.run(t.id, "manual");
        if (run.error) {
          results.push({ accountId: t.id, label: t.label, positionCount: 0, positions: [], error: run.error });
          continue;
        }
        const latest = await stack.shadowRepo.findLatestForAccount(t.id);
        const positions = (latest?.positions as unknown[]) ?? [];

        // Golden overlay + detector findings (display only — not persisted here).
        const goldenRows: Parameters<typeof toGoldenView>[0] = [];
        for (const w of wallets) {
          goldenRows.push(...(await goldenRepo.listGolden({ walletId: w.wallet.id })));
        }
        const canonical = toCanonical(positions);
        const goldenView = toGoldenView(goldenRows);
        const findings = runPostPortChecks(canonical, goldenView);
        const driftIds = new Set(
          findings.filter((f) => f.checkId === "golden_case_drift").map((f) => f.positionId),
        );
        const golden: Record<string, { label: string; expectedStartUsd: number; drift: boolean }> = {};
        for (const g of goldenView) {
          if (g.kind !== "golden" || g.status !== "active" || g.expectedStartUsd == null) continue;
          const p = matchCanonical(g, canonical);
          if (p) golden[p.id] = { label: g.label, expectedStartUsd: g.expectedStartUsd, drift: driftIds.has(p.id) };
        }
        results.push({
          accountId: t.id,
          label: t.label,
          positionCount: positions.length,
          positions,
          golden,
          findings: findings.map((f) => ({
            checkId: f.checkId,
            severity: f.severity,
            positionId: f.positionId ?? null,
            observedValue: f.observedValue,
            expectedValue: f.expectedValue,
            reason: (f.detail as { reason?: string }).reason ?? "",
          })),
        });
      } catch (e) {
        results.push({
          accountId: t.id,
          label: t.label,
          positionCount: 0,
          positions: [],
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    return { methodology, accounts: results };
  });
}
