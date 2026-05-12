import { z } from "zod";

import { api } from "@/lib/api/client";

export const findingSchema = z.object({
  id: z.string(),
  severity: z.enum(["info", "warning", "error"]),
  category: z.string(),
  message: z.string(),
  accountId: z.string().uuid().optional(),
  userId: z.string().uuid().optional(),
  details: z.record(z.unknown()).optional(),
});
export type Finding = z.infer<typeof findingSchema>;

export const reportSchema = z.object({
  summary: z.record(z.number()),
  findings: z.array(findingSchema),
});
export type TechAuditReport = z.infer<typeof reportSchema>;

export const adminTechAuditApi = {
  report: () => api.get("/v1/admin/tech-audit", reportSchema),
};
