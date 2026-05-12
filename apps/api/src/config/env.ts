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
  TELEGRAM_BOT_USERNAME: z.string().optional(),
  TELEGRAM_LINK_TTL_MIN: z.coerce.number().int().positive().default(15),

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

  // Per-user upstream quotas (beta values — generous, mainly for logging).
  QUOTA_COINGECKO_PER_DAY: z.coerce.number().int().positive().default(2000),
  QUOTA_DEBANK_PER_DAY: z.coerce.number().int().positive().default(2000),
  QUOTA_ALCHEMY_PER_DAY: z.coerce.number().int().positive().default(5000),
  QUOTA_ETHERSCAN_PER_DAY: z.coerce.number().int().positive().default(5000),

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
