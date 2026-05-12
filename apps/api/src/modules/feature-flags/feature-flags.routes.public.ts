import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

import { UnauthorizedError } from "../../core/errors.js";

import type { FeatureFlagsService } from "./feature-flags.service.js";

const querySchema = z.object({
  /** Comma-separated flag keys the frontend wants to resolve in one round-trip. */
  keys: z.string().min(1).max(2000),
  /** Optional accountId to scope account-level overrides for the caller. */
  accountId: z.string().uuid().optional(),
});

const resolvedFlagSchema = z.object({
  key: z.string(),
  enabled: z.boolean(),
  source: z.enum(["global", "account", "user", "default"]),
  payload: z.unknown().nullable(),
});

interface PublicFeatureFlagsRoutesOptions {
  readonly service: FeatureFlagsService;
}

export async function publicFeatureFlagsRoutes(
  app: FastifyInstance,
  opts: PublicFeatureFlagsRoutesOptions
): Promise<void> {
  const route = app.withTypeProvider<ZodTypeProvider>();
  route.addHook("preHandler", app.requireAuth);

  route.get(
    "/",
    {
      schema: {
        querystring: querySchema,
        response: { 200: z.array(resolvedFlagSchema) },
      },
    },
    async (req) => {
      const u = req.user;
      if (!u) throw new UnauthorizedError();
      const keys = req.query.keys
        .split(",")
        .map((k) => k.trim())
        .filter((k) => k.length > 0)
        .slice(0, 50); // cap so a malicious client can't request 10k keys
      return opts.service.resolveAll(keys, {
        userId: u.id,
        ...(req.query.accountId ? { accountId: req.query.accountId } : {}),
      });
    }
  );
}
