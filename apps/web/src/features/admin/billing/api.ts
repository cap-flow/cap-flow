import { z } from "zod";

import { api } from "@/lib/api/client";
import {
  billingSummarySchema,
  paymentRowSchema,
} from "@/features/billing/api";

const adminBillingResponseSchema = z.object({
  subscription: billingSummarySchema,
  history: z.array(paymentRowSchema),
});
export type AdminBillingResponse = z.infer<typeof adminBillingResponseSchema>;

export const adminBillingApi = {
  get: (userId: string) =>
    api.get(`/v1/admin/users/${userId}/billing`, adminBillingResponseSchema),

  credit: (userId: string, amountUsd: number, note?: string) =>
    api.post(
      `/v1/admin/users/${userId}/billing/credit`,
      { amountUsd, ...(note ? { note } : {}) },
      paymentRowSchema
    ),

  refund: (userId: string, paymentId: string, note?: string) =>
    api.post(
      `/v1/admin/users/${userId}/billing/refund`,
      { paymentId, ...(note ? { note } : {}) },
      paymentRowSchema
    ),
};
