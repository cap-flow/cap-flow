import { z } from "zod";

import { api } from "@/lib/api/client";

/**
 * Shape of `metrics` blob the server writes to `portfolio_snapshots`.
 *
 * Authoritative summary of the account: total USD across all wallets,
 * per-address per-chain breakdown, cost-basis tracking, error log. The
 * worker re-computes this every hour (cron) and on manual refresh.
 *
 * Dashboard reads this via `useAccountSnapshot()`; pre-SaaS client-side
 * compute is being phased out (see notes/ROADMAP.md F6 phase).
 */
export const snapshotMetricsSchema = z
  .object({
    totalUsd: z.number().nullish(),
    // Phase F6b slice 1: capital split — DeFi vs bare wallet.
    walletUsd: z.number().nullish(),
    protocolsAssetUsd: z.number().nullish(),
    totalDebtUsd: z.number().nullish(),
    ownCapitalUsd: z.number().nullish(),
    protocolsCount: z.number().nullish(),
    // Counts for CAP-WALLET header.
    walletsCount: z.number().nullish(),
    chainsCount: z.number().nullish(),
    // Slice 2: per-symbol allocation across all addresses + DeFi
    // supplies. Sorted DESC by usd. Receipt tokens already filtered
    // server-side via isProtocolToken().
    allocation: z
      .array(
        z.object({
          symbol: z.string(),
          chain: z.string(),
          amount: z.number(),
          usd: z.number(),
        }),
      )
      .nullish(),
    // Slice 4: PNL (unrealized).
    pnlOwnUsd: z.number().nullish(),
    pnlOwnPct: z.number().nullish(),
    pnlTotalUsd: z.number().nullish(),
    pnlTotalPct: z.number().nullish(),
    startUsdEffective: z.number().nullish(),
    // Slice 5: flat list of all open positions across every wallet.
    positions: z
      .array(
        z.object({
          id: z.string(),
          protocolId: z.string(),
          protocolName: z.string(),
          chain: z.string(),
          itemName: z.string(),
          walletId: z.string().uuid().nullish(),
          walletName: z.string(),
          address: z.string(),
          assetUsd: z.number(),
          debtUsd: z.number(),
          netUsd: z.number(),
          supplyTokens: z.array(
            z.object({
              symbol: z.string(),
              amount: z.number(),
              usd: z.number(),
            }),
          ),
          debtTokens: z.array(
            z.object({
              symbol: z.string(),
              amount: z.number(),
              usd: z.number(),
            }),
          ),
        }),
      )
      .nullish(),
    // Slice 3: per-protocol breakdown for "Активы в проектах".
    // Each entry is one (protocolId × chain), deduplicated across wallets.
    protocols: z
      .array(
        z.object({
          id: z.string(),
          chain: z.string(),
          name: z.string(),
          assetUsd: z.number(),
          debtUsd: z.number(),
          netUsd: z.number(),
          walletNames: z.array(z.string()),
          supplyTokens: z.array(
            z.object({
              symbol: z.string(),
              amount: z.number(),
              usd: z.number(),
            }),
          ),
          debtTokens: z.array(
            z.object({
              symbol: z.string(),
              amount: z.number(),
              usd: z.number(),
            }),
          ),
        }),
      )
      .nullish(),
    perAddress: z
      .array(
        z.object({
          address: z.string(),
          kind: z.enum(["evm", "solana", "coinstats", "tron", "other"]),
          walletName: z.string().nullish(),
          totalUsd: z.number().nullish(),
          walletUsd: z.number().nullish(),
          protocolsAssetUsd: z.number().nullish(),
          totalDebtUsd: z.number().nullish(),
          chains: z
            .array(
              z.object({
                id: z.string(),
                usdValue: z.number().nullish(),
              }),
            )
            .nullish(),
        }),
      )
      .nullish(),
    costBasis: z
      .array(
        z.object({
          symbol: z.string(),
          avgUsd: z.number().nullish(),
          totalPaidUsd: z.number().nullish(),
          runningAmount: z.number().nullish(),
        }),
      )
      .nullish(),
    operationsCount: z.number().nullish(),
    addressesEvm: z.number().nullish(),
    addressesSolana: z.number().nullish(),
    addressesSkipped: z.number().nullish(),
    refreshedFrom: z.array(z.string()).nullish(),
    generatedAt: z.string().nullish(),
    trigger: z.string().nullish(),
    errors: z.array(z.unknown()).nullish(),
    stub: z.boolean().nullish(),
  })
  .passthrough();

export type SnapshotMetrics = z.infer<typeof snapshotMetricsSchema>;

const refreshStatusSchema = z.object({
  accountId: z.string().uuid(),
  lastSnapshot: z
    .object({
      id: z.string().uuid(),
      date: z.string().nullish(),
      createdAt: z.string(),
      metrics: snapshotMetricsSchema,
    })
    .nullable(),
  recentJobs: z
    .array(
      z.object({
        id: z.string(),
        state: z.string(),
        trigger: z.string(),
        timestamp: z.number().nullish(),
        finishedOn: z.number().nullish(),
        failedReason: z.string().nullish(),
      }),
    )
    .default([]),
});

export type AccountRefreshStatus = z.infer<typeof refreshStatusSchema>;

const refreshAckSchema = z.object({
  jobId: z.string(),
  accountId: z.string().uuid(),
});

export const portfolioApi = {
  refreshStatus: (accountId: string) =>
    api.get(`/v1/accounts/${accountId}/refresh-status`, refreshStatusSchema),

  triggerRefresh: (accountId: string) =>
    api.post(`/v1/accounts/${accountId}/refresh`, {}, refreshAckSchema),
};
