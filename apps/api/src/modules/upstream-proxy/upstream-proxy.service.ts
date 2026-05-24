/**
 * Upstream-proxy service (S1).
 *
 * Forwards calls from the SaaS frontend to third-party data providers
 * (DeBank, Helius, Etherscan, Alchemy, …) using admin-side API keys
 * stored server-side. The frontend never sees these keys — that's the
 * whole point of this module.
 *
 * Security posture:
 *   - Provider registry is closed: callers reference providers by
 *     well-known string id, anything else throws `unknown_provider`.
 *   - Path allow-list per provider blocks SSRF / scraping of admin
 *     endpoints. Misses throw `forbidden_path`.
 *   - Caller-supplied query params can never override the auth param
 *     (we set it last with `searchParams.set`, which replaces any
 *     existing entry).
 *   - The Authorization header from the inbound request is *not*
 *     forwarded — upstream sees only the provider-specific auth header
 *     or query param.
 *   - API keys never appear in `UpstreamProxyError.message` even when
 *     upstream `fetch` throws a stringified URL.
 *
 * Rate-limiting and per-user audit live in `upstream-proxy.routes.ts`
 * (S2) so this service stays a pure function from `(env, request)` to
 * `(upstream response | error)`.
 */

export interface ProxyEnv {
  readonly DEBANK_API_KEY?: string | undefined;
  readonly HELIUS_API_KEY?: string | undefined;
  readonly ETHERSCAN_API_KEY?: string | undefined;
  readonly ALCHEMY_API_KEY?: string | undefined;
  readonly KRYSTAL_API_KEY?: string | undefined;
}

export interface ProxyRequest {
  readonly provider: string;
  readonly method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  /** Upstream path WITHOUT the provider base (e.g. "v1/user/total_balance"). */
  readonly path: string;
  readonly query?: Record<string, string | string[] | undefined>;
  readonly body?: unknown;
  readonly signal?: AbortSignal;
}

export interface ProxyResponse {
  readonly status: number;
  readonly body: string;
  readonly contentType: string | null;
  /**
   * How many extra attempts we did beyond the first. 0 = success/fail on
   * first try. Reported in api_usage so admin can spot upstream flakiness.
   */
  readonly retries?: number;
}

type ProxyErrorKind =
  | "unknown_provider"
  | "missing_api_key"
  | "forbidden_path"
  | "network"
  | "internal";

export class UpstreamProxyError extends Error {
  readonly name = "UpstreamProxyError";
  constructor(
    message: string,
    readonly kind: ProxyErrorKind,
    readonly provider: string
  ) {
    super(message);
  }
}

/**
 * L2 (2026-05-14): sanitize user-supplied path before including it in
 * error messages / logs. The raw `req.path` was echoed verbatim, which
 * is a minor log-injection / reflected-output vector. Keep only chars
 * that legitimately appear in URL paths (alphanumeric, slash, dot,
 * hyphen, underscore) and truncate to a sane preview length.
 *
 * Real path validation (the allow-list regex) stays in the per-provider
 * `buildUrl` — this helper only protects what we say BACK to callers.
 */
function safePathPreview(p: string): string {
  return p.slice(0, 80).replace(/[^a-zA-Z0-9/_.\-]/g, "?");
}

/* ------------------------- provider configs ------------------------------- */

type AuthStrategy =
  | { kind: "header"; name: string }
  | { kind: "query"; param: string }
  | { kind: "alchemy" };

interface ProviderHandler {
  /** Validate `req.path` and build the upstream URL (without auth). */
  buildUrl(req: ProxyRequest): URL;
  readonly auth: AuthStrategy;
  /** Env var name where the admin key lives. */
  readonly envVar: keyof ProxyEnv | null;
}

const ALCHEMY_CHAINS = new Set([
  "eth-mainnet",
  "arb-mainnet",
  "opt-mainnet",
  "base-mainnet",
  "polygon-mainnet",
  "bnb-mainnet",
  "avax-mainnet",
]);

