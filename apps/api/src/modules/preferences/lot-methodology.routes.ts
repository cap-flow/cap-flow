/**
 * User-facing lot-methodology preference: GET/PUT /v1/me/lot-methodology.
 * requireAuth; scoped to the authenticated user. The UI persists the FIFO/LIFO/
 * WAC/HIFO toggle here so the server shadow compute matches what the user sees.
 */
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

import { UnauthorizedError } from "../../core/errors.js";
import { coerceMethodology, type LotMethodologyRepository } from "./lot-methodology.repository.js";

const methodologyEnum = z.enum(["FIFO", "LIFO", "WAC", "HIFO"]);
const putBody = z.object({ methodology: methodologyEnum });
const responseSchema = z.object({ methodology: methodologyEnum });

export interface LotMethodologyRoutesOptions {
  repo: LotMethodologyRepository;
}

export async function lotMethodologyRoutes(
  app: FastifyInstance,
  opts: LotMethodologyRoutesOptions,
): Promise<void> {
  const route = app.withTypeProvider<ZodTypeProvider>();
  route.addHook("preHandler", app.requireAuth);

  route.get("/lot-methodology", { schema: { response: { 200: responseSchema } } }, async (req) => {
    const u = req.user;
    if (!u) throw new UnauthorizedError("auth required");
    const m = await opts.repo.get(u.id);
    return { methodology: coerceMethodology(m) };
  });

  route.put(
    "/lot-methodology",
    { schema: { body: putBody, response: { 200: responseSchema } } },
    async (req) => {
      const u = req.user;
      if (!u) throw new UnauthorizedError("auth required");
      await opts.repo.set(u.id, req.body.methodology);
      return { methodology: req.body.methodology };
    },
  );
}
