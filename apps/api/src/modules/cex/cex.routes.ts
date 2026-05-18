import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

import { NotFoundError, UnauthorizedError } from "../../core/errors.js";

import type { CexService } from "./cex.service.js";
import type { CexValuationService } from "./cex.valuation.service.js";
import type { CexCostBasisService } from "./cex.cost-basis.service.js";
import { SUPPORTED_EXCHANGES } from "./cex.types.js";

const exchangeEnum = z.enum(SUPPORTED_EXCHANGES);

const idParam = z.object({ id: z.string().uuid() });

const connectBody = z.object({
  accountId: z.string().uuid(),
  exchange: exchangeEnum,
  label: z.string().min(1).max(120).nullable().default(null),
  apiKey: z.string().min(8).max(256),
  apiSecret: z.string().min(8).max(256),
  apiPassphrase: z.string().min(1).max(256).optional(),
});

const accountPublicSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  accountId: z.string().uuid(),
  exchange: z.string(),
  label: z.string().nullable(),
  permissions: z.unknown(),
  lastSyncedAt: z.string().datetime().nullable(),
  lastSyncError: z.string().nullable(),
  /** UCB B1.2: trade-history sync diagnostics (separate from common sync). */
  lastTradesSyncAt: z.string().datetime().nullable().optional(),
  lastTradesSyncError: z.string().nullable().optional(),
  createdAt: z.string().datetime(),
});

const permStatusSchema = z
  .enum(["ok", "denied", "unsupported", "unknown"])
  .optional();

const syncResponse = z.object({
  ok: z.boolean(),
  balanceCount: z.number().int(),
  newTrades: z.number().int(),
  error: z.string().optional(),
  tradesWarning: z.string().optional(),
  /** UCB B1.3: per-endpoint probe status for UI coverage report. */
  tradeHistoryStatus: permStatusSchema,
  depositsStatus: permStatusSchema,
  withdrawalsStatus: permStatusSchema,
});

/** UCB B1.4: response для POST /:id/reprobe — fresh permissions snapshot. */
const reProbeResponse = z.object({
  ok: z.boolean(),
  permissions: z
    .object({
      read: z.boolean(),
      trade: z.boolean(),
      withdraw: z.boolean(),
      unknown: z.boolean(),
      tradeHistory: permStatusSchema,
      deposits: permStatusSchema,
      withdrawals: permStatusSchema,
      lastProbedAt: z.string().optional(),
    })
    .nullable(),
});

const p2pSyncResponse = z.object({
  ok: z.boolean(),
  supported: z.boolean(),
  newOrders: z.number().int(),
  error: z.string().optional(),
});

const transfersSyncResponse = z.object({
  ok: z.boolean(),
  newDeposits: z.number().int(),
  newWithdrawals: z.number().int(),
  error: z.string().optional(),
});

