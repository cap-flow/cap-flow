/**
 * BullMQ worker entry point — a long-running process distinct from the API.
 *
 * Responsibilities:
 *   1. Subscribe to the `portfolio-refresh` queue and run jobs.
 *   2. Subscribe to the `payment-monitor` queue (Phase 8) and run scans.
 *   3. On boot, ensure every active account has a recurring refresh job
 *      scheduled + the payment-monitor cron is in place (idempotent).
 *   4. Graceful shutdown on SIGTERM / SIGINT.
 */
import { createDbClient } from "@cap-flow/db";
import { Worker } from "bullmq";
import { Redis } from "ioredis";
import pino from "pino";

import { loadEnv } from "./config/env.js";
import { AccountsRepository } from "./modules/accounts/accounts.repository.js";
import { AuditRepository } from "./modules/audit/audit.repository.js";
import { AuditService } from "./modules/audit/audit.service.js";
import { BillingRepository } from "./modules/billing/billing.repository.js";
import {
  EtherscanUsdtClient,
  MockBlockchainProvider,
  TronscanClient,
} from "./modules/billing/blockchain-providers.js";
import { PaymentMonitorService } from "./modules/billing/payment-monitor.service.js";
import { ApiUsageRepository } from "./modules/api-usage/api-usage.repository.js";
import {
  ChainClassifierService,
  type EvmHistoryFetcher,
  type SolanaHistoryFetcher,
} from "./modules/classifier/chain_classifier.service.js";
import { FeatureFlagsRepository } from "./modules/feature-flags/feature-flags.repository.js";
import { FeatureFlagsService } from "./modules/feature-flags/feature-flags.service.js";
import { DeBankClient } from "./modules/integrations/debank.js";
import { HeliusClient } from "./modules/integrations/helius.js";
import { OperationsRepository } from "./modules/operations/operations.repository.js";
import { ChainOpsRepository } from "./modules/chain-ops/chain-ops.repository.js";
import { PortfolioRefreshService } from "./modules/portfolio/portfolio-refresh.service.js";
import { PortfolioRepository } from "./modules/portfolio/portfolio.repository.js";
import { WalletsRepository } from "./modules/wallets/wallets.repository.js";
import { JsonCache } from "./modules/redis/cache.js";
import { createBullConnection } from "./modules/queue/connection.js";
import {
  PAYMENT_MONITOR_QUEUE,
  PaymentMonitorQueue,
  type PaymentMonitorJobData,
} from "./modules/queue/payment-monitor.queue.js";
import {
  PORTFOLIO_REFRESH_QUEUE,
  PortfolioRefreshQueue,
  type PortfolioRefreshJobData,
} from "./modules/queue/portfolio-refresh.queue.js";
import { PortfolioRefreshProcessor } from "./modules/queue/portfolio-refresh.processor.js";
import { OpPricingService } from "./modules/ucb/op-pricing.service.js";
import { OpPricingRepository } from "./modules/ucb/op-pricing.repository.js";
import { OpPricingFillService } from "./modules/ucb/op-pricing-fill.service.js";
import {
  OP_PRICING_FILL_QUEUE,
  OpPricingFillQueue,
  type OpPricingFillJobData,
} from "./modules/queue/op-pricing-fill.queue.js";
import { UcbOpsRepository } from "./modules/ucb/ucb-ops.repository.js";
import { UcbShadowRepository } from "./modules/ucb/ucb-shadow.repository.js";
import { UcbShadowService } from "./modules/ucb/ucb-shadow.service.js";
import {
  UcbShadowRunner,
  type CexCostBasisSource,
  type DeBankRawSource,
  type EvmWalletRow,
  type WalletAddressSource,
} from "./modules/ucb/ucb-shadow-runner.js";
import type {
  DeBankComplexProtocol,
  DeBankTokenBalance,
} from "./modules/ucb/debank-live.adapter.js";
import type { CexCostBasisMatch } from "@cap-flow/ucb/position_coverage";
import { CexRepository } from "./modules/cex/cex.repository.js";
import { CexCostBasisService } from "./modules/cex/cex.cost-basis.service.js";
import { HistoricalFxService } from "./modules/cex/historical-fx.service.js";
import { DepositSeedsRepository } from "./modules/cex/deposit-seeds.repository.js";
import { DepositSeedsService } from "./modules/cex/deposit-seeds.service.js";
import { UpstreamProxyService } from "./modules/upstream-proxy/upstream-proxy.service.js";
import { KrystalClient } from "./modules/integrations/krystal.js";
import { KrystalV3Source } from "./modules/ucb/krystal-v3.source.js";
import { EtherscanClient } from "./modules/integrations/etherscan.js";
import {
  AlchemyTransfersClient,
  isAlchemyChainSupported,
} from "./modules/integrations/alchemy-transfers.js";
import { NonLpOpenerSource } from "./modules/ucb/non-lp-opener.source.js";
import { V3EnrichmentSource } from "./modules/ucb/v3-enrichment.source.js";
import { fetchHistoricalPrices } from "./modules/classifier/defillama_prices.js";
import { LotMethodologyRepository } from "./modules/preferences/lot-methodology.repository.js";

