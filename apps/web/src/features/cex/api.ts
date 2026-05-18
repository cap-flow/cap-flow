import { z } from "zod";

import { api } from "@/lib/api/client";

export const SUPPORTED_EXCHANGES = [
  "bybit",
  "okx",
  "bitget",
  "mexc",
  "bingx",
] as const;
export type ExchangeId = (typeof SUPPORTED_EXCHANGES)[number];

export const EXCHANGES_REQUIRING_PASSPHRASE: ReadonlySet<ExchangeId> = new Set([
  "okx",
  "bitget",
]);

/**
 * Status каждого data-read endpoint'а биржи. UCB B1.1.
 *
 *   ok          — endpoint работает (даже если empty response)
 *   denied      — explicit 401/403/«permission»/«unauthorized»
 *   unsupported — CCXT не имеет такого method'а для этой биржи
 *   unknown     — probe не запускался, transient error
 */
export const permStatusSchema = z.enum([
  "ok",
  "denied",
  "unsupported",
  "unknown",
]);
export type PermStatus = z.infer<typeof permStatusSchema>;

export const cexPermissionsSchema = z.object({
  read: z.boolean(),
  trade: z.boolean(),
  withdraw: z.boolean(),
  unknown: z.boolean(),
  /** UCB B1: можно ли read'ить trade history. */
  tradeHistory: permStatusSchema.optional(),
  deposits: permStatusSchema.optional(),
  withdrawals: permStatusSchema.optional(),
  /** ISO timestamp последнего probe. */
  lastProbedAt: z.string().optional(),
});
export type CexPermissions = z.infer<typeof cexPermissionsSchema>;

export const cexAccountSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  accountId: z.string().uuid(),
  exchange: z.string(),
  label: z.string().nullable(),
  permissions: z.unknown(),
  lastSyncedAt: z.string().datetime().nullable(),
  lastSyncError: z.string().nullable(),
  /** UCB B1.2: trade-history sync state — отдельно от common sync. */
  lastTradesSyncAt: z.string().datetime().nullable().optional(),
  lastTradesSyncError: z.string().nullable().optional(),
  createdAt: z.string().datetime(),
});
export type CexAccount = z.infer<typeof cexAccountSchema>;

const cexAccountListSchema = z.array(cexAccountSchema);

export const cexSyncResultSchema = z.object({
  ok: z.boolean(),
  balanceCount: z.number().int(),
  newTrades: z.number().int(),
  error: z.string().optional(),
  tradesWarning: z.string().optional(),
  /** UCB B1.3: per-endpoint probe status for UI coverage report. */
  tradeHistoryStatus: permStatusSchema.optional(),
  depositsStatus: permStatusSchema.optional(),
  withdrawalsStatus: permStatusSchema.optional(),
});
export type CexSyncResult = z.infer<typeof cexSyncResultSchema>;

export const cexReProbeResultSchema = z.object({
  ok: z.boolean(),
  permissions: cexPermissionsSchema.nullable(),
});
export type CexReProbeResult = z.infer<typeof cexReProbeResultSchema>;

export const cexP2pSyncResultSchema = z.object({
  ok: z.boolean(),
  supported: z.boolean(),
  newOrders: z.number().int(),
  error: z.string().optional(),
});
export type CexP2pSyncResult = z.infer<typeof cexP2pSyncResultSchema>;

export const cexP2pOrderSchema = z.object({
  id: z.string().uuid(),
  exchangeOrderId: z.string(),
  side: z.string(),
  asset: z.string(),
  amount: z.string(),
  fiatCurrency: z.string().nullable(),
  fiatAmount: z.string().nullable(),
  unitPrice: z.string().nullable(),
  counterparty: z.string().nullable(),
  paymentMethod: z.string().nullable(),
  status: z.string(),
  fiatSource: z.string(),
  executedAt: z.string().datetime(),
  mergedCount: z.number().int(),
});
export type CexP2pOrder = z.infer<typeof cexP2pOrderSchema>;
const cexP2pOrdersListSchema = z.array(cexP2pOrderSchema);