const transferResponse = z.object({
  id: z.string().uuid(),
  exchangeTransferId: z.string(),
  direction: z.string(),
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

// UCB B3: internal transfers (Spot↔Funding↔Earn↔Sub-account).
const internalTransfersSyncResponse = z.object({
  ok: z.boolean(),
  newCount: z.number().int().nonnegative(),
  error: z.string().optional(),
});

// UCB B4: ledger (master record).
const ledgerSyncResponse = z.object({
  ok: z.boolean(),
  newCount: z.number().int().nonnegative(),
  error: z.string().optional(),
});
const ledgerResponse = z.object({
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
const internalTransferResponse = z.object({
  id: z.string().uuid(),
  exchangeTransferId: z.string(),
  asset: z.string(),
  amount: z.string(),
  fromAccount: z.string(),
  toAccount: z.string(),
  status: z.string(),
  executedAt: z.string().datetime(),
});

const userTransfersWithHashResponse = z.array(
  z.object({
    cexAccountId: z.string().uuid(),
    exchange: z.string(),
    label: z.string().nullable(),
    direction: z.string(),
    asset: z.string(),
    amount: z.string(),
    txHash: z.string(),
    executedAt: z.string().datetime(),
  })
);

const p2pOrderResponse = z.object({
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
  /** 'api' | 'manual' | 'csv' | 'merchant'. */
  fiatSource: z.string(),
  executedAt: z.string().datetime(),
  mergedCount: z.number().int(),
});

const p2pAnnotationBody = z.object({
  fiatCurrency: z.string().min(1).max(10).nullable(),
  fiatAmount: z.number().positive().nullable(),
  unitPrice: z.number().positive().optional(),
  counterparty: z.string().max(200).nullable().optional(),
  paymentMethod: z.string().max(200).nullable().optional(),
});

const p2pManualCreateBody = z.object({
  side: z.enum(["buy", "sell"]),
  asset: z.string().min(1).max(20),
  amount: z.number().positive(),
  fiatCurrency: z.string().min(1).max(10),
  fiatAmount: z.number().positive(),
  unitPrice: z.number().positive().optional(),
  counterparty: z.string().max(200).nullable().optional(),
  paymentMethod: z.string().max(200).nullable().optional(),
  status: z.string().min(1).max(40).optional(),
  /** ISO datetime — when the trade actually happened. */
  executedAt: z.string().datetime(),
});

const p2pCsvImportBody = z.object({
  rows: z
    .array(
      z.object({
        orderId: z.string().min(1).max(120),
        fiatCurrency: z.string().min(1).max(10),
        fiatAmount: z.number().positive(),
        unitPrice: z.number().positive().optional(),
        counterparty: z.string().max(200).nullable().optional(),
        paymentMethod: z.string().max(200).nullable().optional(),
      })
    )
    .min(1)
    .max(5000),
});

const p2pCsvImportResponse = z.object({
  matched: z.number().int(),
  unmatched: z.number().int(),
  total: z.number().int(),
});

/** UCB B6: trade-history CSV/XLSX import. */
const tradesCsvImportBody = z.object({
  rows: z
    .array(
      z.object({
        exchangeTradeId: z.string().min(1).max(120),
        symbol: z.string().min(2).max(40),
        side: z.enum(["buy", "sell"]),
        amount: z.number().positive(),
        price: z.number().positive(),
        cost: z.number().nonnegative(),
        feeCurrency: z.string().max(10).nullable().optional(),
        feeAmount: z.number().nullable().optional(),
        executedAt: z.string().min(10).max(64),
      }),
    )
    .min(1)
    .max(20_000),
});

const tradesCsvImportResponse = z.object({
  inserted: z.number().int(),
  skipped: z.number().int(),
  total: z.number().int(),
});

const valuationResponse = z.object({
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

const withdrawalCostBasisResponse = z.array(
  z.object({
    cexAccountId: z.string().uuid(),
    exchange: z.string(),
    label: z.string().nullable(),
    transferId: z.string().uuid(),
    txHash: z.string(),
    asset: z.string(),
    amount: z.number(),
    costBasisUsd: z.number(),
    feeLossUsd: z.number().optional().default(0),
    feeAsset: z.string().nullable().optional().default(null),
    feeAmount: z.number().optional().default(0),
    source: z.enum(["fiat-direct", "fiat-stable", "inherited", "unknown"]),
    executedAt: z.string().datetime(),
  })
);

// UCB C1: deposit seed body + response schemas.
const depositSeedItemBody = z.object({
  txHash: z.string().min(2).max(120),
  chain: z.string().min(1).max(40),
  costBasisUsd: z.number().nonnegative(),
  walletId: z.string().uuid().nullable(),
  note: z.string().max(500).nullable(),
});
const depositSeedsUpsertBody = z.object({
  seeds: z.array(depositSeedItemBody).min(0).max(1000),
});
const depositSeedsUpsertResponse = z.object({
  count: z.number().int().nonnegative(),
});
const depositSeedDto = z.object({
  id: z.string().uuid(),
  txHash: z.string(),
  chain: z.string(),
  costBasisUsd: z.number(),
  walletId: z.string().uuid().nullable(),
  note: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
const depositSeedsListResponse = z.object({
  seeds: z.array(depositSeedDto),
});
const txHashParam = z.object({ txHash: z.string().min(2).max(120) });

interface CexRoutesOptions {
  readonly service: CexService;
  readonly valuation: CexValuationService;
  readonly costBasis: CexCostBasisService;
  /** UCB C1: optional — если не передан, deposit-seeds routes не регистрируются. */
  readonly depositSeeds?: import("./deposit-seeds.service.js").DepositSeedsService;
  /** Tax T4: optional CEX tax events generator. */
  readonly cexTaxEvents?: import("./cex-tax-events.service.js").CexTaxEventsService;
  /** Bob-test fix #5: optional asset-gap detector. */
  readonly assetGap?: import("./cex-asset-gap.service.js").CexAssetGapService;
}

// Bob-test #5: asset gap response schema.
const assetGapItemSchema = z.object({
  asset: z.string(),
  kind: z.enum(["outflow_exceeds_inflow", "no_acquisitions_at_all"]),
  severity: z.enum(["warn", "error"]),
  ratio: z.number(),
  missing: z.number(),
  inflow: z.number(),
  outflow: z.number(),
});
const assetGapsResponse = z.object({
  gaps: z.array(assetGapItemSchema),
});

// Tax T4: CEX tax event response schema.
const cexTaxEventSchema = z.object({
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
});
const cexTaxEventsResponse = z.object({
  events: z.array(cexTaxEventSchema),
});

export async function cexRoutes(
  app: FastifyInstance,
  opts: CexRoutesOptions
): Promise<void> {
  const route = app.withTypeProvider<ZodTypeProvider>();
  route.addHook("preHandler", app.requireAuth);

  /** Connect a new CEX API key. Probes for read perm, encrypts, persists. */
  route.post(
    "/",
    {
      schema: {
        body: connectBody,
        response: { 201: accountPublicSchema },
      },
    },
    async (req, reply) => {
      const u = req.user;
      if (!u) throw new UnauthorizedError();
      const acc = await opts.service.connect({
        userId: u.id,
        accountId: req.body.accountId,
        exchange: req.body.exchange,
        label: req.body.label,
        credentials: {
          apiKey: req.body.apiKey,
          apiSecret: req.body.apiSecret,
          ...(req.body.apiPassphrase
            ? { apiPassphrase: req.body.apiPassphrase }
            : {}),
        },
      });
      return reply.status(201).send({
        ...acc,
        lastSyncedAt: acc.lastSyncedAt ? acc.lastSyncedAt.toISOString() : null,
        lastTradesSyncAt: acc.lastTradesSyncAt
          ? acc.lastTradesSyncAt.toISOString()
          : null,
        lastTradesSyncError: acc.lastTradesSyncError ?? null,
        createdAt: acc.createdAt.toISOString(),
      });
    }
  );

  /**
   * Total USD across all the user's CEX connections, plus a per-account
   * breakdown. Used by the dashboard's Capital summary to fold CEX
   * assets into the same total it already shows for on-chain wallets.
   */
  route.get(
    "/me/valuation",
    { schema: { response: { 200: valuationResponse } } },
    async (req) => {
      const u = req.user;
      if (!u) throw new UnauthorizedError();
      return opts.valuation.valuateForUser(u.id, {
        ip: req.ip ?? null,
        userAgent: req.headers["user-agent"] ?? null,
      });
    }
  );

  /** List the current user's active CEX connections (no secrets). */
  route.get(
    "/",
    { schema: { response: { 200: z.array(accountPublicSchema) } } },
    async (req) => {
      const u = req.user;
      if (!u) throw new UnauthorizedError();
      const rows = await opts.service.list(u.id);
      return rows.map((r) => ({
        ...r,
        lastSyncedAt: r.lastSyncedAt ? r.lastSyncedAt.toISOString() : null,
        lastTradesSyncAt: r.lastTradesSyncAt
          ? r.lastTradesSyncAt.toISOString()
          : null,
        lastTradesSyncError: r.lastTradesSyncError ?? null,
        createdAt: r.createdAt.toISOString(),
      }));
    }
  );

  /** Soft-delete (archive) a connection. Audit-logged. */
  route.delete(
    "/:id",
    { schema: { params: idParam } },
    async (req, reply) => {
      const u = req.user;
      if (!u) throw new UnauthorizedError();
      await opts.service.disconnect(req.params.id, u.id);
      return reply.status(204).send();
    }
  );

  /**
   * Pull crypto deposit + withdrawal history for one CEX account. Used
   * to detect "I sent ETH from my wallet to Bitget" / "I withdrew from
   * Bitget to my wallet" and pair them with on-chain ops via tx_hash.
   */
  route.post(
    "/:id/transfers-sync",
    { schema: { params: idParam, response: { 200: transfersSyncResponse } } },
    async (req) => {
      const u = req.user;
      if (!u) throw new UnauthorizedError();
      return opts.service.syncTransfers(req.params.id, u.id);
    }
  );

  // UCB B3: sync + list internal transfers (Spot↔Funding↔Earn↔Sub-account).
  route.post(
    "/:id/internal-transfers-sync",
    {
      schema: {
        params: idParam,
        response: { 200: internalTransfersSyncResponse },
      },
    },
    async (req) => {
      const u = req.user;
      if (!u) throw new UnauthorizedError();
      return opts.service.syncInternalTransfers(req.params.id, u.id);
    },
  );

  // UCB B4: sync + list ledger (master record всех balance entries).
  route.post(
    "/:id/ledger-sync",
    {
      schema: {
        params: idParam,
        response: { 200: ledgerSyncResponse },
      },
    },
    async (req) => {
      const u = req.user;
      if (!u) throw new UnauthorizedError();
      return opts.service.syncLedger(req.params.id, u.id);
    },
  );

  route.get(
    "/:id/ledger",
    {
      schema: {
        params: idParam,
        response: { 200: z.array(ledgerResponse) },
      },
    },
    async (req) => {
      const u = req.user;
      if (!u) throw new UnauthorizedError();
      const rows = await opts.service.listLedger(req.params.id, u.id);
      return rows.map((r) => ({
        id: r.id,
        exchangeEntryId: r.exchangeEntryId,
        account: r.account,
        asset: r.asset,
        amount: r.amount.toString(),
        direction: r.direction,
        type: r.type,
        referenceId: r.referenceId,
        feeAmount: r.feeAmount?.toString() ?? null,
        feeCurrency: r.feeCurrency,
        status: r.status,
        executedAt:
          r.executedAt instanceof Date
            ? r.executedAt.toISOString()
            : new Date(r.executedAt).toISOString(),
      }));
    },
  );

  route.get(
    "/:id/internal-transfers",
    {
      schema: {
        params: idParam,
        response: { 200: z.array(internalTransferResponse) },
      },
    },
    async (req) => {
      const u = req.user;
      if (!u) throw new UnauthorizedError();
      const rows = await opts.service.listInternalTransfers(req.params.id, u.id);
      return rows.map((r) => ({
        id: r.id,
        exchangeTransferId: r.exchangeTransferId,
        asset: r.asset,
        amount: r.amount,
        fromAccount: r.fromAccount,
        toAccount: r.toAccount,
        status: r.status,
        executedAt: r.executedAt.toISOString(),
      }));
    },
  );

  /** List stored CEX transfers for one account (newest first). */
  route.get(
    "/:id/transfers",
    {
      schema: {
        params: idParam,
        response: { 200: z.array(transferResponse) },
      },
    },
    async (req) => {
      const u = req.user;
      if (!u) throw new UnauthorizedError();
      const rows = await opts.service.listTransfers(req.params.id, u.id);
      return rows.map((r) => ({
        id: r.id,
        exchangeTransferId: r.exchangeTransferId,
        direction: r.direction,
        asset: r.asset,
        amount: r.amount,
        feeAmount: r.feeAmount,
        feeCurrency: r.feeCurrency,
        network: r.network,
        address: r.address,
        txHash: r.txHash,
        status: r.status,
        executedAt: r.executedAt.toISOString(),
      }));
    }
  );

  /**
   * Per-withdrawal cost basis computed from the user's CEX chain
   * (P2P fiat origins → trades → withdrawals). For each withdrawal
   * with a tx_hash, returns the USD cost basis of the crypto that
   * left the exchange — Registry uses this to set startUsd on the
   * matching on-chain op.
   */
  route.get(
    "/me/withdrawal-cost-basis",
    { schema: { response: { 200: withdrawalCostBasisResponse } } },
    async (req) => {
      const u = req.user;
      if (!u) throw new UnauthorizedError();
      const rows = await opts.costBasis.computeForUser(u.id);
      return rows.map((r) => ({
        cexAccountId: r.cexAccountId,
        exchange: r.exchange,
        label: r.label,
        transferId: r.transferId,
        txHash: r.txHash,
        asset: r.asset,
        amount: r.amount,
        costBasisUsd: r.costBasisUsd,
        feeLossUsd: r.feeLossUsd,
        feeAsset: r.feeAsset,
        feeAmount: r.feeAmount,
        source: r.source,
        executedAt: r.executedAt.toISOString(),
      }));
    }
  );

  // ─── Tax T4: CEX-side tax events ───────────────────────────────────
  if (opts.cexTaxEvents) {
    const taxSvc = opts.cexTaxEvents;
    route.get(
      "/me/tax-events",
      { schema: { response: { 200: cexTaxEventsResponse } } },
      async (req) => {
        const u = req.user;
        if (!u) throw new UnauthorizedError();
        const events = await taxSvc.generateForUser(u.id);
        return {
          events: events.map((e) => ({
            cexAccountId: e.cexAccountId,
            exchange: e.exchange,
            label: e.label,
            disposedAt: e.disposedAt.toISOString(),
            acquiredAt: e.acquiredAt.toISOString(),
            holdingPeriodDays: e.holdingPeriodDays,
            term: e.term,
            eventType: e.eventType,
            asset: e.asset,
            assetFamily: e.assetFamily,
            amount: e.amount,
            proceedsUsd: e.proceedsUsd,
            costBasisUsd: e.costBasisUsd,
            gainUsd: e.gainUsd,
            source: e.source,
            sourceId: e.sourceId,
          })),
        };
      },
    );
  }

  // ─── Bob-test #5: CEX asset gap detector ────────────────────────────
  if (opts.assetGap) {
    const gapSvc = opts.assetGap;
    route.get(
      "/me/asset-gaps",
      { schema: { response: { 200: assetGapsResponse } } },
      async (req) => {
        const u = req.user;
        if (!u) throw new UnauthorizedError();
        const gaps = await gapSvc.detectForUser(u.id);
        return { gaps };
      },
    );
  }

  // ─── UCB C1: deposit seeds (client → server cost basis) ──────────────
  if (opts.depositSeeds) {
    const seeds = opts.depositSeeds;

    /**
     * Batch upsert seeds. Each seed = `{ txHash, chain, costBasisUsd,
     * walletId?, note? }`. Idempotent (per-user unique by tx_hash).
     */
    route.post(
      "/deposit-seeds",
      {
        schema: {
          body: depositSeedsUpsertBody,
          response: { 200: depositSeedsUpsertResponse },
        },
      },
      async (req) => {
        const u = req.user;
        if (!u) throw new UnauthorizedError();
        const count = await seeds.upsertMany(u.id, req.body.seeds);
        return { count };
      },
    );

    /** List all user's deposit seeds (для UI / debugging). */
    route.get(
      "/deposit-seeds/me",
      { schema: { response: { 200: depositSeedsListResponse } } },
      async (req) => {
        const u = req.user;
        if (!u) throw new UnauthorizedError();
        const list = await seeds.listAll(u.id);
        return {
          seeds: list.map((s) => ({
            id: s.id,
            txHash: s.txHash,
            chain: s.chain,
            costBasisUsd: s.costBasisUsd,
            walletId: s.walletId,
            note: s.note,
            createdAt: s.createdAt.toISOString(),
            updatedAt: s.updatedAt.toISOString(),
          })),
        };
      },
    );

    /** Delete seed by tx hash (если seed устарел или ошибочен). */
    route.delete(
      "/deposit-seeds/:txHash",
      {
        schema: {
          params: txHashParam,
          response: { 204: z.null(), 404: z.null() },
        },
      },
      async (req, reply) => {
        const u = req.user;
        if (!u) throw new UnauthorizedError();
        const ok = await seeds.delete(u.id, req.params.txHash);
        return reply.code(ok ? 204 : 404).send(null);
      },
    );
  }

  /**
   * All CEX transfers (with on-chain hashes) across ALL the user's
   * connected exchanges. Used by the dashboard's Registry view to
   * detect on-chain ops that are paired with a CEX deposit/withdrawal
   * and badge them as "↔ Bitget" so they don't double-count toward
   * the wallet's cost basis.
   */
  route.get(
    "/me/transfers-with-hash",
    { schema: { response: { 200: userTransfersWithHashResponse } } },
    async (req) => {
      const u = req.user;
      if (!u) throw new UnauthorizedError();
      const rows = await opts.service.listAllTransfersWithHashForUser(u.id);
      return rows.map((r) => ({
        cexAccountId: r.cexAccountId,
        exchange: r.exchange,
        label: r.label,
        direction: r.direction,
        asset: r.asset,
        amount: r.amount,
        txHash: r.txHash,
        executedAt: r.executedAt.toISOString(),
      }));
    }
  );

  /** Pull P2P (fiat) order history. Same shape as /sync. */
  route.post(
    "/:id/p2p-sync",
    { schema: { params: idParam, response: { 200: p2pSyncResponse } } },
    async (req) => {
      const u = req.user;
      if (!u) throw new UnauthorizedError();
      return opts.service.syncP2p(req.params.id, u.id);
    }
  );

  /** List stored P2P orders for one CEX account (newest first). */
  route.get(
    "/:id/p2p-orders",
    {
      schema: {
        params: idParam,
        response: { 200: z.array(p2pOrderResponse) },
      },
    },
    async (req) => {
      const u = req.user;
      if (!u) throw new UnauthorizedError();
      const rows = await opts.service.listP2pOrders(req.params.id, u.id);
      return rows.map((r) => ({
        id: r.id,
        exchangeOrderId: r.exchangeOrderId,
        side: r.side,
        asset: r.asset,
        amount: r.amount,
        fiatCurrency: r.fiatCurrency,
        fiatAmount: r.fiatAmount,
        unitPrice: r.unitPrice,
        counterparty: r.counterparty,
        paymentMethod: r.paymentMethod,
        status: r.status,
        fiatSource: r.fiatSource,
        executedAt: r.executedAt.toISOString(),
        mergedCount: r.mergedCount,
      }));
    }
  );

  /**
   * Manually fill in the fiat-leg fields on a single P2P order.
   * Bitget retail API doesn't expose them — user provides via UI.
   * Auth: order must belong to a CEX account owned by req.user.
   */
  route.patch(
    "/p2p-orders/:orderId",
    {
      schema: {
        params: z.object({ orderId: z.string().uuid() }),
        body: p2pAnnotationBody,
        response: { 200: z.object({ ok: z.literal(true) }) },
      },
    },
    async (req) => {
      const u = req.user;
      if (!u) throw new UnauthorizedError();
      await opts.service.updateP2pOrderFiat(req.params.orderId, u.id, {
        fiatCurrency: req.body.fiatCurrency,
        fiatAmount: req.body.fiatAmount,
        ...(req.body.unitPrice !== undefined
          ? { unitPrice: req.body.unitPrice }
          : {}),
        ...(req.body.counterparty !== undefined
          ? { counterparty: req.body.counterparty }
          : {}),
        ...(req.body.paymentMethod !== undefined
          ? { paymentMethod: req.body.paymentMethod }
          : {}),
      });
      return { ok: true as const };
    }
  );

  /**
   * Manually create a P2P order. Used when the exchange has no
   * public P2P API (BingX) or for older trades outside the API's
   * retention window. The row is tagged `fiat_source = 'manual'` and
   * gets a synthesized `manual-…` exchange_order_id so it can never
   * collide with an upstream-synced row.
   */
  route.post(
    "/:id/p2p-orders/manual",
    {
      schema: {
        params: idParam,
        body: p2pManualCreateBody,
        response: { 200: p2pOrderResponse },
      },
    },
    async (req) => {
      const u = req.user;
      if (!u) throw new UnauthorizedError();
      const row = await opts.service.createManualP2pOrder(
        req.params.id,
        u.id,
        {
          side: req.body.side,
          asset: req.body.asset,
          amount: req.body.amount,
          fiatCurrency: req.body.fiatCurrency,
          fiatAmount: req.body.fiatAmount,
          ...(req.body.unitPrice !== undefined
            ? { unitPrice: req.body.unitPrice }
            : {}),
          ...(req.body.counterparty !== undefined
            ? { counterparty: req.body.counterparty }
            : {}),
          ...(req.body.paymentMethod !== undefined
            ? { paymentMethod: req.body.paymentMethod }
            : {}),
          ...(req.body.status !== undefined ? { status: req.body.status } : {}),
          executedAt: new Date(req.body.executedAt),
        }
      );
      return {
        id: row.id,
        exchangeOrderId: row.exchangeOrderId,
        side: row.side,
        asset: row.asset,
        amount: row.amount,
        fiatCurrency: row.fiatCurrency,
        fiatAmount: row.fiatAmount,
        unitPrice: row.unitPrice,
        counterparty: row.counterparty,
        paymentMethod: row.paymentMethod,
        status: row.status,
        fiatSource: row.fiatSource,
        executedAt: row.executedAt.toISOString(),
        mergedCount: 1,
      };
    }
  );

  /**
   * Bulk-import P2P fiat data from a CSV the user exported in Bitget's
   * UI. Server matches by Bitget order id and updates existing rows
   * with fiat fields. Returns matched/unmatched counters so UI can
   * surface "X rows updated, Y didn't match an API record".
   */
  /**
   * UCB B6: import spot trade-history из CSV/XLSX-выгрузки биржи.
   * Клиент парсит файл и шлёт нормализованные rows. Upsert по
   * (cex_account_id, exchange_trade_id) — повторные импорты idempotent.
   */
  route.post(
    "/:id/trades/import-csv",
    {
      schema: {
        params: idParam,
        body: tradesCsvImportBody,
        response: { 200: tradesCsvImportResponse },
      },
    },
    async (req) => {
      const u = req.user;
      if (!u) throw new UnauthorizedError();
      return opts.service.importTradesCsv(
        req.params.id,
        u.id,
        req.body.rows.map((r) => ({
          exchangeTradeId: r.exchangeTradeId,
          symbol: r.symbol,
          side: r.side,
          amount: r.amount,
          price: r.price,
          cost: r.cost,
          feeCurrency: r.feeCurrency ?? null,
          feeAmount: r.feeAmount ?? null,
          executedAt: r.executedAt,
        })),
      );
    },
  );

  route.post(
    "/:id/p2p-orders/import-csv",
    {
      schema: {
        params: idParam,
        body: p2pCsvImportBody,
        response: { 200: p2pCsvImportResponse },
      },
    },
    async (req) => {
      const u = req.user;
      if (!u) throw new UnauthorizedError();
      const rows = req.body.rows.map((r) => ({
        orderId: r.orderId,
        fiatCurrency: r.fiatCurrency,
        fiatAmount: r.fiatAmount,
        ...(r.unitPrice !== undefined ? { unitPrice: r.unitPrice } : {}),
        ...(r.counterparty !== undefined
          ? { counterparty: r.counterparty }
          : {}),
        ...(r.paymentMethod !== undefined
          ? { paymentMethod: r.paymentMethod }
          : {}),
      }));
      return opts.service.importP2pCsv(req.params.id, u.id, rows);
    }
  );

  /**
   * Pull a fresh snapshot + new trades since last sync. Returns a result
   * payload even on failure so the UI can surface the error inline
   * without spinning up a 5xx-handling code path.
   */
  route.post(
    "/:id/sync",
    {
      schema: {
        params: idParam,
        response: { 200: syncResponse },
      },
    },
    async (req) => {
      const u = req.user;
      if (!u) throw new UnauthorizedError();
      try {
        return await opts.service.sync(req.params.id, u.id);
      } catch (e) {
        if ((e as Error).message?.includes("not found")) {
          throw new NotFoundError("CEX account not found.");
        }
        throw e;
      }
    }
  );

  /**
   * UCB B1.4: re-probe permissions (без полного sync). Используется
   * после того как юзер на бирже сменил permissions API-key'а
   * (например, включил Read Spot Trade History) — UI после этого
   * вызывает этот endpoint, получает свежий snapshot и обновляет
   * карточку без долгого balance-fetch.
   */
  route.post(
    "/:id/reprobe",
    {
      schema: {
        params: idParam,
        response: { 200: reProbeResponse },
      },
    },
    async (req) => {
      const u = req.user;
      if (!u) throw new UnauthorizedError();
      const perms = await opts.service.reProbe(req.params.id, u.id);
      return {
        ok: perms !== null,
        permissions: perms ?? null,
      };
    }
  );
}
