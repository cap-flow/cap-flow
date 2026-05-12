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
          `Path not allowed for DeBank: ${req.path}`,
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
          `Path not allowed for Helius: ${req.path}`,
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
          `Path not allowed for Etherscan: ${req.path}`,
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
          `Unknown Alchemy chain: ${chain}`,
          "forbidden_path",
          "alchemy"
        );
      }
      // Placeholder URL — key gets spliced in `forward`.
      return new URL(`https://${chain}.g.alchemy.com/`);
    },
  },
};

/* ------------------------- service ---------------------------------------- */

export class UpstreamProxyService {
  constructor(private readonly env: ProxyEnv) {}

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

    let res: Response;
    try {
      res = await fetch(finalUrl.toString(), init);
    } catch (err) {
      // Strip API key from any error message that may have leaked the URL.
      const raw = err instanceof Error ? err.message : String(err);
      throw new UpstreamProxyError(
        `Upstream ${req.provider} request failed: ${redactKey(raw, apiKey)}`,
        "network",
        req.provider
      );
    }

    const text = await res.text();
    return {
      status: res.status,
      body: text,
      contentType: res.headers.get("Content-Type"),
    };
  }
}

function redactKey(s: string, key: string | undefined): string {
  if (!key) return s;
  return s.split(key).join("***");
}
