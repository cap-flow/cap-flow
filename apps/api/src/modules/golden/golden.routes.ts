/**
 * UCB Epic A3: admin-only REST endpoints for golden cases + anomaly flags.
 *
 *   POST   /v1/admin/golden/cases              — create a golden anchor
 *   GET    /v1/admin/golden/cases?walletId=     — list golden cases
 *   PATCH  /v1/admin/golden/cases/:id           — edit expected/tolerance/status
 *   DELETE /v1/admin/golden/cases/:id           — soft-retire
 *   GET    /v1/admin/golden/anomalies?status=&walletId=
 *   PATCH  /v1/admin/golden/anomalies/:id       — acknowledge / resolve
 *   POST   /v1/admin/golden/anomalies/:id/promote — promote → golden (learning loop)
 *
 * ALL behind `requireAdmin` (plan Q6: golden/anomaly are admin-only; regular
 * users have no golden/anomaly surface at all).
 */
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

import { UnauthorizedError } from "../../core/errors.js";
import type { AuthUser } from "../auth/auth.types.js";

import type { AnomalyFlagRow, GoldenCaseRow } from "./golden.repository.js";
import type { GoldenService } from "./golden.service.js";

interface RouteOptions {
  readonly service: GoldenService;
}

const n2 = (s: string | null): number | null => (s == null ? null : Number(s));

const expectedFields = {
  expectedStartUsd: z.number().nullable(),
  expectedNetStartUsd: z.number().nullable(),
  expectedPnlUsd: z.number().nullable(),
  toleranceAbsUsd: z.number().positive().default(1),
  tolerancePct: z.number().positive().default(0.02),
  sourceOfTruth: z.string().min(1).max(40),
  provenanceNote: z.string().max(4000).nullable(),
  methodologyVersion: z.string().min(1).max(60),
  fixturePath: z.string().max(300).nullable(),
};

const createBody = z.object({
  walletId: z.string().uuid(),
  positionId: z.string().min(1).max(200),
  chain: z.string().min(1).max(40),
  protocolId: z.string().min(1).max(120),
  marketKey: z.string().max(200).nullable(),
  openHash: z.string().max(120).nullable(),
  label: z.string().min(1).max(60),
  positionKey: z.string().max(300).nullable().default(null),
  kind: z.enum(["golden", "wrong"]).default("golden"),
  issue: z.string().max(40).nullable().default(null),
  // A3.6 derivation (knowledge base): ops + cost-flow trace, opaque jsonb.
  derivation: z.any().optional(),
  ...expectedFields,
});

const patchBody = z.object({
  expectedStartUsd: z.number().nullable().optional(),
  expectedNetStartUsd: z.number().nullable().optional(),
  expectedPnlUsd: z.number().nullable().optional(),
  toleranceAbsUsd: z.number().positive().optional(),
  tolerancePct: z.number().positive().optional(),
  provenanceNote: z.string().max(4000).nullable().optional(),
  methodologyVersion: z.string().min(1).max(60).optional(),
  fixturePath: z.string().max(300).nullable().optional(),
  status: z.enum(["active", "retired"]).optional(),
});

const promoteBody = z.object({
  label: z.string().min(1).max(60),
  expectedStartUsd: z.number().nullable(),
  expectedNetStartUsd: z.number().nullable(),
  expectedPnlUsd: z.number().nullable(),
  toleranceAbsUsd: z.number().positive().default(1),
  tolerancePct: z.number().positive().default(0.02),
  sourceOfTruth: z.string().min(1).max(40),
  provenanceNote: z.string().max(4000).nullable(),
  methodologyVersion: z.string().min(1).max(60),
  fixturePath: z.string().max(300).nullable(),
});

const resolveBody = z.object({
  status: z.enum(["acknowledged", "resolved"]),
  note: z.string().max(4000).nullable(),
});

