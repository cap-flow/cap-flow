import { ForbiddenError } from "../../core/errors.js";
import type { JsonCache } from "../redis/cache.js";
import type { TokenBucket } from "../redis/token-bucket.js";
import type { IApiUsageRepository } from "../api-usage/api-usage.repository.js";

import type { IPriceProvider, PriceQuote, ProviderName } from "./types.js";
import { ProviderError } from "./types.js";

export interface QuotaPolicy {
  readonly subjectId: string; // user id, "global" for system fetches
  readonly dailyLimit: number;
}

export interface PriceWrapperConfig {
  readonly cacheTtlSeconds: number;
}

export interface PriceLookupContext {
  readonly userId: string | null;
  readonly accountId: string | null;
  readonly userAgent?: string | null;
  readonly ip?: string | null;
}

/**
 * Decorator that wraps a raw `IPriceProvider` with:
 *   - shared cache (key by symbol; one entry serves every account/user)
 *   - per-user daily quota (Redis token bucket)
 *   - api_usage logging (one row per upstream call OR cache hit)
 *
 * Cache hits don't consume quota tokens or cost USD — they just produce a
 * cheap `api_usage` row marked `cache_hit = 1` so the admin dashboard can
 * show the hit ratio.
 */
export class QuotedPriceProvider {
  constructor(
    private readonly raw: IPriceProvider,
    private readonly cache: JsonCache,
    private readonly bucket: TokenBucket,
    private readonly usage: IApiUsageRepository,
    private readonly cfg: PriceWrapperConfig
  ) {}

  get name(): ProviderName {
    return this.raw.name;
  }

  async getPrice(
    symbol: string,
    coingeckoId: string,
    ctx: PriceLookupContext,
    quota: QuotaPolicy
  ): Promise<PriceQuote> {
    const cacheKey = `price:${this.raw.name}:${symbol.toUpperCase()}`;

    // Cache fast-path.
    const cached = await this.cache.get<PriceQuote>(cacheKey);
    if (cached !== null) {
      await this.logUsage({
        provider: this.raw.name,
        endpoint: "getPrice",
        httpStatus: 200,
        cacheHit: 1,
        durationMs: 0,
        ctx,
      });
      return cached;
    }

    // Cold lookup — gate on quota.
    const check = await this.bucket.consume(
      quota.subjectId,
      this.raw.name,
      quota.dailyLimit
    );
    if (!check.allowed) {
      await this.logUsage({
        provider: this.raw.name,
        endpoint: "getPrice",
        httpStatus: 429,
        cacheHit: 0,
        durationMs: 0,
        error: `quota exceeded (${check.used}/${check.limit})`,
        ctx,
      });
      throw new ForbiddenError(
        `Daily quota exhausted for provider '${this.raw.name}' (${check.used}/${check.limit}). Resets ${check.resetAtUtc.toISOString()}.`
      );
    }

    // Upstream call.
    const t0 = Date.now();
    try {
      const quote = await this.raw.getPrice(symbol, coingeckoId);
      const ms = Date.now() - t0;
      await this.cache.set(cacheKey, quote, this.cfg.cacheTtlSeconds);
      await this.logUsage({
        provider: this.raw.name,
        endpoint: "getPrice",
        httpStatus: 200,
        cacheHit: 0,
        durationMs: ms,
        ctx,
      });
      return quote;
    } catch (err) {
      const ms = Date.now() - t0;
      const httpStatus =
        err instanceof ProviderError ? err.httpStatus ?? 0 : 0;
      const msg = err instanceof Error ? err.message : String(err);
      await this.logUsage({
        provider: this.raw.name,
        endpoint: "getPrice",
        httpStatus,
        cacheHit: 0,
        durationMs: ms,
        error: msg.slice(0, 500),
        ctx,
      });
      throw err;
    }
  }

  private async logUsage(args: {
    provider: ProviderName;
    endpoint: string;
    httpStatus: number;
    cacheHit: 0 | 1;
    durationMs: number;
    error?: string;
    ctx: PriceLookupContext;
  }): Promise<void> {
    try {
      await this.usage.insert({
        userId: args.ctx.userId,
        accountId: args.ctx.accountId,
        provider: args.provider,
        endpoint: args.endpoint,
        httpStatus: args.httpStatus,
        durationMs: args.durationMs,
        cacheHit: args.cacheHit,
        error: args.error ?? null,
      });
    } catch {
      // Don't let logging failures break the real call path.
    }
  }
}