const PROVIDERS: Record<string, ProviderHandler> = {
  debank: {
    auth: { kind: "header", name: "AccessKey" },
    envVar: "DEBANK_API_KEY",
    buildUrl: (req) => {
      // Allow-list of DeBank Pro endpoints we actually use.
      if (
        !/^v1\/(user|token|cache|protocol|chain|cex|asset|tx|nft)\b/.test(
          req.path
        )
      ) {
        throw new UpstreamProxyError(
          `Path not allowed for DeBank: ${safePathPreview(req.path)}`,
          "forbidden_path",
          "debank"
        );
      }
      return new URL(`https://pro-openapi.debank.com/${req.path}`);
    },
  },
  helius: {
    auth: { kind: "query", param: "api-key" },
    envVar: "HELIUS_API_KEY",
    buildUrl: (req) => {
      if (!/^v0\/(addresses|transactions|nfts)\b|^v1\/.+/.test(req.path)) {
        throw new UpstreamProxyError(
          `Path not allowed for Helius: ${safePathPreview(req.path)}`,
          "forbidden_path",
          "helius"
        );
      }
      return new URL(`https://api.helius.xyz/${req.path}`);
    },
  },
  etherscan: {
    auth: { kind: "query", param: "apikey" },
    envVar: "ETHERSCAN_API_KEY",
    buildUrl: (req) => {
      if (!/^v2\/api\b|^api\b/.test(req.path)) {
        throw new UpstreamProxyError(
          `Path not allowed for Etherscan: ${safePathPreview(req.path)}`,
          "forbidden_path",
          "etherscan"
        );
      }
      return new URL(`https://api.etherscan.io/${req.path}`);
    },
  },
  alchemy: {
    auth: { kind: "alchemy" },
    envVar: "ALCHEMY_API_KEY",
    buildUrl: (req) => {
      // Alchemy convention: `req.path` is the chain subdomain
      // (e.g. "eth-mainnet"). The `/v2/{KEY}` segment is appended by
      // the auth injector below.
      const chain = req.path.trim();
      if (!ALCHEMY_CHAINS.has(chain)) {
        throw new UpstreamProxyError(
          `Unknown Alchemy chain: ${safePathPreview(chain)}`,
          "forbidden_path",
          "alchemy"
        );
      }
      // Placeholder URL — key gets spliced in `forward`.
      return new URL(`https://${chain}.g.alchemy.com/`);
    },
  },
  // Krystal Cloud — V3 LP positions / pools / balances aggregator.
  // Используется в `lib/krystal/*` для cross-validation OpenPosition
  // против gold-standard Uniswap UI values (real-time feeGrowth math,
  // Collect events без principal contamination).
  krystal: {
    auth: { kind: "header", name: "KC-APIKey" },
    envVar: "KRYSTAL_API_KEY",
    buildUrl: (req) => {
      // Allow-list эндпоинтов которые мы реально дёргаем. Не пропускаем
      // strategy-write endpoints (хотя их у Krystal нет в read API, но
      // на всякий случай ограничиваем READ-only пути).
      if (
        !/^v1\/(positions|pools|balances|chains|protocols|strategies)\b/.test(
          req.path
        )
      ) {
        throw new UpstreamProxyError(
          `Path not allowed for Krystal: ${safePathPreview(req.path)}`,
          "forbidden_path",
          "krystal"
        );
      }
      return new URL(`https://cloud-api.krystal.app/${req.path}`);
    },
  },
};

/* ------------------------- service ---------------------------------------- */

export interface RetryConfig {
  readonly maxRetries: number;
  readonly baseBackoffMs: number;
  readonly maxBackoffMs: number;
  readonly maxRetryAfterSec: number;
}

const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  baseBackoffMs: 250,
  maxBackoffMs: 4_000,
  maxRetryAfterSec: 30,
};

/** Disable retries — for tests, or when the caller wants raw upstream errors. */
export const NO_RETRY: RetryConfig = {
  maxRetries: 0,
  baseBackoffMs: 0,
  maxBackoffMs: 0,
  maxRetryAfterSec: 0,
};

export class UpstreamProxyService {
  private readonly retry: RetryConfig;

  constructor(
    private readonly env: ProxyEnv,
    retry: Partial<RetryConfig> = {}
  ) {
    this.retry = { ...DEFAULT_RETRY_CONFIG, ...retry };
  }

  async forward(req: ProxyRequest): Promise<ProxyResponse> {
    const handler = PROVIDERS[req.provider];
    if (!handler) {
      throw new UpstreamProxyError(
        `Unknown provider: ${req.provider}`,
        "unknown_provider",
        req.provider
      );
    }

    const apiKey = handler.envVar ? this.env[handler.envVar] : undefined;
    if (handler.envVar && !apiKey) {
      throw new UpstreamProxyError(
        `Server has no API key for ${req.provider}`,
        "missing_api_key",
        req.provider
      );
    }

    const url = handler.buildUrl(req);

    // 1. Caller-supplied query params (before auth so we can override).
    if (req.query) {
      for (const [k, v] of Object.entries(req.query)) {
        if (v === undefined) continue;
        if (Array.isArray(v)) {
          url.searchParams.delete(k);
          for (const item of v) url.searchParams.append(k, item);
        } else {
          url.searchParams.set(k, v);
        }
      }
    }

    // 2. Inject auth (override anything the caller tried to put there).
    const headers: Record<string, string> = {
      Accept: "application/json",
    };
    let finalUrl = url;
    switch (handler.auth.kind) {
      case "header":
        headers[handler.auth.name] = apiKey!;
        break;
      case "query":
        url.searchParams.set(handler.auth.param, apiKey!);
        break;
      case "alchemy":
        // Splice key into the path: `https://{chain}.g.alchemy.com/v2/{KEY}`
        finalUrl = new URL(`https://${url.host}/v2/${apiKey!}`);
        break;
    }

    const init: RequestInit = {
      method: req.method,
      headers,
    };
    if (req.body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(req.body);
    }
    if (req.signal) init.signal = req.signal;

    return this.fetchWithRetry(finalUrl.toString(), init, req, apiKey);
  }

