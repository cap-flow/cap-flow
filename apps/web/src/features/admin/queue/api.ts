import { z } from "zod";

import { api } from "@/lib/api/client";

export const queueStatusSchema = z.object({
  name: z.string(),
  counts: z.object({
    active: z.number(),
    waiting: z.number(),
    delayed: z.number(),
    completed: z.number(),
    failed: z.number(),
  }),
  recurringSchedules: z.array(
    z.object({
      key: z.string(),
      name: z.string().nullable(),
      every: z.number().nullable(),
      next: z.number().nullable(),
    })
  ),
});
export type QueueStatus = z.infer<typeof queueStatusSchema>;

export const adminQueueApi = {
  status: () => api.get("/v1/admin/queue/status", queueStatusSchema),
};
