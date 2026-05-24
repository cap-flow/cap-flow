import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
  API_HOST: z.string().default("0.0.0.0"),
  API_PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  DATABASE_URL: z.string().url(),
  CORS_ORIGIN: z.string().default("*"),

  // Auth
  JWT_SECRET: z
    .string()
    .min(32, "JWT_SECRET must be at least 32 characters (use a long random string)"),
  JWT_ACCESS_TTL_MIN: z.coerce.number().int().positive().default(15),
  JWT_REFRESH_TTL_DAYS: z.coerce.number().int().positive().default(30),
  COOKIE_SECRET: z
    .string()
    .min(32, "COOKIE_SECRET must be at least 32 characters"),
  COOKIE_DOMAIN: z.string().optional(),
  COOKIE_SECURE: z
    .string()
    .default("true")
    .transform((v) => v === "true" || v === "1"),

  // Invites
  INVITE_TTL_HOURS: z.coerce.number().int().positive().default(72),
  /** Base URL the frontend hosts the invite landing page on. The raw token
   *  is appended as `${INVITE_BASE_URL}/${token}`. */
  INVITE_BASE_URL: z.string().url().default("http://localhost:5173/invite"),

  // Password reset
  PASSWORD_RESET_TTL_MIN: z.coerce.number().int().positive().default(60),
  PASSWORD_RESET_BASE_URL: z
    .string()
    .url()
    .default("http://localhost:5173/reset-password"),

  // B4: email verification
  EMAIL_VERIFY_TTL_HOURS: z.coerce.number().int().positive().default(24),
  EMAIL_VERIFY_BASE_URL: z
    .string()
    .url()
    .default("http://localhost:5173/verify-email"),

  // Rate limiting
  RATE_LIMIT_LOGIN_PER_15MIN: z.coerce.number().int().positive().default(5),

  // Admin impersonation
  IMPERSONATION_TTL_MIN: z.coerce.number().int().positive().default(60),

  // Redis
  REDIS_URL: z.string().default("redis://localhost:6379"),

  // Notifications — email (Resend) + Telegram.
  // All optional: if RESEND_API_KEY is empty, email "delivery" prints to
  // stdout (dev stub). If TELEGRAM_BOT_USERNAME is empty, the start-link
  // becomes opaque text — useful while we still decide on the bot host.
  RESEND_API_KEY: z.string().optional(),
  RESEND_FROM_EMAIL: z.string().email().default("noreply@cap-flow.ru"),
  RESEND_FROM_NAME: z.string().default("Capflow"),
  // Public Capflow bot username. Default = "defiCapflow_bot" (the official
  // Capflow bot on Telegram). Admin override possible via /admin/integrations.
  TELEGRAM_BOT_USERNAME: z.string().optional().default("defiCapflow_bot"),
  // Bot API token. Secret — no default. Set via env or via the
  // /admin/integrations UI (stored AES-encrypted in integration_secrets).
  // Without it TelegramService.send() is a no-op.
  TELEGRAM_BOT_API_TOKEN: z.string().optional(),
  TELEGRAM_LINK_TTL_MIN: z.coerce.number().int().positive().default(15),

  /**
   * Optional HTTP(S)/SOCKS proxy for outgoing Telegram Bot API requests.
   * Set when the API server runs in a region where api.telegram.org is
   * geo-blocked (RU/CIS) or when corporate egress requires routing.
   *
   * Same format/schemes as `CEX_HTTPS_PROXY`:
   *   http://user:pass@host:port
   *   http://host:port
   *   socks5://host:port
   *
   * Admin can override at runtime via /admin/integrations → telegram_proxy.
   */
  TELEGRAM_BOT_HTTPS_PROXY: z.string().optional(),

  /**
   * Public origin сайта (без trailing slash). Используется для
   * генерации absolute-ссылок в Telegram bot чате (finish-URL для
   * signup-flow). В prod = `https://cap-flow.ru`, в dev = `http://localhost:5173`.
   */
  SITE_ORIGIN: z.string().default("https://cap-flow.ru"),

  /**
   * Use long-polling (getUpdates) instead of webhook. Required when the
   * server is hosted behind an asymmetrically blocked network — RU/RKN
   * TSPU drops incoming TCP from Telegram DC ranges (149.154.x.x) to
   * Russian IPs, even though outgoing to api.telegram.org via the
   * configured proxy works fine. Polling reverses the connection
   * direction and is unaffected.
   *
   * Defaults to `false` so behaviour stays the same for existing
   * deployments. Set `TELEGRAM_BOT_USE_POLLING=true` in `.env` on the
   * RU prod to switch. Admin should ALSO press «Удалить webhook» once
   * after toggling, otherwise Telegram returns 409 to getUpdates.
   */
  TELEGRAM_BOT_USE_POLLING: z
    .union([
      z.literal("true"),
      z.literal("false"),
      z.literal("1"),
      z.literal("0"),
      z.literal(""),
    ])
    .optional()
    .transform((v) => v === "true" || v === "1"),

  // Billing (Phase 8). On beta we run the pre-generated address pool —
  // comma-separated env vars below. HD wallet rotation comes later.
  BILLING_PRICE_3M_USD: z.coerce.number().positive().default(100),
  BILLING_PRICE_6M_USD: z.coerce.number().positive().default(180),
  BILLING_PRICE_12M_USD: z.coerce.number().positive().default(300),
  BILLING_GRACE_DAYS: z.coerce.number().int().min(0).default(3),
  BILLING_MIN_CONFIRMATIONS_TRC20: z.coerce.number().int().min(0).default(20),
  BILLING_MIN_CONFIRMATIONS_ERC20: z.coerce.number().int().min(0).default(12),
  BILLING_ADDRESS_POOL_TRC20: z.string().optional(),
  BILLING_ADDRESS_POOL_ERC20: z.string().optional(),
  TRONSCAN_API_KEY: z.string().optional(),

  // Upstream provider API keys (kept ONLY on server; never sent to client).
  ALCHEMY_API_KEY: z.string().optional(),
  DEBANK_API_KEY: z.string().optional(),
  ETHERSCAN_API_KEY: z.string().optional(),
  COINGECKO_API_KEY: z.string().optional(), // optional — free tier works without
  HELIUS_API_KEY: z.string().optional(),    // Solana wallet balances
  COINSTATS_API_KEY: z.string().optional(), // multi-chain unified API (Phase 3d)
  KRYSTAL_API_KEY: z.string().optional(),   // Krystal Cloud V3 LP positions (cross-validation)

  /**
   * Optional HTTPS proxy for ALL outgoing CEX-exchange traffic. Set
   * this when the API server runs in a region the exchange's CDN
   * geoblocks (Bybit / OKX / BingX from RU/CIS).
   *
   * Format:
   *   http://user:pass@host:port
   *   http://host:port
   *   socks5://host:port            (use a SOCKS proxy — supported via
   *                                  socks-proxy-agent fallback)
   *
   * The proxy is applied to BOTH the CCXT HTTPS client (balance /
   * trades / deposits / withdrawals across every connected exchange)
   * AND the native-fetch Bitget P2P client.
   *
   * Also honors `HTTPS_PROXY` / `https_proxy` env vars as a fallback,
   * matching common ops conventions.
   */
  CEX_HTTPS_PROXY: z.string().optional(),

  /**
   * B5 (2026-05-14): encryption key for `integration_secrets.value`.
   * Optional — if absent, the admin-integrations service derives a key
   * from COOKIE_SECRET (already enforced ≥32 chars). Set this explicitly
   * before rotating COOKIE_SECRET, otherwise stored secrets become
   * undecryptable. Must be ≥32 chars when set.
   */
  INTEGRATION_SECRETS_KEY: z
    .string()
    .min(32, "INTEGRATION_SECRETS_KEY must be ≥32 chars")
    .optional(),

  // Per-user upstream quotas (beta values — generous, mainly for logging).
  QUOTA_COINGECKO_PER_DAY: z.coerce.number().int().positive().default(2000),
  QUOTA_DEBANK_PER_DAY: z.coerce.number().int().positive().default(2000),
  QUOTA_ALCHEMY_PER_DAY: z.coerce.number().int().positive().default(5000),
  QUOTA_ETHERSCAN_PER_DAY: z.coerce.number().int().positive().default(5000),

  /**
   * H3 (2026-05-14): per-user upstream-proxy rate-limit. Was hard-coded
   * to {60, 600} before beta testing required them lifted to {6000,
   * 60000}, but the lifted values never got rolled back via env. Now
   * env-gated with safe defaults for public launch.
   *
   * Tuning guide:
   *   - 60/min × 600/hour = normal SaaS dashboard session
   *   - 600/min × 6000/hour = power user with multi-account drill-down
   *   - 6000/min × 60000/hour = effectively-off (use only for local QA)
   * The hour cap should always be ≥ 10× the minute cap so a legit
   * burst doesn't permanently lock the user out.
   */
  UPSTREAM_RATE_PER_MIN: z.coerce.number().int().positive().default(60),
  UPSTREAM_RATE_PER_HOUR: z.coerce.number().int().positive().default(600),

  /**
   * M8 (2026-05-14): pg connection pool size. Was hard-coded to 10 in
   * `createDbClient`. Under load (50 concurrent requests, multi-statement
   * txs) the pool saturates and additional requests wait. Default
   * bumped to 20 for API (per-process). Worker still uses 10 since
   * its concurrency is bounded by BullMQ already.
   *
   * Total Postgres connections = (API replicas × DB_POOL_MAX) +
   * (worker replicas × DB_POOL_MAX_WORKER) — keep under
   * `postgresql.max_connections` (default 100).
   */
  DB_POOL_MAX: z.coerce.number().int().positive().default(20),
  DB_POOL_MAX_WORKER: z.coerce.number().int().positive().default(10),
  DB_POOL_IDLE_MS: z.coerce.number().int().positive().default(30_000),

  // Cache TTLs (seconds).
  CACHE_PRICE_TTL_SEC: z.coerce.number().int().positive().default(300),
  CACHE_BALANCE_TTL_SEC: z.coerce.number().int().positive().default(60),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

export function loadEnv(): Env {
  if (cached) return cached;

  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  cached = parsed.data;
  return cached;
}
