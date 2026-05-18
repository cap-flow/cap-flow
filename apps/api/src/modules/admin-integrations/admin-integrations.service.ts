import { type Database, schema } from "@cap-flow/db";
import { eq, gte, sql } from "drizzle-orm";

import type { Env } from "../../config/env.js";
import { NotFoundError } from "../../core/errors.js";
import {
  decryptSecret,
  deriveKey,
  encryptSecret,
  isEncrypted,
} from "./secret-cipher.js";

export interface IntegrationStatus {
  readonly key: string;
  readonly name: string;
  readonly purpose: string;
  readonly envVar: string;
  /** True when *some* secret is available (DB override or env). */
  readonly configured: boolean;
  /** True when the active value comes from a DB override (PATCH-ed by admin). */
  readonly hasDbOverride: boolean;
  /** Last 4 chars of the active value, prefixed with bullets. Never the full key. */
  readonly valuePreview: string | null;
  /** ISO datetime of last edit via PATCH (if any). */
  readonly editedAt: string | null;
  readonly perUserQuotaPerDay: number | null;
  readonly usageProvider: string | null;
  readonly calls24h: number;
  readonly errors24h: number;
  readonly cacheHits24h: number;
  readonly totalCostUsd24h: number;
  readonly lastCallAt: string | null;
  readonly lastError: string | null;
}

/**
 * Admin-editable upstream integration registry.
 *
 *   GET  /admin/integrations            — list with status + 24h usage.
 *   PATCH /admin/integrations/:key      — upsert DB override.
 *   DELETE /admin/integrations/:key     — clear DB override (revert to env).
 *
 * **Resolution order** when computing the active value for a key:
 *   1. DB row (`integration_secrets.value`) — non-empty wins.
 *   2. `env.<envVar>` — fallback.
 *
 * `process.env[<envVar>]` is mutated on PATCH so any lazy `process.env`
 * reader (e.g. fresh `DeBankClient` instance) immediately sees the new
 * value. Long-lived singletons constructed at app startup keep their
 * cached key — admin UI surfaces a "restart required" hint accordingly.
 */
export class AdminIntegrationsService {
  private readonly cipherKey: Buffer;

  constructor(
    private readonly db: Database,
    private readonly env: Env
  ) {
    // B5: derive a 32-byte AES key once at construction. Prefer the
    // dedicated env (INTEGRATION_SECRETS_KEY) when set; otherwise fall
    // back to a deterministic derivation from COOKIE_SECRET so existing
    // deployments transition automatically (the cookie secret is already
    // required ≥32 chars at env-validation time).
    const seed =
      (env.INTEGRATION_SECRETS_KEY && env.INTEGRATION_SECRETS_KEY.length >= 32
        ? env.INTEGRATION_SECRETS_KEY
        : env.COOKIE_SECRET) ?? "";
    this.cipherKey = deriveKey(seed);
  }

  /**
   * Decrypt a stored value if needed. Stored values may be:
   *   - encrypted: "enc:v1:<iv>:<tag>:<ct>" — decrypt
   *   - legacy plaintext (pre-B5 rows): returned as-is, scheduled for
   *     re-encryption on the next admin write
   *
   * On decryption failure (wrong key / tampered) returns `null` and the
   * caller treats the secret as absent — better than crashing the
   * admin page or, worse, returning the ciphertext as a "key".
   */
  private decryptIfNeeded(stored: string | null): string | null {
    if (stored == null || stored === "") return null;
    if (!isEncrypted(stored)) return stored;
    try {
      return decryptSecret(stored, this.cipherKey);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(
        "[admin-integrations] secret decrypt failed (key rotated? row tampered?):",
        (e as Error).message
      );
      return null;
    }
  }