const REFRESH_EVERY_MS = 60 * 60 * 1000; // 1 hour
/** `@cap-flow/ucb` engine version stamp for shadow rows (B5). */
const UCB_ENGINE_VERSION = "ucb-server@dev";
const JITTER_MS = 60 * 60 * 1000;
const PAYMENT_SCAN_EVERY_MS = 5 * 60 * 1000; // 5 minutes
/** UCB B1: op-pricing cache-fill sweep cadence (deterministic block prices). */
const OP_PRICING_FILL_EVERY_MS = 30 * 60 * 1000; // 30 minutes

async function main(): Promise<void> {
  const env = loadEnv();
  const logger = pino({
    level: env.LOG_LEVEL,
    ...(env.NODE_ENV === "development"
      ? { transport: { target: "pino-pretty" } }
      : {}),
  });

  logger.info("[worker] starting…");

  // M8: worker uses a smaller pool by default — its BullMQ concurrency
  // cap already throttles parallel DB usage, no need for API-sized pool.
  const dbClient = createDbClient({
    connectionString: env.DATABASE_URL,
    max: env.DB_POOL_MAX_WORKER,
    idleTimeoutMillis: env.DB_POOL_IDLE_MS,
  });
  const bullConn = createBullConnection(env.REDIS_URL);

  const accountsRepo = new AccountsRepository(dbClient.db);
  const auditRepo = new AuditRepository(dbClient.db);
  const audit = new AuditService(auditRepo);
  const portfolioRepo = new PortfolioRepository(dbClient.db);
  const walletsRepo = new WalletsRepository(dbClient.db);
  const apiUsageRepo = new ApiUsageRepository(dbClient.db);
  const debankClient = new DeBankClient(env.DEBANK_API_KEY);
  const heliusClient = new HeliusClient(env.HELIUS_API_KEY);
  const operationsRepo = new OperationsRepository(dbClient.db);
  const chainOpsRepo = new ChainOpsRepository(dbClient.db);

  // Feature-flags resolver — needed by ChainClassifierService (P5.7).
  // A dedicated ioredis connection (separate from BullMQ's) backs the
  // JSON cache so flag reads don't compete with queue traffic.
  const redisForFlags = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
  });
  const flagsCache = new JsonCache(redisForFlags);
  const featureFlagsRepo = new FeatureFlagsRepository(dbClient.db);
  const featureFlagsService = new FeatureFlagsService(
    featureFlagsRepo,
    flagsCache,
    audit,
    { cacheTtlSeconds: 30 }
  );
  // P5.8: real history fetchers wired up. DeBank/Helius return loose
  // `Record<string, unknown>` shapes; the classifier owns strict
  // re-parsing in `classifier/{debank,helius}_types.ts`. One cast at
  // the boundary is honest — anything stricter would just duplicate
  // the provider's contract.
  const evmHistoryFetcher: EvmHistoryFetcher = async (address) =>
    (await debankClient.getHistory(address)) as unknown as Awaited<
      ReturnType<EvmHistoryFetcher>
    >;
  const solHistoryFetcher: SolanaHistoryFetcher = async (address) =>
    (await heliusClient.getTransactions(address)) as unknown as Awaited<
      ReturnType<SolanaHistoryFetcher>
    >;
  const chainClassifier = new ChainClassifierService(
    featureFlagsService,
    evmHistoryFetcher,
    solHistoryFetcher
  );

  const refreshService = new PortfolioRefreshService(
    portfolioRepo,
    audit,
    walletsRepo,
    debankClient,
    heliusClient,
    apiUsageRepo,
    operationsRepo,
    chainClassifier,
    chainOpsRepo, // UCB B5.5: persist classified ops в chain_operations
  );
  const processor = new PortfolioRefreshProcessor(refreshService);
  const refreshQueue = new PortfolioRefreshQueue(bullConn);

  // ─── UCB B5 server-shadow (flag-gated, default OFF) ────────────────
  // Computes canonical positions server-side via @cap-flow/ucb after each
  // refresh and stores them in ucb_shadow_results. NEVER serves; inert unless
  // `capflow.feature.ucbServerShadow` is ON for the account. Fail-soft.
  // Upstream proxy (admin keys + retry) — shared by Krystal (B3) and the B4
  // Etherscan/Alchemy opener fetch below.
  const upstreamProxy = new UpstreamProxyService({
    DEBANK_API_KEY: env.DEBANK_API_KEY,
    HELIUS_API_KEY: env.HELIUS_API_KEY,
    ETHERSCAN_API_KEY: env.ETHERSCAN_API_KEY,
    ALCHEMY_API_KEY: env.ALCHEMY_API_KEY,
    KRYSTAL_API_KEY: env.KRYSTAL_API_KEY,
  });
  // B4: non-LP opener source — Etherscan/Alchemy receipt-token openers + OUT-side
  // cost basis for non-V3-LP positions. Injected into the shadow service; inert
  // unless the shadow flag is ON (the service only computes when flagged).
  const ucbNonLpOpenerSource = new NonLpOpenerSource({
    etherscan: new EtherscanClient(upstreamProxy),
    alchemy: new AlchemyTransfersClient(upstreamProxy),
    fetchHistoricalPrices,
    isAlchemyChainSupported,
  });
  // B3-full: non-Krystal V3 enrichment (Etherscan events via the proxy + viem
  // slot0 reads via the direct Alchemy admin endpoint).
  const ucbV3EnrichmentSource = new V3EnrichmentSource({
    etherscan: new EtherscanClient(upstreamProxy),
    alchemyKey: env.ALCHEMY_API_KEY,
    fetchHistoricalPrices,
  });
  // Per-account methodology = the account owner's saved FIFO/LIFO/WAC/HIFO choice
  // (users.lot_methodology, default FIFO) so the shadow compute matches the user's UI.
  const ucbLotMethodologyRepo = new LotMethodologyRepository(dbClient.db);
  const ucbMethodologyResolver = {
    forAccount: async (accountId: string) => {
      const account = await accountsRepo.findById(accountId);
      if (!account) return "FIFO" as const;
      return (await ucbLotMethodologyRepo.get(account.ownerId)) ?? "FIFO";
    },
  };
  const ucbShadowService = new UcbShadowService({
    opsRepo: new UcbOpsRepository(dbClient.db),
    shadowRepo: new UcbShadowRepository(dbClient.db),
    opPricingService: new OpPricingService(new OpPricingRepository(dbClient.db)),
    flags: featureFlagsService,
    engineVersion: UCB_ENGINE_VERSION,
    nonLpOpenerSource: ucbNonLpOpenerSource,
    v3EnrichmentSource: ucbV3EnrichmentSource,
    methodologyResolver: ucbMethodologyResolver,
  });
  // Bind the DeBank client to the adapter's RAW input shape (same JSON, cast at
  // the boundary — mirrors the evmHistoryFetcher cast above).
  const ucbDebankSource: DeBankRawSource = {
    complexProtocolList: async (addr) =>
      (await debankClient.getRawComplexProtocols(
        addr,
      )) as unknown as DeBankComplexProtocol[],
    allTokens: async (addr) =>
      (await debankClient.getRawTokenList(
        addr,
      )) as unknown as DeBankTokenBalance[],
    totalBalance: async (addr) => ({
      total_usd_value: (await debankClient.getTotalBalance(addr)).totalUsdValue,
    }),
  };
  const ucbWalletSource: WalletAddressSource = {
    evmWalletsForAccount: async (accountId) => {
      const out: EvmWalletRow[] = [];
      for (const w of await walletsRepo.listByAccount(accountId)) {
        const evm = (await walletsRepo.listAddresses(w.id)).find(
          (a) => a.type === "evm",
        );
        if (evm)
          out.push({
            id: w.id,
            name: w.name,
            createdAt: w.createdAt,
            address: evm.address,
          });
      }
      return out;
    },
  };
  // B2: server-side CEX withdrawal cost basis (account → ownerId → computeForUser),
  // mapped to the same `cexCostBasisByHash` shape the client builds.
  const ucbCexCostBasis = new CexCostBasisService(
    new CexRepository(dbClient.db),
    new HistoricalFxService(dbClient.db),
    new DepositSeedsService(new DepositSeedsRepository(dbClient.db), audit),
  );
  const ucbCexSource: CexCostBasisSource = {
    byHashForAccount: async (accountId) => {
      const m = new Map<string, CexCostBasisMatch>();
      const account = await accountsRepo.findById(accountId);
      if (!account) return m;
      for (const c of await ucbCexCostBasis.computeForUser(account.ownerId)) {
        m.set(c.txHash.toLowerCase(), {
          costBasisUsd: c.costBasisUsd,
          source: c.source,
          asset: c.asset,
        });
      }
      return m;
    },
  };
  // B3: Krystal V3 enrichment over the upstream proxy (KC-APIKey + retry).
  const ucbKrystalSource = new KrystalV3Source({
    client: new KrystalClient(upstreamProxy),
    walletSource: ucbWalletSource,
  });
  const ucbShadowRunner = new UcbShadowRunner({
    debank: ucbDebankSource,
    walletSource: ucbWalletSource,
    shadowService: ucbShadowService,
    flags: featureFlagsService,
    cexSource: ucbCexSource,
    krystalSource: ucbKrystalSource,
  });

  const billingRepo = new BillingRepository(dbClient.db);
  // Real providers if their keys are set, else mock (always-empty). The
  // monitor pipeline runs cleanly either way.
  const tronscan = env.TRONSCAN_API_KEY
    ? new TronscanClient(env.TRONSCAN_API_KEY)
    : new MockBlockchainProvider("trc20");
  const etherscanUsdt = env.ETHERSCAN_API_KEY
    ? new EtherscanUsdtClient(env.ETHERSCAN_API_KEY)
    : new MockBlockchainProvider("erc20");
  const paymentMonitor = new PaymentMonitorService(
    billingRepo,
    [tronscan, etherscanUsdt],
    audit,
    {
      price3m: env.BILLING_PRICE_3M_USD,
      price6m: env.BILLING_PRICE_6M_USD,
      price12m: env.BILLING_PRICE_12M_USD,
      minConfirmationsTrc20: env.BILLING_MIN_CONFIRMATIONS_TRC20,
      minConfirmationsErc20: env.BILLING_MIN_CONFIRMATIONS_ERC20,
    }
  );
  const paymentQueue = new PaymentMonitorQueue(bullConn);

  // ─── UCB B1 op-pricing cache-fill (cache-only, no flag, fail-soft) ──
  // Warms `op_token_prices` with deterministic block-fixed DefiLlama prices for
  // every active account's ops, so server cost basis stops depending on the
  // per-sync `movement.usd` (POS-005 / duplicate_op_divergent_pricing). Serves
  // nothing; safe to run unconditionally.
  const opPricingFillService = new OpPricingFillService({
    accounts: accountsRepo,
    opsRepo: new UcbOpsRepository(dbClient.db),
    opPricing: new OpPricingService(new OpPricingRepository(dbClient.db)),
    logger: {
      info: (msg, meta) => logger.info(meta ?? {}, msg),
      warn: (msg, meta) => logger.warn(meta ?? {}, msg),
    },
  });
  const opPricingFillQueue = new OpPricingFillQueue(bullConn);

  // ─── refresh worker ───────────────────────────────────────────────
  const refreshWorker = new Worker<PortfolioRefreshJobData>(
    PORTFOLIO_REFRESH_QUEUE,
    async (job) => {
      const result = await processor.process(job);
      // UCB B5 shadow — flag-gated inside run() (no DeBank fetch when OFF),
      // fail-soft so it can NEVER break the refresh job.
      try {
        const shadow = await ucbShadowRunner.run(job.data.accountId);
        if (!shadow.skipped) {
          logger.info(
            {
              accountId: job.data.accountId,
              shadowId: shadow.id,
              positions: shadow.positionCount,
              error: shadow.error,
            },
            "[worker] ucb shadow stored"
          );
        }
      } catch (err) {
        logger.warn(
          { accountId: job.data.accountId, err: (err as Error).message },
          "[worker] ucb shadow failed (refresh unaffected)"
        );
      }
      return result;
    },
    { connection: bullConn, concurrency: 5 }
  );
  refreshWorker.on("completed", (job) => {
    logger.info(
      { jobId: job.id, accountId: job.data.accountId, trigger: job.data.trigger },
      "[worker] refresh completed"
    );
  });
  refreshWorker.on("failed", (job, err) => {
    logger.error(
      { jobId: job?.id, accountId: job?.data.accountId, err: err.message },
      "[worker] refresh failed"
    );
  });

  // ─── payment monitor worker ───────────────────────────────────────
  const monitorWorker = new Worker<PaymentMonitorJobData>(
    PAYMENT_MONITOR_QUEUE,
    async (job) => {
      const result = await paymentMonitor.scan();
      logger.info(
        { jobId: job.id, trigger: job.data.trigger, ...result },
        "[worker] payment scan"
      );
      return result;
    },
    { connection: bullConn, concurrency: 1 }
  );
  monitorWorker.on("failed", (job, err) => {
    logger.error(
      { jobId: job?.id, err: err.message },
      "[worker] payment scan failed"
    );
  });

  // ─── op-pricing cache-fill worker (UCB B1) ────────────────────────
  // Worker-scoped abort so a long sweep yields promptly on shutdown (BullMQ has
  // no per-job AbortSignal; the service honors this mid-sweep + in fillMissing).
  const opPricingFillAbort = new AbortController();
  const opPricingFillWorker = new Worker<OpPricingFillJobData>(
    OP_PRICING_FILL_QUEUE,
    async (job) => {
      const result = await opPricingFillService.run(opPricingFillAbort.signal);
      logger.info(
        { jobId: job.id, trigger: job.data.trigger, ...result },
        "[worker] op-pricing cache-fill"
      );
      return result;
    },
    { connection: bullConn, concurrency: 1 }
  );
  opPricingFillWorker.on("failed", (job, err) => {
    logger.error(
      { jobId: job?.id, err: err.message },
      "[worker] op-pricing cache-fill failed"
    );
  });

  // ─── bootstrap recurring schedules ────────────────────────────────
  const activeAccounts = await accountsRepo.findAllActive();
  for (const acc of activeAccounts) {
    await refreshQueue.scheduleRecurring(acc.id, {
      everyMs: REFRESH_EVERY_MS,
      jitterMs: JITTER_MS,
    });
  }
  await paymentQueue.scheduleRecurring({ everyMs: PAYMENT_SCAN_EVERY_MS });
  await opPricingFillQueue.scheduleRecurring({
    everyMs: OP_PRICING_FILL_EVERY_MS,
  });
  logger.info(
    {
      accounts: activeAccounts.length,
      paymentScanEveryMs: PAYMENT_SCAN_EVERY_MS,
      opPricingFillEveryMs: OP_PRICING_FILL_EVERY_MS,
    },
    "[worker] recurring schedules in place"
  );

  // ─── graceful shutdown ────────────────────────────────────────────
  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "[worker] shutting down…");
    try {
      opPricingFillAbort.abort(); // yield an in-flight sweep before closing
      await refreshWorker.close();
      await monitorWorker.close();
      await opPricingFillWorker.close();
      await refreshQueue.close();
      await paymentQueue.close();
      await opPricingFillQueue.close();
      await dbClient.close();
      bullConn.disconnect();
      process.exit(0);
    } catch (err) {
      logger.error({ err }, "[worker] shutdown error");
      process.exit(1);
    }
  };
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.once(sig, () => void shutdown(sig));
  }
}

main().catch((err: unknown) => {
  console.error("[worker] fatal:", err);
  process.exit(1);
});