function toGolden(r: GoldenCaseRow) {
  return {
    id: r.id,
    walletId: r.walletId,
    positionId: r.positionId,
    chain: r.chain,
    protocolId: r.protocolId,
    marketKey: r.marketKey,
    openHash: r.openHash,
    label: r.label,
    positionKey: r.positionKey,
    kind: r.kind,
    issue: r.issue,
    expectedStartUsd: n2(r.expectedStartUsd),
    expectedNetStartUsd: n2(r.expectedNetStartUsd),
    expectedPnlUsd: n2(r.expectedPnlUsd),
    toleranceAbsUsd: n2(r.toleranceAbsUsd),
    tolerancePct: n2(r.tolerancePct),
    sourceOfTruth: r.sourceOfTruth,
    provenanceNote: r.provenanceNote,
    methodologyVersion: r.methodologyVersion,
    fixturePath: r.fixturePath,
    status: r.status,
    derivation: r.derivation ?? null,
    createdByUserId: r.createdByUserId,
    promotedFromAnomalyId: r.promotedFromAnomalyId,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

function toAnomaly(r: AnomalyFlagRow) {
  return {
    id: r.id,
    accountId: r.accountId,
    walletId: r.walletId,
    positionId: r.positionId,
    chain: r.chain,
    protocolId: r.protocolId,
    marketKey: r.marketKey,
    checkId: r.checkId,
    anomalyType: r.anomalyType,
    severity: r.severity,
    phase: r.phase,
    observedValue: n2(r.observedValue),
    expectedValue: n2(r.expectedValue),
    detail: r.detail ?? null,
    goldenCaseId: r.goldenCaseId,
    status: r.status,
    detectorVersion: r.detectorVersion,
    resolvedNote: r.resolvedNote,
    firstSeenAt: r.firstSeenAt.toISOString(),
    lastSeenAt: r.lastSeenAt.toISOString(),
    resolvedAt: r.resolvedAt ? r.resolvedAt.toISOString() : null,
  };
}

const idParam = z.object({ id: z.string().uuid() });

export async function goldenRoutes(
  app: FastifyInstance,
  opts: RouteOptions,
): Promise<void> {
  const route = app.withTypeProvider<ZodTypeProvider>();
  // Allow admins AND admins impersonating a user (golden curation happens
  // while an admin views a user's positions — see plan A3.4 / auth note).
  route.addHook("preHandler", app.requireAdminOrImpersonator);

  // The acting admin — the impersonator when in an impersonation session,
  // else the user themselves. Used for createdByUserId + audit.
  const actorOf = (u: AuthUser): string =>
    u.impersonation?.impersonatorId ?? u.id;

  // ── golden cases ────────────────────────────────────────────────────
  route.post("/cases", { schema: { body: createBody } }, async (req) => {
    const u = req.user;
    if (!u) throw new UnauthorizedError();
    const row = await opts.service.createGolden(actorOf(u), {
      walletId: req.body.walletId,
      positionId: req.body.positionId,
      chain: req.body.chain,
      protocolId: req.body.protocolId,
      marketKey: req.body.marketKey,
      openHash: req.body.openHash,
      label: req.body.label,
      positionKey: req.body.positionKey,
      kind: req.body.kind,
      issue: req.body.issue,
      derivation: req.body.derivation ?? null,
      expectedStartUsd: req.body.expectedStartUsd,
      expectedNetStartUsd: req.body.expectedNetStartUsd,
      expectedPnlUsd: req.body.expectedPnlUsd,
      toleranceAbsUsd: req.body.toleranceAbsUsd,
      tolerancePct: req.body.tolerancePct,
      sourceOfTruth: req.body.sourceOfTruth,
      provenanceNote: req.body.provenanceNote,
      methodologyVersion: req.body.methodologyVersion,
      fixturePath: req.body.fixturePath,
    });
    return toGolden(row);
  });

  route.get(
    "/cases",
    { schema: { querystring: z.object({ walletId: z.string().uuid().optional() }) } },
    async (req) => {
      const rows = await opts.service.listGolden(req.query.walletId);
      return { cases: rows.map(toGolden) };
    },
  );

  route.patch(
    "/cases/:id",
    { schema: { params: idParam, body: patchBody } },
    async (req) => {
      const u = req.user;
      if (!u) throw new UnauthorizedError();
      const row = await opts.service.patchGolden(actorOf(u), req.params.id, req.body);
      return toGolden(row);
    },
  );

  route.delete("/cases/:id", { schema: { params: idParam } }, async (req) => {
    const u = req.user;
    if (!u) throw new UnauthorizedError();
    const row = await opts.service.retireGolden(actorOf(u), req.params.id);
    return toGolden(row);
  });

  // ── anomaly flags ───────────────────────────────────────────────────
  route.get(
    "/anomalies",
    {
      schema: {
        querystring: z.object({
          status: z.string().max(20).optional(),
          walletId: z.string().uuid().optional(),
        }),
      },
    },
    async (req) => {
      const rows = await opts.service.listAnomalies({
        ...(req.query.status !== undefined && { status: req.query.status }),
        ...(req.query.walletId !== undefined && { walletId: req.query.walletId }),
      });
      return { anomalies: rows.map(toAnomaly) };
    },
  );

  route.patch(
    "/anomalies/:id",
    { schema: { params: idParam, body: resolveBody } },
    async (req) => {
      const u = req.user;
      if (!u) throw new UnauthorizedError();
      const row = await opts.service.resolveAnomaly(
        actorOf(u),
        req.params.id,
        req.body.status,
        req.body.note,
      );
      return toAnomaly(row);
    },
  );

  route.post(
    "/anomalies/:id/promote",
    { schema: { params: idParam, body: promoteBody } },
    async (req) => {
      const u = req.user;
      if (!u) throw new UnauthorizedError();
      const result = await opts.service.promoteAnomaly(actorOf(u), req.params.id, {
        label: req.body.label,
        expectedStartUsd: req.body.expectedStartUsd,
        expectedNetStartUsd: req.body.expectedNetStartUsd,
        expectedPnlUsd: req.body.expectedPnlUsd,
        toleranceAbsUsd: req.body.toleranceAbsUsd,
        tolerancePct: req.body.tolerancePct,
        sourceOfTruth: req.body.sourceOfTruth,
        provenanceNote: req.body.provenanceNote,
        methodologyVersion: req.body.methodologyVersion,
        fixturePath: req.body.fixturePath,
      });
      return { golden: toGolden(result.golden), anomaly: toAnomaly(result.anomaly) };
    },
  );
}