  /** Static catalog of all integrations the codebase wires up. */
  private catalog(): Array<
    Pick<
      IntegrationStatus,
      "key" | "name" | "purpose" | "envVar" | "perUserQuotaPerDay" | "usageProvider"
    > & { envValue: string | undefined; isPublic: boolean }
  > {
    const e = this.env;
    return [
      {
        key: "debank",
        name: "DeBank Cloud Pro",
        purpose: "EVM portfolio data: tokens, complex DeFi protocols, history.",
        envVar: "DEBANK_API_KEY",
        envValue: e.DEBANK_API_KEY,
        isPublic: false,
        perUserQuotaPerDay: e.QUOTA_DEBANK_PER_DAY,
        usageProvider: "debank",
      },
      {
        key: "helius",
        name: "Helius",
        purpose: "Solana wallet balances + parsed history (DAS API).",
        envVar: "HELIUS_API_KEY",
        envValue: e.HELIUS_API_KEY,
        isPublic: false,
        perUserQuotaPerDay: null,
        usageProvider: "helius",
      },
      {
        key: "alchemy",
        name: "Alchemy",
        purpose: "EVM RPC: V3 NFT positions, contract reads, on-chain price lookups.",
        envVar: "ALCHEMY_API_KEY",
        envValue: e.ALCHEMY_API_KEY,
        isPublic: false,
        perUserQuotaPerDay: e.QUOTA_ALCHEMY_PER_DAY,
        usageProvider: "alchemy",
      },
      {
        key: "etherscan",
        name: "Etherscan v2",
        purpose: "EVM logs / IncreaseLiquidity events for V3 cost basis (chainId param).",
        envVar: "ETHERSCAN_API_KEY",
        envValue: e.ETHERSCAN_API_KEY,
        isPublic: false,
        perUserQuotaPerDay: e.QUOTA_ETHERSCAN_PER_DAY,
        usageProvider: "etherscan",
      },
      {
        key: "coingecko",
        name: "CoinGecko",
        purpose: "Historical USD prices for V3 mint timestamps.",
        envVar: "COINGECKO_API_KEY",
        envValue: e.COINGECKO_API_KEY,
        isPublic: false,
        perUserQuotaPerDay: e.QUOTA_COINGECKO_PER_DAY,
        usageProvider: "coingecko",
      },
      {
        key: "coinstats",
        name: "CoinStats",
        purpose: "Multi-chain unified API (TON, Bitcoin, Aptos, Sui, Cosmos, новые EVM L2).",
        envVar: "COINSTATS_API_KEY",
        envValue: e.COINSTATS_API_KEY,
        isPublic: false,
        perUserQuotaPerDay: null,
        usageProvider: "coinstats",
      },
      {
        key: "defillama_prices",
        name: "DefiLlama Coins",
        purpose: "Historical token prices (free, no auth). Fallback when CoinGecko miss/quota.",
        envVar: "(no key — public endpoint)",
        envValue: "public",
        isPublic: true,
        perUserQuotaPerDay: null,
        usageProvider: "defillama",
      },
      {
        key: "defillama_protocols",
        name: "DefiLlama Protocols",
        purpose: "~5000 DeFi protocols catalog. Auto-classifies unknown protocols (Phase 2026-05).",
        envVar: "(no key — public endpoint)",
        envValue: "public",
        isPublic: true,
        perUserQuotaPerDay: null,
        usageProvider: "defillama_protocols",
      },
      {
        key: "tronscan",
        name: "Tronscan",
        purpose: "TRC20 USDT payment monitor (billing).",
        envVar: "TRONSCAN_API_KEY",
        envValue: e.TRONSCAN_API_KEY,
        isPublic: false,
        perUserQuotaPerDay: null,
        usageProvider: "tronscan",
      },
      {
        key: "resend",
        name: "Resend",
        purpose: "Transactional email (invites, password reset).",
        envVar: "RESEND_API_KEY",
        envValue: e.RESEND_API_KEY,
        isPublic: false,
        perUserQuotaPerDay: null,
        usageProvider: null,
      },
      {
        key: "telegram",
        name: "Telegram Bot",
        purpose: "Telegram notifications link/start.",
        envVar: "TELEGRAM_BOT_USERNAME",
        envValue: e.TELEGRAM_BOT_USERNAME,
        isPublic: false,
        perUserQuotaPerDay: null,
        usageProvider: null,
      },
      {
        // Special: this isn't an API key — it's the URL of an HTTPS
        // proxy through which Capflow routes outgoing CEX-exchange
        // traffic. Set when the API server runs in a region the
        // exchange's CDN geoblocks (Bybit / OKX / BingX from RU/CIS).
        // Format: http(s)://[user:pass@]host:port  or  socks5://host:port.
        key: "cex_proxy",
        name: "CEX HTTPS Proxy",
        purpose:
          "HTTP(S) или SOCKS прокси для исходящих запросов к CEX-биржам (Bybit / OKX / BingX геоблокируют RU/CIS IPs).",
        envVar: "CEX_HTTPS_PROXY",
        envValue: e.CEX_HTTPS_PROXY,
        isPublic: false,
        perUserQuotaPerDay: null,
        usageProvider: null,
      },
    ];
  }

