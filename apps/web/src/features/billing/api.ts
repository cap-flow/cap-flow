import { z } from "zod";

import { api } from "@/lib/api/client";

export const subscriptionStatusSchema = z.enum([
  "beta",
  "active",
  "grace",
  "expired",
]);
export type SubscriptionStatus = z.infer<typeof subscriptionStatusSchema>;

export const billingSummarySchema = z.object({
  status: subscriptionStatusSchema,
  periodEnd: z.string().nullable(),
  graceUntil: z.string().nullable(),
  daysLeft: z.number().nullable(),
  plan: z.string().nullable(),
  amountUsd: z.string().nullable(),
});
export type BillingSummary = z.infer<typeof billingSummarySchema>;

const networkSchema = z.enum(["trc20", "erc20"]);
export type CryptoNetwork = z.infer<typeof networkSchema>;

export const paymentAddressSchema = z.object({
  id: z.string().uuid(),
  network: networkSchema,
  address: z.string(),
  createdAt: z.string(),
});
export type PaymentAddress = z.infer<typeof paymentAddressSchema>;

export const paymentRowSchema = z.object({
  id: z.string().uuid(),
  kind: z.string(),
  plan: z.string(),
  amountUsd: z.string(),
  horizonMonths: z.number(),
  paidAt: z.string(),
  periodEnd: z.string().nullable(),
  note: z.string().nullable(),
});
export type PaymentRow = z.infer<typeof paymentRowSchema>;

const paymentsListSchema = z.array(paymentRowSchema);

export const billingApi = {
  summary: () => api.get("/v1/me/billing", billingSummarySchema),
  allocateAddress: (network: CryptoNetwork) =>
    api.post(
      "/v1/me/billing/payment-address",
      { network },
      paymentAddressSchema
    ),
  payments: () => api.get("/v1/me/billing/payments", paymentsListSchema),
};