export const cexTransfersSyncResultSchema = z.object({
  ok: z.boolean(),
  newDeposits: z.number().int(),
  newWithdrawals: z.number().int(),
  error: z.string().optional(),
});
export type CexTransfersSyncResult = z.infer<typeof cexTransfersSyncResultSchema>;

// UCB B3: internal transfers sync response.
export const cexInternalTransfersSyncResultSchema = z.object({
  ok: z.boolean(),
  newCount: z.number().int().nonnegative(),
  error: z.string().optional(),
});
export type CexInternalTransfersSyncResult = z.infer<
  typeof cexInternalTransfersSyncResultSchema
>;

export const cexInternalTransferSchema = z.object({
  id: z.string().uuid(),
  exchangeTransferId: z.string(),
  asset: z.string(),
  amount: z.string(),
  fromAccount: z.string(),
  toAccount: z.string(),
  status: z.string(),
  executedAt: z.string().datetime(),
});
export type CexInternalTransfer = z.infer<typeof cexInternalTransferSchema>;
const cexInternalTransfersListSchema = z.array(cexInternalTransferSchema);

// UCB B4: ledger sync (master record всех balance entries).
export const cexLedgerSyncResultSchema = z.object({
  ok: z.boolean(),
  newCount: z.number().int().nonnegative(),
  error: z.string().optional(),
});
export type CexLedgerSyncResult = z.infer<typeof cexLedgerSyncResultSchema>;

export const cexLedgerEntrySchema = z.object({
  id: z.string().uuid(),
  exchangeEntryId: z.string(),
  account: z.string().nullable(),
  asset: z.string(),
  amount: z.string(),
  direction: z.string(),
  type: z.string(),
  referenceId: z.string().nullable(),
  feeAmount: z.string().nullable(),
  feeCurrency: z.string().nullable(),
  status: z.string(),
  executedAt: z.string().datetime(),
});
export type CexLedgerEntry = z.infer<typeof cexLedgerEntrySchema>;
const cexLedgerListSchema = z.array(cexLedgerEntrySchema);

export const cexTransferSchema = z.object({
  id: z.string().uuid(),
  exchangeTransferId: z.string(),
  direction: z.string(), // 'deposit' | 'withdrawal'
  asset: z.string(),
  amount: z.string(),
  feeAmount: z.string().nullable(),
  feeCurrency: z.string().nullable(),
  network: z.string().nullable(),
  address: z.string().nullable(),
  txHash: z.string().nullable(),
  status: z.string(),
  executedAt: z.string().datetime(),
});
export type CexTransfer = z.infer<typeof cexTransferSchema>;
const cexTransfersListSchema = z.array(cexTransferSchema);

export const cexUserTransferWithHashSchema = z.object({
  cexAccountId: z.string().uuid(),
  exchange: z.string(),
  label: z.string().nullable(),
  direction: z.string(),
  asset: z.string(),
  amount: z.string(),
  txHash: z.string(),
  executedAt: z.string().datetime(),
});
export type CexUserTransferWithHash = z.infer<
  typeof cexUserTransferWithHashSchema
>;
const cexUserTransfersWithHashListSchema = z.array(
  cexUserTransferWithHashSchema,
);

export const cexValuationSchema = z.object({
  totalUsd: z.number(),
  unpricedCount: z.number().int(),
  perAccount: z.array(
    z.object({
      id: z.string().uuid(),
      exchange: z.string(),
      label: z.string().nullable(),
      totalUsd: z.number(),
      unpricedCount: z.number().int(),
      neverSynced: z.boolean().optional(),
      assets: z.array(
        z.object({
          asset: z.string(),
          total: z.number(),
          priceUsd: z.number().nullable(),
          valueUsd: z.number(),
        })
      ),
    })
  ),
});
export type CexValuation = z.infer<typeof cexValuationSchema>;

export interface ConnectCexInput {
  readonly accountId: string;
  readonly exchange: ExchangeId;
  readonly label: string | null;
  readonly apiKey: string;
  readonly apiSecret: string;
  readonly apiPassphrase?: string;
}

