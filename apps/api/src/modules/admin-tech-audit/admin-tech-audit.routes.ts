import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

import type { AdminTechAuditService } from "./admin-tech-audit.service.js";

const findingSchema = z.object({
  id: z.string(),
  severity: z.enum(["info", "warning", "error"]),
  category: z.string(),
  message: z.string(),
  accountId: z.string().uuid().optional(),
  userId: z.string().uuid().optional(),
  details: z.record(z.unknown()).optional(),
});

const reportSchema = z.object({
  summary: z.record(z.number()),
  findings: z.array(findingSchema),
});

interface AdminTechAuditRoutesOptions {
  readonly service: AdminTechAuditService;
}

export async function adminTechAuditRoutes(
  app: FastifyInstance,
  opts: AdminTechAuditRoutesOptions
): Promise<void> {
  const route = app.withTypeProvider<ZodTypeProvider>();
  route.addHook("preHandler", app.requireAdmin);

  route.get(
    "/",
    { schema: { response: { 200: reportSchema } } },
    async () => opts.service.runAll()
  );
}