  /**
   * Fetch with bounded retry on transient upstream failures.
   *
   * Retried statuses:
   *   - **429** Too Many Requests — respect `Retry-After` header (sec)
   *     when present, else exponential backoff.
   *   - **502 / 503 / 504** — provider hiccups; exponential backoff.
   *   - Network errors (fetch throws) — exponential backoff.
   *
   * NOT retried:
   *   - 2xx / 3xx — happy path.
   *   - 4xx other than 429 — client bug / forbidden / not found; no
   *     amount of retrying will help.
   *   - Caller-supplied AbortSignal aborted — bail out immediately.
   *
   * Idempotency: our upstream providers (DeBank GET, Helius GET,
   * Etherscan GET, Alchemy JSON-RPC POST) are all idempotent reads, so
   * a retry is always safe. If we ever add a mutating endpoint, gate
   * retries on method.
   *
   * Budget:
   *   - up to MAX_RETRIES extra attempts (default 3 → 4 total attempts)
   *   - per-attempt delay capped at MAX_BACKOFF_MS
   *   - Retry-After capped at 30s (defends against an upstream sending
   *     a hostile Retry-After value)
   *
   * Without this, DeBank's 429s during cron-refresh of multiple wallets
   * would surface as user-facing failures and inflate `api_usage.errors`.
   */
  private async fetchWithRetry(
    url: string,
    init: RequestInit,
    req: ProxyRequest,
    apiKey: string | undefined
  ): Promise<ProxyResponse> {
    const MAX_RETRIES = this.retry.maxRetries;
    const BASE_BACKOFF_MS = this.retry.baseBackoffMs;
    const MAX_BACKOFF_MS = this.retry.maxBackoffMs;
    const MAX_RETRY_AFTER_SEC = this.retry.maxRetryAfterSec;

    let lastError: Error | null = null;
    let lastStatus = 0;
    let lastBody = "";
    let lastContentType: string | null = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (req.signal?.aborted) {
        throw new UpstreamProxyError(
          `Upstream ${req.provider} request aborted`,
          "network",
          req.provider
        );
      }

      try {
        const res = await fetch(url, init);
        const text = await res.text();

        // Success or non-retryable client error → return immediately.
        const isRetryable =
          res.status === 429 ||
          res.status === 502 ||
          res.status === 503 ||
          res.status === 504;
        if (!isRetryable) {
          return {
            status: res.status,
            body: text,
            contentType: res.headers.get("Content-Type"),
            retries: attempt,
          };
        }

        lastStatus = res.status;
        lastBody = text;
        lastContentType = res.headers.get("Content-Type");

        // Out of attempts — return the last response as-is so caller
        // gets a real upstream status code, not a synthetic 500.
        if (attempt === MAX_RETRIES) {
          return {
            status: lastStatus,
            body: lastBody,
            contentType: lastContentType,
            retries: attempt,
          };
        }

        // Calculate sleep: prefer Retry-After (for 429), else expo backoff.
        let sleepMs: number;
        const retryAfter = res.headers.get("Retry-After");
        if (res.status === 429 && retryAfter) {
          // Retry-After can be seconds or HTTP-date. We support seconds —
          // HTTP-date is rare for rate-limit responses.
          const sec = Number.parseInt(retryAfter, 10);
          if (Number.isFinite(sec) && sec > 0) {
            sleepMs = Math.min(sec, MAX_RETRY_AFTER_SEC) * 1000;
          } else {
            sleepMs = expoBackoff(attempt, BASE_BACKOFF_MS, MAX_BACKOFF_MS);
          }
        } else {
          sleepMs = expoBackoff(attempt, BASE_BACKOFF_MS, MAX_BACKOFF_MS);
        }
        await sleep(sleepMs);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt === MAX_RETRIES) break;
        await sleep(expoBackoff(attempt, BASE_BACKOFF_MS, MAX_BACKOFF_MS));
      }
    }

    // All attempts exhausted with network error.
    const raw = lastError ? lastError.message : "unknown network error";
    throw new UpstreamProxyError(
      `Upstream ${req.provider} request failed after ${MAX_RETRIES + 1} attempts: ${redactKey(raw, apiKey)}`,
      "network",
      req.provider
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Exponential backoff with full jitter:
 *   attempt 0 → ~base
 *   attempt 1 → ~base × 2
 *   attempt 2 → ~base × 4
 * Jitter prevents thundering-herd when many requests hit a 429 wall
 * at the same wall-clock moment (e.g. cron-refresh of 10 accounts).
 */
function expoBackoff(attempt: number, baseMs: number, maxMs: number): number {
  const deterministic = Math.min(maxMs, baseMs * Math.pow(2, attempt));
  return Math.floor(deterministic * (0.5 + Math.random() * 0.5));
}

function redactKey(s: string, key: string | undefined): string {
  if (!key) return s;
  return s.split(key).join("***");
}