export const cexApi = {
  list: () => api.get(`/v1/cex/`, cexAccountListSchema),

  connect: (input: ConnectCexInput) =>
    api.post(`/v1/cex/`, input, cexAccountSchema),

  disconnect: (id: string) => api.delete(`/v1/cex/${id}`, z.unknown()),

  sync: (id: string) =>
    api.post(`/v1/cex/${id}/sync`, {}, cexSyncResultSchema),

  /**
   * UCB B1.4: re-probe permissions без полного sync. Используется когда
   * юзер только что обновил permission на бирже и хочет увидеть
   * обновлённый статус не прогоняя 30s balance-fetch.
   */
  reProbe: (id: string) =>
    api.post(`/v1/cex/${id}/reprobe`, {}, cexReProbeResultSchema),

  syncP2p: (id: string) =>
    api.post(`/v1/cex/${id}/p2p-sync`, {}, cexP2pSyncResultSchema),

  listP2pOrders: (id: string) =>
    api.get(`/v1/cex/${id}/p2p-orders`, cexP2pOrdersListSchema),

  /**
   * Manually set fiat-leg fields on a P2P order. The Bitget retail
   * API leaves these null; users fill them in via the «✏ Указать
   * фиат» dialog OR a CSV import.
   */
  annotateP2pOrder: (
    orderId: string,
    body: {
      fiatCurrency: string | null;
      fiatAmount: number | null;
      unitPrice?: number;
      counterparty?: string | null;
      paymentMethod?: string | null;
    },
  ) =>
    api.patch(
      `/v1/cex/p2p-orders/${orderId}`,
      body,
      z.object({ ok: z.literal(true) }),
    ),

  /**
   * Create a P2P order by hand. Used for exchanges with no public
   * P2P API (BingX), or for trades outside the API's retention window.
   */
  createManualP2pOrder: (
    id: string,
    body: {
      side: "buy" | "sell";
      asset: string;
      amount: number;
      fiatCurrency: string;
      fiatAmount: number;
      unitPrice?: number;
      counterparty?: string | null;
      paymentMethod?: string | null;
      status?: string;
      executedAt: string;
    },
  ) =>
    api.post(`/v1/cex/${id}/p2p-orders/manual`, body, cexP2pOrderSchema),

  /**
   * Bulk import P2P fiat data from a Bitget CSV export. Server
   * matches by exchange order id and updates rows in place.
   */
  importP2pCsv: (
    id: string,
    rows: ReadonlyArray<{
      orderId: string;
      fiatCurrency: string;
      fiatAmount: number;
      unitPrice?: number;
      counterparty?: string | null;
      paymentMethod?: string | null;
    }>,
  ) =>
    api.post(
      `/v1/cex/${id}/p2p-orders/import-csv`,
      { rows },
      z.object({
        matched: z.number().int(),
        unmatched: z.number().int(),
        total: z.number().int(),
      }),
    ),

  /**
   * UCB B6: bulk import spot-trade history из CSV/XLSX выгрузки биржи.
   * Server upsert'ает по `(account, exchangeTradeId)` — idempotent.
   */
  importTradesCsv: (
    id: string,
    rows: ReadonlyArray<{
      exchangeTradeId: string;
      symbol: string;
      side: "buy" | "sell";
      amount: number;
      price: number;
      cost: number;
      feeCurrency?: string | null;
      feeAmount?: number | null;
      executedAt: string;
    }>,
  ) =>
    api.post(
      `/v1/cex/${id}/trades/import-csv`,
      { rows },
      z.object({
        inserted: z.number().int(),
        skipped: z.number().int(),
        total: z.number().int(),
      }),
    ),

  valuation: () => api.get(`/v1/cex/me/valuation`, cexValuationSchema),

  withdrawalCostBasis: () =>
    api.get(
      `/v1/cex/me/withdrawal-cost-basis`,
      z.array(
        z.object({
          cexAccountId: z.string().uuid(),
          exchange: z.string(),
          label: z.string().nullable(),
          transferId: z.string().uuid(),
          txHash: z.string(),
          asset: z.string(),
          amount: z.number(),
          costBasisUsd: z.number(),
          // UCB D1: optional — backward compat with old server responses.
          feeLossUsd: z.number().optional().default(0),
          feeAsset: z.string().nullable().optional().default(null),
          feeAmount: z.number().optional().default(0),
          source: z.enum(["fiat-direct", "fiat-stable", "inherited", "unknown"]),
          executedAt: z.string().datetime(),
        }),
      ),
    ),

  syncTransfers: (id: string) =>
    api.post(`/v1/cex/${id}/transfers-sync`, {}, cexTransfersSyncResultSchema),

  // UCB B3: sync internal transfers (Spot↔Funding↔Earn↔Sub-account).
  syncInternalTransfers: (id: string) =>
    api.post(
      `/v1/cex/${id}/internal-transfers-sync`,
      {},
      cexInternalTransfersSyncResultSchema,
    ),

  listInternalTransfers: (id: string) =>
    api.get(`/v1/cex/${id}/internal-transfers`, cexInternalTransfersListSchema),

  // UCB B4: ledger sync (master record).
  syncLedger: (id: string) =>
    api.post(`/v1/cex/${id}/ledger-sync`, {}, cexLedgerSyncResultSchema),

  listLedger: (id: string) =>
    api.get(`/v1/cex/${id}/ledger`, cexLedgerListSchema),

  listTransfers: (id: string) =>
    api.get(`/v1/cex/${id}/transfers`, cexTransfersListSchema),

  listAllTransfersWithHash: () =>
    api.get(
      `/v1/cex/me/transfers-with-hash`,
      cexUserTransfersWithHashListSchema,
    ),

  // ─── UCB C1: deposit seeds ─────────────────────────────────────────
  depositSeedsUpsert: (
    seeds: ReadonlyArray<{
      txHash: string;
      chain: string;
      costBasisUsd: number;
      walletId: string | null;
      note: string | null;
    }>,
  ) =>
    api.post(
      `/v1/cex/deposit-seeds`,
      { seeds },
      z.object({ count: z.number().int().nonnegative() }),
    ),

  // Bob-test fix #5: per-asset gap warnings.
  assetGaps: () =>
    api.get(
      `/v1/cex/me/asset-gaps`,
      z.object({
        gaps: z.array(
          z.object({
            asset: z.string(),
            kind: z.enum([
              "outflow_exceeds_inflow",
              "no_acquisitions_at_all",
            ]),
            severity: z.enum(["warn", "error"]),
            ratio: z.number(),
            missing: z.number(),
            inflow: z.number(),
            outflow: z.number(),
          }),
        ),
      }),
    ),

  // Tax T4: CEX-side tax events list.
  taxEventsList: () =>
    api.get(
      `/v1/cex/me/tax-events`,
      z.object({
        events: z.array(
          z.object({
            cexAccountId: z.string().uuid(),
            exchange: z.string(),
            label: z.string().nullable(),
            disposedAt: z.string().datetime(),
            acquiredAt: z.string().datetime(),
            holdingPeriodDays: z.number().int(),
            term: z.enum(["short", "long"]),
            eventType: z.enum(["sale", "exchange", "income"]),
            asset: z.string(),
            assetFamily: z.string(),
            amount: z.number(),
            proceedsUsd: z.number(),
            costBasisUsd: z.number(),
            gainUsd: z.number(),
            source: z.enum(["p2p", "trade"]),
            sourceId: z.string(),
          }),
        ),
      }),
    ),

  depositSeedsList: () =>
    api.get(
      `/v1/cex/deposit-seeds/me`,
      z.object({
        seeds: z.array(
          z.object({
            id: z.string().uuid(),
            txHash: z.string(),
            chain: z.string(),
            costBasisUsd: z.number(),
            walletId: z.string().uuid().nullable(),
            note: z.string().nullable(),
            createdAt: z.string().datetime(),
            updatedAt: z.string().datetime(),
          }),
        ),
      }),
    ),

  depositSeedsDelete: (txHash: string) =>
    api.delete(
      `/v1/cex/deposit-seeds/${encodeURIComponent(txHash)}`,
      z.unknown(),
    ),
};
