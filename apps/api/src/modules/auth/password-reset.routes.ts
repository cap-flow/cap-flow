import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

import type { PasswordResetService } from "./password-reset.service.js";

const requestBodySchema = z.object({
  email: z.string().email().max(320),
});

const confirmBodySchema = z.object({
  token: z.string().min(8).max(200),
  newPassword: z
    .string()
    .min(12, "Password must be at least 12 characters")
    .max(200),
});

interface PasswordResetRoutesOptions {
  readonly service: PasswordResetService;
}

export async function passwordResetRoutes(
  app: FastifyInstance,
  opts: PasswordResetRoutesOptions
): Promise<void> {
  const route = app.withTypeProvider<ZodTypeProvider>();
  const { service } = opts;

  route.post(
    "/reset-request",
    {
      schema: { body: requestBodySchema },
      config: {
        // Strict per-IP cap: don't let probers fish for valid emails by timing.
        rateLimit: { max: 5, timeWindow: "15 minutes" },
      },
    },
    async (req, reply) => {
      await service.requestReset(req.body.email);
      // Always 204 — never reveal whether the email matched.
      return reply.status(204).send();
    }
  );

  route.post(
    "/reset-confirm",
    {
      schema: { body: confirmBodySchema },
      config: {
        rateLimit: { max: 10, timeWindow: "15 minutes" },
      },
    },
    async (req, reply) => {
      await service.confirmReset(req.body.token, req.body.newPassword);
      return reply.status(204).send();
    }
  );
}
