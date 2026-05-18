/**
 * UCB B4: client API для sync coverage state.
 */
import { z } from "zod";

import { api } from "@/lib/api/client";

export const walletCoverageSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  kind: z.string(),
  lastSyncAt: z.string().datetime().nullable(),
  lastSyncError: z.string().nullable(),
  opsCount: z.number().int().nonnegative(),
});
export type WalletCoverage = z.infer<typeof walletCoverageSchema>;

export const cexAccountCoverageSchema = z.object({
  id: z.string().uuid(),
  exchange: z.string(),
  label: z.string().nullable(),
  lastSyncAt: z.string().datetime().nullable(),
  lastSyncError: z.string().nullable(),
  lastTradesSyncAt: z.string().datetime().nullable(),
  lastTradesSyncError: z.string().nullable(),
  lastInternalTransfersSyncAt: z.string().datetime().nullable(),
  lastInternalTransfersSyncError: z.string().nullable(),
  tradesCount: z.number().int().nonnegative(),
  transfersCount: z.number().int().nonnegative(),
  internalTransfersCount: z.number().int().nonnegative(),
  p2pCount: z.number().int().nonnegative(),
});
export type CexAccountCoverage = z.infer<typeof cexAccountCoverageSchema>;

export const syncCoverageResponseSchema = z.object({
  wallets: z.array(walletCoverageSchema),
  cexAccounts: z.array(cexAccountCoverageSchema),
});

export const syncCoverageApi = {
  get: () => api.get(`/v1/sync-coverage/`, syncCoverageResponseSchema),
};
