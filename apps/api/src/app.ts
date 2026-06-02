import { sql } from "drizzle-orm";

import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import sensible from "@fastify/sensible";
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";

import { loadEnv, type Env } from "./config/env.js";
import { AccountsRepository } from "./modules/accounts/accounts.repository.js";
import { accountsRoutes } from "./modules/accounts/accounts.routes.js";
import { AccountsService } from "./modules/accounts/accounts.service.js";
import { BillingRepository } from "./modules/billing/billing.repository.js";
import { billingRoutes } from "./modules/billing/billing.routes.js";
import { adminBillingRoutes } from "./modules/billing/billing.routes.admin.js";
import { BillingService } from "./modules/billing/billing.service.js";
import { adminAuditRoutes } from "./modules/admin-audit/admin-audit.routes.js";
import { AdminAuditService } from "./modules/admin-audit/admin-audit.service.js";
import { adminIntegrationsRoutes } from "./modules/admin-integrations/admin-integrations.routes.js";
import { AdminIntegrationsService } from "./modules/admin-integrations/admin-integrations.service.js";
import {
  decryptSecret,
  deriveKey,
  isEncrypted,
} from "./modules/admin-integrations/secret-cipher.js";
import { adminMetricsRoutes } from "./modules/admin-metrics/admin-metrics.routes.js";
import { AdminMetricsService } from "./modules/admin-metrics/admin-metrics.service.js";
import { adminPortfoliosRoutes } from "./modules/admin-portfolios/admin-portfolios.routes.js";
import { AdminPortfoliosService } from "./modules/admin-portfolios/admin-portfolios.service.js";
import { adminOperationsRoutes } from "./modules/admin-operations/admin-operations.routes.js";
import { AdminOperationsService } from "./modules/admin-operations/admin-operations.service.js";
import { adminQueueRoutes } from "./modules/admin-queue/admin-queue.routes.js";
import { adminHealthRoutes } from "./modules/admin-health/admin-health.routes.js";
import { registerAdminQueueUi } from "./modules/admin-queue/admin-queue.ui.js";
import { createCexClient } from "./modules/cex/cex.client.js";
import { CexRepository } from "./modules/cex/cex.repository.js";
import { cexRoutes } from "./modules/cex/cex.routes.js";
import {
  ChainOpsRepository,
  walletBelongsToUser,
} from "./modules/chain-ops/chain-ops.repository.js";
import { ChainOpsService } from "./modules/chain-ops/chain-ops.service.js";
import { chainOpsRoutes } from "./modules/chain-ops/chain-ops.routes.js";
import { ucbRoutes } from "./modules/ucb/ucb.routes.js";
import { ucbAdminRoutes } from "./modules/ucb/ucb-admin.routes.js";
import { LotMethodologyRepository } from "./modules/preferences/lot-methodology.repository.js";
import { lotMethodologyRoutes } from "./modules/preferences/lot-methodology.routes.js";
import { anomalyAdminRoutes } from "./modules/anomaly/anomaly-admin.routes.js";
import { UcbShadowRepository } from "./modules/ucb/ucb-shadow.repository.js";
import { AnnotationsRepository } from "./modules/chain-ops/annotations.repository.js";
import { AnnotationsService } from "./modules/chain-ops/annotations.service.js";
import { annotationsRoutes } from "./modules/chain-ops/annotations.routes.js";
import { GoldenRepository } from "./modules/golden/golden.repository.js";
import { GoldenService } from "./modules/golden/golden.service.js";
import { goldenRoutes } from "./modules/golden/golden.routes.js";
import { SyncCoverageService } from "./modules/sync-coverage/sync-coverage.service.js";
import { syncCoverageRoutes } from "./modules/sync-coverage/sync-coverage.routes.js";
import { CexService } from "./modules/cex/cex.service.js";
import { CexValuationService } from "./modules/cex/cex.valuation.service.js";
import { CexCostBasisService } from "./modules/cex/cex.cost-basis.service.js";
import { HistoricalFxService } from "./modules/cex/historical-fx.service.js";
import { DepositSeedsRepository } from "./modules/cex/deposit-seeds.repository.js";
import { DepositSeedsService } from "./modules/cex/deposit-seeds.service.js";
import { CexTaxEventsService } from "./modules/cex/cex-tax-events.service.js";
import { CexAssetGapService } from "./modules/cex/cex-asset-gap.service.js";
import { createP2pClient } from "./modules/cex/cex.p2p.factory.js";
import { CexProxyState } from "./modules/cex/cex.proxy-state.js";
import {
  RedisRateLimitStore,
  UpstreamRateLimitService,
} from "./modules/upstream-proxy/rate-limit.js";
import { UpstreamProxyService } from "./modules/upstream-proxy/upstream-proxy.service.js";
import { upstreamProxyRoutes } from "./modules/upstream-proxy/upstream-proxy.routes.js";
import { adminTechAuditRoutes } from "./modules/admin-tech-audit/admin-tech-audit.routes.js";
import { AdminTechAuditService } from "./modules/admin-tech-audit/admin-tech-audit.service.js";
import { adminUsersRoutes } from "./modules/admin-users/admin-users.routes.js";
import { AdminUsersService } from "./modules/admin-users/admin-users.service.js";
import { adminUsageRoutes } from "./modules/admin-usage/admin-usage.routes.js";
import { adminFeatureFlagsRoutes } from "./modules/feature-flags/feature-flags.routes.admin.js";
import { publicFeatureFlagsRoutes } from "./modules/feature-flags/feature-flags.routes.public.js";
import { FeatureFlagsRepository } from "./modules/feature-flags/feature-flags.repository.js";
import { FeatureFlagsService } from "./modules/feature-flags/feature-flags.service.js";
import { ApiUsageRepository } from "./modules/api-usage/api-usage.repository.js";
import { authRoutes } from "./modules/auth/auth.routes.js";
import { AlchemyClient } from "./modules/integrations/alchemy.js";
import { CoinGeckoClient } from "./modules/integrations/coingecko.js";
import { DeBankClient } from "./modules/integrations/debank.js";
import { QuotedPriceProvider } from "./modules/integrations/quoted-provider.js";
import { pricesRoutes } from "./modules/prices/prices.routes.js";
import { PricesRepository } from "./modules/prices/prices.repository.js";
import { PricesService } from "./modules/prices/prices.service.js";
import { PortfolioRefreshService } from "./modules/portfolio/portfolio-refresh.service.js";
import { portfolioRoutes } from "./modules/portfolio/portfolio.routes.js";
import { PortfolioRepository } from "./modules/portfolio/portfolio.repository.js";
import { createBullConnection } from "./modules/queue/connection.js";
import { PortfolioRefreshQueue } from "./modules/queue/portfolio-refresh.queue.js";
import { JsonCache } from "./modules/redis/cache.js";
import { TokenBucket } from "./modules/redis/token-bucket.js";
import { WalletsRepository } from "./modules/wallets/wallets.repository.js";
import { walletsRoutes } from "./modules/wallets/wallets.routes.js";
import { WalletsService } from "./modules/wallets/wallets.service.js";
import { OperationsRepository } from "./modules/operations/operations.repository.js";
import { operationsRoutes } from "./modules/operations/operations.routes.js";
import { OperationsService } from "./modules/operations/operations.service.js";
import { EmailClient } from "./modules/notifications/email-client.js";
import { NotificationSubscriptionsRepository } from "./modules/notifications/notification-subscriptions.repository.js";
import { notificationsRoutes } from "./modules/notifications/notifications.routes.js";
import { NotificationsService } from "./modules/notifications/notifications.service.js";
import { TelegramRepository } from "./modules/telegram/telegram.repository.js";
import { telegramRoutes } from "./modules/telegram/telegram.routes.js";
import { TelegramService } from "./modules/telegram/telegram.service.js";
import { TelegramProxyState } from "./modules/telegram/telegram.proxy.js";
import { TelegramPoller } from "./modules/telegram/telegram.poller.js";
import {
  telegramWebhookRoutes,
  telegramWebhookAdminRoutes,
} from "./modules/telegram/telegram.webhook.routes.js";
import { TelegramSignupRepository } from "./modules/auth-telegram-signup/signup.repository.js";
import { TelegramSignupService } from "./modules/auth-telegram-signup/signup.service.js";
import { telegramSignupRoutes } from "./modules/auth-telegram-signup/signup.routes.js";
import { passwordResetRoutes } from "./modules/auth/password-reset.routes.js";
import { emailVerificationRoutes } from "./modules/auth/email-verification.routes.js";
import { EmailVerificationRepository } from "./modules/auth/email-verification.repository.js";
import { EmailVerificationService } from "./modules/auth/email-verification.service.js";
import { PasswordResetRepository } from "./modules/auth/password-reset.repository.js";
import { PasswordResetService } from "./modules/auth/password-reset.service.js";
import { adminInviteRoutes } from "./modules/invites/invites.routes.admin.js";
import { publicInviteRoutes } from "./modules/invites/invites.routes.public.js";
import { InvitesRepository } from "./modules/invites/invites.repository.js";
import { InvitesService } from "./modules/invites/invites.service.js";
import { authPlugin } from "./plugins/auth.js";
import { csrfPlugin } from "./plugins/csrf.js";
import { dbPlugin } from "./plugins/db.js";
import { schema } from "@cap-flow/db";
import { errorHandlerPlugin } from "./plugins/error-handler.js";
import { redisPlugin } from "./plugins/redis.js";