  /**
   * Resolve a single integration's active value (DB override → env
   * fallback). Used by other services that need to read an
   * admin-managed setting at runtime — currently the CEX proxy.
   *
   * Returns the unmasked plaintext (admin-managed secrets are
   * service-internal; the value never leaves the API server).
   */
  async getSecret(key: string): Promise<string | null> {
    try {
      const rows = await this.db
        .select()
        .from(schema.integrationSecrets)
        .where(eq(schema.integrationSecrets.key, key))
        .limit(1);
      const dbValue = rows[0]?.value
        ? this.decryptIfNeeded(rows[0].value)?.trim() || null
        : null;
      if (dbValue) return dbValue;
    } catch {
      // Migration not applied yet — fall through to env.
    }
    const fromCatalog = this.catalog().find((c) => c.key === key);
    return fromCatalog?.envValue?.trim() || null;
  }

  async listAll(): Promise<IntegrationStatus[]> {
    const sub24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

    // Pull DB overrides. Resilient to "table not yet migrated": if the
    // migration 0006 hasn't run, query throws — we log and proceed with
    // an empty override map so the static catalog still renders.
    const overrides = new Map<
      string,
      { value: string | null; updatedAt: Date }
    >();
    try {
      const dbRows = await this.db.select().from(schema.integrationSecrets);
      for (const r of dbRows) {
        // B5: decrypt at-rest cipher → plaintext. Legacy unencrypted rows
        // pass through `decryptIfNeeded` unchanged so the migration is
        // zero-downtime; they get re-encrypted on the next setSecret.
        overrides.set(r.key, {
          value: this.decryptIfNeeded(r.value ?? null),
          updatedAt: r.updatedAt,
        });
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(
        "[admin-integrations] integration_secrets table missing — " +
          "run `pnpm --filter @cap-flow/db migrate`. Falling back to env-only.",
        (e as Error).message
      );
    }

    // 24h api_usage aggregates — also try/catch in case the column shape
    // ever drifts (cheap defensive coding for an admin page).
    const byProvider = new Map<
      string,
      {
        calls: number;
        errors: number;
        cacheHits: number;
        totalCostUsd: string;
        lastAt: Date | null;
        lastError: string | null;
      }
    >();
    try {
      const aggRows = await this.db
        .select({
          provider: schema.apiUsage.provider,
          calls: sql<number>`COUNT(*)::int`,
          errors: sql<number>`COUNT(*) FILTER (WHERE ${schema.apiUsage.error} IS NOT NULL)::int`,
          cacheHits: sql<number>`COUNT(*) FILTER (WHERE ${schema.apiUsage.cacheHit} = 1)::int`,
          totalCostUsd: sql<string>`COALESCE(SUM(${schema.apiUsage.costEstimateUsd}), 0)::text`,
          lastAt: sql<Date | null>`MAX(${schema.apiUsage.createdAt})`,
          lastError: sql<string | null>`(
            SELECT error FROM ${schema.apiUsage} a2
            WHERE a2.provider = ${schema.apiUsage.provider}
              AND a2.error IS NOT NULL
              AND a2.created_at >= ${sub24h.toISOString()}
            ORDER BY a2.created_at DESC LIMIT 1
          )`,
        })
        .from(schema.apiUsage)
        .where(gte(schema.apiUsage.createdAt, sub24h))
        .groupBy(schema.apiUsage.provider);
      for (const r of aggRows) byProvider.set(r.provider, r);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(
        "[admin-integrations] api_usage aggregate query failed:",
        (e as Error).message
      );
    }

    return this.catalog().map((c) => {
      const dbOverride = overrides.get(c.key);
      const dbValue = dbOverride?.value?.trim() || null;
      const active = dbValue ?? (c.envValue?.trim() || null);
      const configured = c.isPublic || !!active;
      const agg = c.usageProvider ? byProvider.get(c.usageProvider) : null;
      return {
        key: c.key,
        name: c.name,
        purpose: c.purpose,
        envVar: c.envVar,
        configured,
        hasDbOverride: !!dbValue,
        valuePreview: active ? maskSecret(active) : null,
        editedAt: dbOverride?.updatedAt
          ? new Date(dbOverride.updatedAt).toISOString()
          : null,
        perUserQuotaPerDay: c.perUserQuotaPerDay,
        usageProvider: c.usageProvider,
        calls24h: agg ? Number(agg.calls) : 0,
        errors24h: agg ? Number(agg.errors) : 0,
        cacheHits24h: agg ? Number(agg.cacheHits) : 0,
        totalCostUsd24h: agg ? Number(agg.totalCostUsd) : 0,
        lastCallAt: agg?.lastAt ? new Date(agg.lastAt).toISOString() : null,
        lastError: agg?.lastError ?? null,
      };
    });
  }

  async setSecret(
    key: string,
    value: string,
    actorUserId: string
  ): Promise<void> {
    const entry = this.catalog().find((c) => c.key === key);
    if (!entry) throw new NotFoundError(`Unknown integration '${key}'.`);
    if (entry.isPublic) {
      throw new NotFoundError(
        `Integration '${key}' is a public endpoint, no key to set.`
      );
    }
    const trimmed = value.trim();
    // B5: encrypt before persist. Empty/cleared values stay NULL — there's
    // nothing to encrypt, and storing `enc:v1:` of "" would just leak that
    // the row was once set.
    const stored = trimmed ? encryptSecret(trimmed, this.cipherKey) : null;
    try {
      await this.db
        .insert(schema.integrationSecrets)
        .values({
          key,
          envVarName: entry.envVar,
          value: stored,
          updatedBy: actorUserId,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: schema.integrationSecrets.key,
          set: {
            value: stored,
            updatedBy: actorUserId,
            updatedAt: new Date(),
          },
        });
    } catch (e) {
      // 42P01 = relation does not exist. Surface clear error to admin
      // instead of generic "Internal Server Error".
      const msg = (e as Error).message;
      if (
        msg.includes('"integration_secrets"') ||
        msg.includes("does not exist") ||
        msg.includes("42P01")
      ) {
        throw new Error(
          "Table `integration_secrets` not yet migrated. Run " +
            "`pnpm --filter @cap-flow/db migrate` and restart API."
        );
      }
      throw e;
    }
    // Hot-apply: subsequent `process.env[<NAME>]` reads see the new value.
    // Empty string clears (some clients treat undefined+"" the same; we set
    // to empty so explicit clearing wins over re-reading from .env file
    // earlier in the boot process).
    if (entry.envVar && !entry.envVar.startsWith("(")) {
      process.env[entry.envVar] = trimmed;
    }
  }

  async clearSecret(key: string, actorUserId: string): Promise<void> {
    await this.setSecret(key, "", actorUserId);
  }
}

/**
 * Mask all but the last 4 chars: `●●●●●●●●xxxx`. Inputs <8 chars are
 * fully masked (no preview) — too short to leave any tail safely.
 */
function maskSecret(s: string): string {
  if (s.length <= 8) return "●".repeat(s.length);
  const tail = s.slice(-4);
  return "●".repeat(Math.min(8, s.length - 4)) + tail;
}
