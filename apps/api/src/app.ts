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
import { adminMetricsRoutes } from "./modules/admin-metrics/admin-metrics.routes.js";
import { AdminMetricsService } from "./modules/admin-metrics/admin-metrics.service.js";
import { adminPortfoliosRoutes } from "./modules/admin-portfolios/admin-portfolios.routes.js";
import { AdminPortfoliosService } from "./modules/admin-portfolios/admin-portfolios.service.js";
import { adminQueueRoutes } from "./modules/admin-queue/admin-queue.routes.js";
import { registerAdminQueueUi } from "./modules/admin-queue/admin-queue.ui.js";
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
import { passwordResetRoutes } from "./modules/auth/password-reset.routes.js";
import { PasswordResetRepository } from "./modules/auth/password-reset.repository.js";
import { PasswordResetService } from "./modules/auth/password-reset.service.js";
import { adminInviteRoutes } from "./modules/invites/invites.routes.admin.js";
import { publicInviteRoutes } from "./modules/invites/invites.routes.public.js";
import { InvitesRepository } from "./modules/invites/invites.repository.js";
import { InvitesService } from "./modules/invites/invites.service.js";
import { authPlugin } from "./plugins/auth.js";
import { dbPlugin } from "./plugins/db.js";
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
  await app.register(dbPlugin, { connectionString: env.DATABASE_URL });
  await app.register(redisPlugin, { url: env.REDIS_URL });
  await app.register(authPlugin, {
    jwtSecret: env.JWT_SECRET,
    accessTtlMinutes: env.JWT_ACCESS_TTL_MIN,
    refreshTtlDays: env.JWT_REFRESH_TTL_DAYS,
  });

  // ─── module instantiation ───────────────────────────────────────────
  const invitesRepo = new InvitesRepository(app.db);
  const accountsRepo = new AccountsRepository(app.db);
  const accountsService = new AccountsService(accountsRepo, app.audit, {
    userAccountLimit: 1,
  });
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
    botUsername: env.TELEGRAM_BOT_USERNAME,
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
    }
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
  const adminMetricsService = new AdminMetricsService(app.db);
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
  const bullConn = createBullConnection(env.REDIS_URL);
  const portfolioRepo = new PortfolioRepository(app.db);
  const refreshQueue = new PortfolioRefreshQueue(bullConn);
  app.addHook("onClose", async () => {
    await refreshQueue.close();
    bullConn.disconnect();
  });

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
  app.get("/health", async () => ({ status: "ok", uptime: process.uptime() }));

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
        prefix: "/admin/portfolios",
      });
      await api.register(adminMetricsRoutes, {
        service: adminMetricsService,
        prefix: "/admin/metrics",
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
      });
      // Per-user rate-limit (S2): 60 req/min + 600 req/hour. Tuned so a
      // normal dashboard session (refresh + drill-downs) stays well
      // under cap, but a runaway script can't drain DeBank Pro quota.
      const upstreamRateLimit = new UpstreamRateLimitService(
        new RedisRateLimitStore(app.redis),
        { perMinute: 60, perHour: 600 }
      );
      await api.register(upstreamProxyRoutes, {
        service: upstreamProxy,
        apiUsage: apiUsageRepo,
        rateLimit: upstreamRateLimit,
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