export interface BuildAppOptions {
  readonly env?: Env;
}

export async function buildApp(opts: BuildAppOptions = {}): Promise<FastifyInstance> {
  const env = opts.env ?? loadEnv();

  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      // H14 (2026-05-14): redact known secret-bearing fields BEFORE they
      // hit any log sink. Affects both built-in request-log and explicit
      // app.log.* calls. Patterns use pino's standard dot-notation.
      //
      // Caveat: pino redact is a fast static-path walker — anything
      // dynamically structured (e.g. logging the full `req` object) is
      // not deeply scanned. Use redact + careful logging together;
      // don't log raw bodies at debug level either.
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.headers["x-api-key"]',
          'res.headers["set-cookie"]',
          '*.password',
          '*.passwordHash',
          '*.password_hash',
          '*.tokenHash',
          '*.token_hash',
          '*.sessionTokenHash',
          '*.refreshToken',
          '*.refresh_token',
          '*.accessToken',
          '*.access_token',
          'body.password',
          'body.token',
        ],
        censor: '[REDACTED]',
      },
      ...(env.NODE_ENV === "development"
        ? { transport: { target: "pino-pretty" } }
        : {}),
    },
    trustProxy: true,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(helmet, { global: true });
  await app.register(cors, {
    origin: env.CORS_ORIGIN === "*" ? true : env.CORS_ORIGIN.split(","),
    credentials: true,
  });
  await app.register(sensible);
  await app.register(rateLimit, {
    global: false,
    max: 300,
    timeWindow: "1 minute",
  });
  await app.register(cookie, { secret: env.COOKIE_SECRET });
  await app.register(errorHandlerPlugin);
  // CSRF double-submit guard. Must register AFTER cookie parser (deps)
  // and BEFORE any route — the preHandler hook is added at register
  // time and Fastify applies hooks in registration order.
  await app.register(csrfPlugin);
  await app.register(dbPlugin, {
    connectionString: env.DATABASE_URL,
    poolMax: env.DB_POOL_MAX,
    poolIdleMs: env.DB_POOL_IDLE_MS,
  });
  await app.register(redisPlugin, { url: env.REDIS_URL });

  // Phase S6: load DB-side integration secret overrides into process.env
  // before any upstream client (DeBankClient/AlchemyClient/...) is
  // constructed. DB row wins over the .env value of the same name; this
  // means admin can edit a key via /admin/integrations and the next API
  // boot picks it up without touching the host filesystem.
  //
  // B5: stored values are AES-256-GCM encrypted with a key derived from
  // INTEGRATION_SECRETS_KEY (or COOKIE_SECRET as fallback). Legacy
  // plaintext rows are passed through unchanged.
  try {
    const cipherSeed =
      env.INTEGRATION_SECRETS_KEY && env.INTEGRATION_SECRETS_KEY.length >= 32
        ? env.INTEGRATION_SECRETS_KEY
        : env.COOKIE_SECRET;
    const cipherKey = deriveKey(cipherSeed);
    const overrides = await app.db
      .select()
      .from(schema.integrationSecrets);
    let applied = 0;
    for (const row of overrides) {
      if (!row.value || !row.envVarName || row.envVarName.startsWith("(")) {
        continue;
      }
      let plaintext: string;
      if (isEncrypted(row.value)) {
        try {
          plaintext = decryptSecret(row.value, cipherKey);
        } catch (e) {
          app.log.warn(
            { key: row.key, err: (e as Error).message },
            "[integration_secrets] decrypt failed; skipping (key rotated?)"
          );
          continue;
        }
      } else {
        plaintext = row.value; // legacy unencrypted row
      }
      process.env[row.envVarName] = plaintext;
      applied += 1;
    }
    if (applied > 0) {
      app.log.info(
        { applied },
        "[integration_secrets] DB overrides applied to process.env"
      );
    }
  } catch (e) {
    app.log.warn(
      { err: (e as Error).message },
      "[integration_secrets] failed to apply DB overrides (table missing? run migrate)"
    );
  }
  await app.register(authPlugin, {
    jwtSecret: env.JWT_SECRET,
    accessTtlMinutes: env.JWT_ACCESS_TTL_MIN,
    refreshTtlDays: env.JWT_REFRESH_TTL_DAYS,
  });

  // ─── module instantiation ───────────────────────────────────────────
  const invitesRepo = new InvitesRepository(app.db);
  const accountsRepo = new AccountsRepository(app.db);
  // Refresh queue lives here (not in worker.ts) so accountsService can
  // schedule cron + fire immediate manual refresh at account creation.
  // Worker side imports the same `PortfolioRefreshQueue` class for the
  // bootstrap pass over existing accounts.
  const accountsBullConn = createBullConnection(env.REDIS_URL);
  const accountsRefreshQueue = new PortfolioRefreshQueue(accountsBullConn);
  app.addHook("onClose", async () => {
    await accountsRefreshQueue.close();
    accountsBullConn.disconnect();
  });
  const accountsService = new AccountsService(
    accountsRepo,
    app.audit,
    { userAccountLimit: 1 },
    accountsRefreshQueue
  );
  // AuthRepository is stateless over `app.db`; one instance is enough for
  // every module that needs DB-level access to users/sessions.
  const { AuthRepository } = await import(
    "./modules/auth/auth.repository.js"
  );
  const authRepo = new AuthRepository(app.db);

  // ─── Phase 7: notifications (must exist before invites/password-reset
  //              services that depend on it) ──────────────────────────
  const emailClient = new EmailClient({
    apiKey: env.RESEND_API_KEY,
    fromEmail: env.RESEND_FROM_EMAIL,
    fromName: env.RESEND_FROM_NAME,
  });
  const telegramRepo = new TelegramRepository(app.db);
  const telegramService = new TelegramService(telegramRepo, app.audit, {
    // Live getters: admin PATCH on /admin/integrations/telegram or
    // /telegram_token mutates process.env → next call picks up the new
    // value without a restart. Falls back to boot-time env (which
    // includes the zod default "defiCapflow_bot" for username).
    getBotUsername: () =>
      process.env["TELEGRAM_BOT_USERNAME"]?.trim() || env.TELEGRAM_BOT_USERNAME,
    getBotApiToken: () =>
      process.env["TELEGRAM_BOT_API_TOKEN"]?.trim() ||
      env.TELEGRAM_BOT_API_TOKEN,
    linkTtlMinutes: env.TELEGRAM_LINK_TTL_MIN,
  });
  const notificationSubsRepo = new NotificationSubscriptionsRepository(
    app.db
  );
  const notificationsService = new NotificationsService(
    emailClient,
    telegramService,
    notificationSubsRepo,
    app.audit
  );

  // Email verification — instantiated BEFORE invites so registration via
  // invite can auto-trigger verify-email send.
  const emailVerificationRepo = new EmailVerificationRepository(app.db);
  const emailVerificationService = new EmailVerificationService(
    emailVerificationRepo,
    authRepo,
    {
      ttlHours: env.EMAIL_VERIFY_TTL_HOURS,
      verifyBaseUrl: env.EMAIL_VERIFY_BASE_URL,
    }
  );

  const invitesService = new InvitesService(
    invitesRepo,
    authRepo,
    accountsRepo,
    app.audit,
    notificationsService,
    {
      defaultTtlHours: env.INVITE_TTL_HOURS,
      inviteBaseUrl: env.INVITE_BASE_URL,
      jwtSecret: env.JWT_SECRET,
      accessTtlMinutes: env.JWT_ACCESS_TTL_MIN,
      refreshTtlDays: env.JWT_REFRESH_TTL_DAYS,
    },
    emailVerificationService
  );

  const passwordResetRepo = new PasswordResetRepository(app.db);
  const passwordResetService = new PasswordResetService(
    authRepo,
    passwordResetRepo,
    app.audit,
    notificationsService,
    {
      resetTtlMinutes: env.PASSWORD_RESET_TTL_MIN,
      resetBaseUrl: env.PASSWORD_RESET_BASE_URL,
    }
  );


  const adminUsersService = new AdminUsersService(
    app.db,
    authRepo,
    app.audit,
    {
      jwtSecret: env.JWT_SECRET,
      accessTtlMinutes: env.JWT_ACCESS_TTL_MIN,
      refreshTtlDays: env.JWT_REFRESH_TTL_DAYS,
      impersonationTtlMinutes: env.IMPERSONATION_TTL_MIN,
    }
  );

  // ─── Phase 5: admin dashboard services ─────────────────────────────
  const adminPortfoliosService = new AdminPortfoliosService(app.db);
  const adminOperationsService = new AdminOperationsService(app.db);
  const adminMetricsService = new AdminMetricsService(app.db);
  const adminIntegrationsService = new AdminIntegrationsService(app.db, env);
  const adminAuditService = new AdminAuditService(app.db);
  const adminTechAuditService = new AdminTechAuditService(app.db);

  // ─── Phase 3: cache, quotas, providers ──────────────────────────────
  const cache = new JsonCache(app.redis);
  const tokenBucket = new TokenBucket(app.redis);
  const apiUsageRepo = new ApiUsageRepository(app.db);

  const coingeckoClient = new CoinGeckoClient(env.COINGECKO_API_KEY);
  const quotedCoingecko = new QuotedPriceProvider(
    coingeckoClient,
    cache,
    tokenBucket,
    apiUsageRepo,
    { cacheTtlSeconds: env.CACHE_PRICE_TTL_SEC }
  );

  const pricesRepo = new PricesRepository(app.db);
  const pricesService = new PricesService(pricesRepo, quotedCoingecko, {
    perUserDailyLimit: env.QUOTA_COINGECKO_PER_DAY,
  });

  // ─── Phase 4: portfolio refresh queue (API side only — the *worker* lives
  //              in worker.ts and pulls from this same queue) ─────────────
  // Reuse the queue+connection created above for accountsService, so we
  // don't open two TCP connections to Redis for the same logical queue.
  const refreshQueue = accountsRefreshQueue;
  const portfolioRepo = new PortfolioRepository(app.db);

  // The API doesn't *process* jobs — it just enqueues them on
  // POST /accounts/:id/refresh and reads counts for the status endpoint.
  // The service exists here only because the route file is shared via DI.
  void PortfolioRefreshService;

  // ─── Phase 3b: wallets CRUD + real refresh service ────────────────
  const walletsRepo = new WalletsRepository(app.db);
  const walletsService = new WalletsService(
    walletsRepo,
    accountsService,
    app.audit
  );
  // These clients are constructed here so admin endpoints (and any
  // future ad-hoc tools) can access them; the worker has its own
  // instances bootstrapped in worker.ts.
  void new DeBankClient(env.DEBANK_API_KEY);
  void new AlchemyClient(env.ALCHEMY_API_KEY);

  // ─── Phase 4a/4b: operations ledger (cost basis source) ───────────
  const operationsRepo = new OperationsRepository(app.db);
  const operationsService = new OperationsService(
    operationsRepo,
    accountsService,
    app.audit
  );

  // ─── Phase 6: feature flags ────────────────────────────────────────
  const featureFlagsRepo = new FeatureFlagsRepository(app.db);
  const featureFlagsService = new FeatureFlagsService(
    featureFlagsRepo,
    cache,
    app.audit,
    { cacheTtlSeconds: 30 }
  );

  // ─── CEX integrations (CCXT) ──────────────────────────────────────
  // Same cipher-key derivation as admin-integrations: prefer
  // INTEGRATION_SECRETS_KEY, fall back to COOKIE_SECRET so existing
  // deployments don't need a new env var to start using CEX features.
  const cexCipherSeed =
    (env.INTEGRATION_SECRETS_KEY && env.INTEGRATION_SECRETS_KEY.length >= 32
      ? env.INTEGRATION_SECRETS_KEY
      : env.COOKIE_SECRET) ?? "";
  // Optional HTTPS proxy for outgoing CEX traffic (Bybit/OKX/BingX
  // CDN geoblock RU/CIS IPs — see [cex.proxy.ts](./modules/cex/cex.proxy.ts)).
  //
  // CexProxyState caches the parsed agent and is refreshed when an
  // admin updates the value in /admin/integrations → key=cex_proxy.
  // Sources, in order: DB override → CEX_HTTPS_PROXY env → none.
  const cexProxyState = new CexProxyState(
    env.CEX_HTTPS_PROXY,
    () => adminIntegrationsService.getSecret("cex_proxy"),
    app.log
  );
  await cexProxyState.refresh();

  // Optional HTTP(S)/SOCKS proxy for outgoing Telegram Bot API requests
  // (api.telegram.org geoblocked in RU/CIS). Same DB-override → env
  // fallback pattern as cex_proxy.
  const telegramProxyState = new TelegramProxyState(
    env.TELEGRAM_BOT_HTTPS_PROXY,
    () => adminIntegrationsService.getSecret("telegram_proxy"),
    app.log,
  );
  await telegramProxyState.refresh();
  telegramService.attachProxyState(telegramProxyState);

  // Telegram-signup сервис (создаёт аккаунты через бот для anonymous
  // visitor'ов на /login). Должен быть инициализирован ДО poller'а
  // чтобы передать его как dep — иначе /start s_<nonce> попадёт в
  // legacy flow и ответит "Код недействителен".
  const telegramSignupRepo = new TelegramSignupRepository(app.db);
  const telegramSignupService = new TelegramSignupService(
    telegramSignupRepo,
    app.audit,
    {
      siteOrigin: env.SITE_ORIGIN,
      nonceTtlMinutes: 10,
    },
    app.log,
    () =>
      process.env["TELEGRAM_BOT_USERNAME"]?.trim() || env.TELEGRAM_BOT_USERNAME,
  );

  // Long-polling worker: starts only if TELEGRAM_BOT_USE_POLLING=true.
  // Reads bot token live (same getter as webhook routes), so admin can
  // configure the token after boot and polling picks it up on the next
  // iteration without restart.
  if (env.TELEGRAM_BOT_USE_POLLING) {
    const poller = new TelegramPoller({
      getBotApiToken: () =>
        process.env["TELEGRAM_BOT_API_TOKEN"]?.trim() ||
        env.TELEGRAM_BOT_API_TOKEN,
      proxyState: telegramProxyState,
      telegram: telegramService,
      signup: telegramSignupService,
      repository: telegramRepo,
      log: app.log,
    });
    poller.start();
    app.addHook("onClose", async () => {
      await poller.stop();
    });
    app.log.info(
      "[telegram] long-polling worker started (TELEGRAM_BOT_USE_POLLING=true)",
    );
  }

  const cexRepo = new CexRepository(app.db);
  const cexService = new CexService(
    cexRepo,
    app.audit,
    // Bake LIVE proxy into the factory — each connect/sync builds a
    // fresh CCXT client, which means a fresh `currentSync()` lookup
    // and so an updated agent after the admin edits the proxy.
    (exchangeId, creds) =>
      createCexClient(exchangeId, creds, cexProxyState.currentSync()),
    { cipherKey: deriveKey(cexCipherSeed) },
    // Same for P2P clients.
    (exchangeId, creds) =>
      createP2pClient(exchangeId, creds, cexProxyState.currentSync())
  );
  const cexValuation = new CexValuationService(
    cexRepo,
    pricesRepo,
    quotedCoingecko,
    { perUserDailyLimit: env.QUOTA_COINGECKO_PER_DAY }
  );
  // UCB D2: historical FX service для non-USD P2P.
  const historicalFx = new HistoricalFxService(app.db);
  // UCB C1: deposit seeds (client → server cost basis для CEX deposits).
  const depositSeedsRepo = new DepositSeedsRepository(app.db);
  const depositSeeds = new DepositSeedsService(depositSeedsRepo, app.audit);
  const cexCostBasis = new CexCostBasisService(
    cexRepo,
    historicalFx,
    depositSeeds,
  );
  // Tax T4: CEX-side tax events generator (server-side for trade gains).
  const cexTaxEvents = new CexTaxEventsService(cexRepo);
  // Bob-test #5: per-asset gap detector (flags assets where sells/withdraws
  // exceed acquisition trail — usually missing CEX deposits).
  const cexAssetGap = new CexAssetGapService(cexRepo);

  // UCB B5: server-side cache of DeBank/Helius classified on-chain ops.
  const chainOpsRepo = new ChainOpsRepository(app.db);
  const chainOpsService = new ChainOpsService(
    chainOpsRepo,
    {
      walletBelongsToUser: (walletId, userId) =>
        walletBelongsToUser(app.db, walletId, userId),
    },
    app.audit,
    // UCB C2: pass CexRepository для CEX hop detection
    // (interface-compat: только метод listAllTransfersWithHashForUser).
    cexRepo,
  );

  // UCB A3: per-op user annotations (override classifier decisions).
  const annotationsRepo = new AnnotationsRepository(app.db);
  const annotationsService = new AnnotationsService(
    app.db,
    annotationsRepo,
    app.audit,
  );

  // UCB Epic A3: golden cases + anomaly flags (admin-only oracle + findings).
  const goldenRepo = new GoldenRepository(app.db);
  const goldenService = new GoldenService(goldenRepo, app.audit);

  // UCB B4: aggregated sync coverage (wallets + CEX accounts state).
  const syncCoverageService = new SyncCoverageService(app.db);

  // ─── Phase 8: billing ─────────────────────────────────────────────
  const billingRepo = new BillingRepository(app.db);
  const billingService = new BillingService(billingRepo, app.audit, {
    price3m: env.BILLING_PRICE_3M_USD,
    price6m: env.BILLING_PRICE_6M_USD,
    price12m: env.BILLING_PRICE_12M_USD,
    graceDays: env.BILLING_GRACE_DAYS,
    addressPoolTrc20: (env.BILLING_ADDRESS_POOL_TRC20 ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
    addressPoolErc20: (env.BILLING_ADDRESS_POOL_ERC20 ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  });

  // ─── routes ─────────────────────────────────────────────────────────
  //
  // H14: `/health` is the liveness probe (process still alive); `/health/ready`
  // is the readiness probe (process can serve real traffic — DB + Redis
  // are both reachable). Kubernetes / docker-compose / monitoring should
  // distinguish:
  //   - liveness fails  → restart the container
  //   - readiness fails → take container out of load-balancer rotation
  //                       (but DON'T restart — let it heal)
  app.get("/health", async () => ({ status: "ok", uptime: process.uptime() }));

  app.get("/health/ready", async (_req, reply) => {
    const checks = {
      db: "ok" as "ok" | "error",
      redis: "ok" as "ok" | "error",
    };
    let dbError: string | null = null;
    let redisError: string | null = null;

    try {
      await app.db.execute(sql`SELECT 1`);
    } catch (e) {
      checks.db = "error";
      dbError = (e as Error).message.slice(0, 200);
    }

    try {
      const r = await app.redis.ping();
      if (r !== "PONG") {
        checks.redis = "error";
        redisError = `Unexpected PING reply: ${r}`;
      }
    } catch (e) {
      checks.redis = "error";
      redisError = (e as Error).message.slice(0, 200);
    }

    const allOk = checks.db === "ok" && checks.redis === "ok";
    return reply.status(allOk ? 200 : 503).send({
      status: allOk ? "ready" : "degraded",
      uptime: process.uptime(),
      checks,
      ...(dbError ? { dbError } : {}),
      ...(redisError ? { redisError } : {}),
    });
  });

  await app.register(
    async (api) => {
      await api.register(authRoutes, {
        env,
        adminUsers: adminUsersService,
        prefix: "/auth",
      });
      await api.register(passwordResetRoutes, {
        service: passwordResetService,
        prefix: "/auth/password",
      });
      await api.register(emailVerificationRoutes, {
        service: emailVerificationService,
        notifications: notificationsService,
        authRepo,
        prefix: "/auth/email-verification",
      });
      await api.register(publicInviteRoutes, {
        invites: invitesService,
        env,
        prefix: "/invites",
      });
      await api.register(accountsRoutes, {
        accounts: accountsService,
        prefix: "/accounts",
      });
      await api.register(
        async (api2) => {
          await api2.register(pricesRoutes, {
            prices: pricesService,
            accounts: accountsService,
          });
        },
        { prefix: "/accounts/:id/prices" }
      );
      await api.register(portfolioRoutes, {
        accounts: accountsService,
        portfolio: portfolioRepo,
        queue: refreshQueue,
        billing: billingService,
        prefix: "/accounts",
      });
      await api.register(walletsRoutes, {
        service: walletsService,
        prefix: "/accounts",
      });
      await api.register(operationsRoutes, {
        service: operationsService,
        prefix: "/accounts",
      });
      await api.register(cexRoutes, {
        service: cexService,
        valuation: cexValuation,
        costBasis: cexCostBasis,
        depositSeeds,
        cexTaxEvents,
        assetGap: cexAssetGap,
        prefix: "/cex",
      });
      await api.register(chainOpsRoutes, {
        service: chainOpsService,
        prefix: "/chain-ops",
      });
      // UCB B5: shadow-diff observability surface (account-scoped).
      await api.register(ucbRoutes, {
        accounts: accountsService,
        shadowRepo: new UcbShadowRepository(app.db),
        featureFlags: featureFlagsService,
        portfolioRepo,
        prefix: "/accounts",
      });
      await api.register(annotationsRoutes, {
        service: annotationsService,
        prefix: "/chain-ops/annotations",
      });
      await api.register(goldenRoutes, {
        service: goldenService,
        prefix: "/admin/golden",
      });
      // Admin UCB debug: on-demand server compute for any account/email.
      await api.register(ucbAdminRoutes, {
        db: app.db,
        env,
        accountsRepo,
        authRepo,
        prefix: "/admin/ucb",
      });
      // User lot-methodology preference (FIFO/LIFO/WAC/HIFO), persisted server-side.
      await api.register(lotMethodologyRoutes, {
        repo: new LotMethodologyRepository(app.db),
        prefix: "/me",
      });
      // Epic C: anomaly detector scan + flags (admin).
      await api.register(anomalyAdminRoutes, {
        db: app.db,
        accountsRepo,
        authRepo,
        prefix: "/admin/anomaly",
      });
      await api.register(syncCoverageRoutes, {
        service: syncCoverageService,
        prefix: "/sync-coverage",
      });
      await api.register(adminUsageRoutes, {
        repo: apiUsageRepo,
        bucket: tokenBucket,
        env,
        prefix: "/admin/api-usage",
      });
      await api.register(adminInviteRoutes, {
        invites: invitesService,
        prefix: "/admin/invites",
      });
      await api.register(adminUsersRoutes, {
        service: adminUsersService,
        env,
        prefix: "/admin/users",
      });
      await api.register(adminPortfoliosRoutes, {
        service: adminPortfoliosService,
        refreshQueue,
        prefix: "/admin/portfolios",
      });
      await api.register(adminOperationsRoutes, {
        service: adminOperationsService,
        prefix: "/admin/operations",
      });
      await api.register(adminMetricsRoutes, {
        service: adminMetricsService,
        prefix: "/admin/metrics",
      });
      await api.register(adminIntegrationsRoutes, {
        service: adminIntegrationsService,
        audit: app.audit,
        // After admin saves cex_proxy in the UI we re-resolve the
        // proxy so subsequent CEX calls pick up the new agent
        // without a server restart.
        onKeyChanged: {
          cex_proxy: async () => {
            await cexProxyState.refresh();
          },
          telegram_proxy: async () => {
            await telegramProxyState.refresh();
          },
        },
        prefix: "/admin/integrations",
      });
      await api.register(adminAuditRoutes, {
        service: adminAuditService,
        prefix: "/admin/audit",
      });
      await api.register(adminTechAuditRoutes, {
        service: adminTechAuditService,
        prefix: "/admin/tech-audit",
      });
      await api.register(adminQueueRoutes, {
        queue: refreshQueue,
        prefix: "/admin/queue",
      });
      // F3: admin health dashboard endpoint.
      await api.register(adminHealthRoutes, {
        db: app.db,
        redis: app.redis,
        queue: refreshQueue,
        prefix: "/admin",
      });
      await api.register(adminFeatureFlagsRoutes, {
        service: featureFlagsService,
        prefix: "/admin/feature-flags",
      });
      await api.register(publicFeatureFlagsRoutes, {
        service: featureFlagsService,
        prefix: "/me/feature-flags",
      });
      await api.register(telegramRoutes, {
        service: telegramService,
        prefix: "/me/telegram",
      });
      // Webhook receiver for Telegram bot. No auth, validated via
      // X-Telegram-Bot-Api-Secret-Token header (deterministic from
      // bot token).
      await api.register(telegramWebhookRoutes, {
        telegram: telegramService,
        signup: telegramSignupService,
        repository: telegramRepo,
        proxyState: telegramProxyState,
        getBotApiToken: () =>
          process.env["TELEGRAM_BOT_API_TOKEN"]?.trim() ||
          env.TELEGRAM_BOT_API_TOKEN,
        prefix: "/webhooks/telegram",
      });
      // Anonymous Telegram signup/login routes (POST start, GET finish,
      // POST set-password).
      await api.register(telegramSignupRoutes, {
        env,
        signup: telegramSignupService,
        auth: app.auth,
        prefix: "/auth/telegram",
      });
      // Admin-triggered registration of the webhook URL with Telegram.
      await api.register(telegramWebhookAdminRoutes, {
        getBotApiToken: () =>
          process.env["TELEGRAM_BOT_API_TOKEN"]?.trim() ||
          env.TELEGRAM_BOT_API_TOKEN,
        proxyState: telegramProxyState,
        prefix: "/admin/telegram",
      });
      // Admin chat: переписка admin↔user через Telegram bot.
      const adminTelegramChatService = new (
        await import(
          "./modules/admin-telegram-chat/admin-telegram-chat.service.js"
        )
      ).AdminTelegramChatService(telegramRepo, telegramService, app.audit);
      await api.register(
        (await import(
          "./modules/admin-telegram-chat/admin-telegram-chat.routes.js"
        )).adminTelegramChatRoutes,
        {
          service: adminTelegramChatService,
          prefix: "/admin/telegram-chat",
        },
      );
      // Quick-reply шаблоны для admin chat.
      const chatTemplatesRepo = new (
        await import("./modules/chat-templates/chat-templates.repository.js")
      ).ChatTemplatesRepository(app.db);
      await api.register(
        (await import("./modules/chat-templates/chat-templates.routes.js"))
          .chatTemplatesRoutes,
        {
          repo: chatTemplatesRepo,
          prefix: "/admin/telegram-chat/templates",
        },
      );
      await api.register(notificationsRoutes, {
        repo: notificationSubsRepo,
        prefix: "/me/notifications",
      });
      await api.register(billingRoutes, {
        service: billingService,
        prefix: "/me/billing",
      });
      // Phase S1: upstream API proxy — frontend ходит за DeBank/Helius/
      // Alchemy/Etherscan через сервер, ключи (env-only) никогда не
      // светятся в браузере. JWT-auth обязателен через preHandler в
      // самом router'е.
      const upstreamProxy = new UpstreamProxyService({
        DEBANK_API_KEY: env.DEBANK_API_KEY,
        HELIUS_API_KEY: env.HELIUS_API_KEY,
        ETHERSCAN_API_KEY: env.ETHERSCAN_API_KEY,
        ALCHEMY_API_KEY: env.ALCHEMY_API_KEY,
        KRYSTAL_API_KEY: env.KRYSTAL_API_KEY,
      });
      // Per-user rate-limit (S2). H3 (2026-05-14): now env-gated via
      // UPSTREAM_RATE_PER_MIN / UPSTREAM_RATE_PER_HOUR. Defaults
      // {60, 600} match the original "normal user" SaaS profile;
      // override in .env for QA without re-deploying code. Hard
      // sanity check that hour ≥ minute so a misconfig can't lock
      // every user out forever.
      const perMinute = env.UPSTREAM_RATE_PER_MIN;
      const perHour = Math.max(env.UPSTREAM_RATE_PER_HOUR, perMinute);
      const upstreamRateLimit = new UpstreamRateLimitService(
        new RedisRateLimitStore(app.redis),
        { perMinute, perHour }
      );
      app.log.info(
        { perMinute, perHour },
        "[upstream-proxy] rate-limit configured"
      );
      await api.register(upstreamProxyRoutes, {
        service: upstreamProxy,
        apiUsage: apiUsageRepo,
        rateLimit: upstreamRateLimit,
        wallets: walletsRepo,
        prefix: "/upstream",
      });
      await api.register(adminBillingRoutes, {
        service: billingService,
        prefix: "/admin/users",
      });
    },
    { prefix: "/api/v1" }
  );

  // Bull-board UI is mounted at an absolute path because its base-path is
  // baked into the rendered HTML (links/assets). Register at app level so
  // the prefix matches what the browser sees in /api/v1/admin/queue/ui.
  await registerAdminQueueUi(app, {
    queue: refreshQueue,
    basePath: "/api/v1/admin/queue/ui",
  });

  return app;
}
