import { z } from "zod";

import { tokenStore } from "../auth/token-store";
import { CSRF_HEADER_NAME, readCsrfToken } from "../auth/csrf";

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Base URL the dev server proxies via vite.config (see `/api` proxy entry).
 * In production we'd point at the API host directly via VITE_API_URL.
 *
 * Note: the API mounts its routes under `/api/v1/...` — callers pass paths
 * starting with `/v1/...` (no leading `/api`) and we prepend the base.
 */
const BASE_URL = import.meta.env["VITE_API_URL"] ?? "/api";

const REFRESH_PATH = "/v1/auth/refresh";

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown
  ) {
    super(message);
    this.name = "ApiError";
  }
}

interface RequestOptions<TBody> {
  readonly method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  readonly body?: TBody;
  readonly signal?: AbortSignal;
  /** If true, do not attach Authorization or attempt 401-refresh. Used for
   *  the login/refresh calls themselves so we don't recurse. */
  readonly skipAuth?: boolean;
}

/**
 * Subscribers — invoked when an authenticated request finally gives up
 * (refresh failed → user is logged out). `AuthProvider` uses this to
 * redirect to /login.
 */
type UnauthHandler = () => void;
let unauthHandler: UnauthHandler | null = null;
export function onUnauthorized(handler: UnauthHandler | null): void {
  unauthHandler = handler;
}

/**
 * Single-flight refresh: many requests may race a 401 simultaneously, but
 * we only want one /auth/refresh call out at a time. Subsequent 401s wait
 * on the same promise.
 */
let refreshInFlight: Promise<boolean> | null = null;

async function tryRefresh(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    try {
      const res = await fetch(`${BASE_URL}${REFRESH_PATH}`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) return false;
      const json = (await res.json()) as { accessToken?: string };
      if (!json.accessToken) return false;
      tokenStore.set(json.accessToken);
      return true;
    } catch {
      return false;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

async function executeRaw<TBody>(
  path: string,
  opts: RequestOptions<TBody>
): Promise<Response> {
  const headers: Record<string, string> = {};
  // Only set Content-Type when we actually have a body. Fastify's default
  // JSON content-type parser rejects empty bodies with a 400, so sending
  // the header on a body-less POST (e.g. /auth/logout) would 4xx.
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  if (!opts.skipAuth) {
    // Legacy Bearer header — kept for the migration period while
    // backend still accepts both (cookie OR header). Deprecation TODO
    // 2026-06-XX: remove together with the Bearer fallback in
    // `requireAuth` once cookie auth is verified stable in prod.
    const t = tokenStore.get();
    if (t) headers["Authorization"] = `Bearer ${t}`;
  }
  const method = (opts.method ?? "GET").toUpperCase();
  // Double-submit CSRF token on mutating requests. The backend skips
  // CSRF on login/refresh/invite endpoints; everything else under
  // /api/v1/** requires it (see apps/api/src/plugins/csrf.ts).
  if (MUTATING_METHODS.has(method)) {
    const csrf = readCsrfToken();
    if (csrf) headers[CSRF_HEADER_NAME] = csrf;
  }
  const init: RequestInit = {
    method,
    headers,
    credentials: "include",
  };
  if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
  if (opts.signal) init.signal = opts.signal;
  return fetch(`${BASE_URL}${path}`, init);
}

async function request<TResponse, TBody = unknown>(
  path: string,
  schema: z.ZodType<TResponse>,
  opts: RequestOptions<TBody> = {}
): Promise<TResponse> {
  let res = await executeRaw(path, opts);

  // Single retry on 401 — refresh + retry exactly once. If refresh itself
  // returns 401, give up (user's refresh cookie is gone or revoked).
  if (res.status === 401 && !opts.skipAuth) {
    const ok = await tryRefresh();
    if (ok) {
      res = await executeRaw(path, opts);
    } else {
      tokenStore.set(null);
      if (unauthHandler) unauthHandler();
    }
  }

  if (res.status === 204) {
    return schema.parse(undefined);
  }

  const text = await res.text();
  const json: unknown = text ? JSON.parse(text) : undefined;

  if (!res.ok) {
    throw new ApiError(
      `Request failed: ${res.status} ${res.statusText}`,
      res.status,
      json
    );
  }

  return schema.parse(json);
}

export const api = {
  get: <T>(path: string, schema: z.ZodType<T>, signal?: AbortSignal) =>
    request<T>(path, schema, signal ? { signal } : {}),
  post: <T, B>(path: string, body: B, schema: z.ZodType<T>) =>
    request<T, B>(path, schema, { method: "POST", body }),
  patch: <T, B>(path: string, body: B, schema: z.ZodType<T>) =>
    request<T, B>(path, schema, { method: "PATCH", body }),
  put: <T, B>(path: string, body: B, schema: z.ZodType<T>) =>
    request<T, B>(path, schema, { method: "PUT", body }),
  delete: <T = unknown>(path: string, schema?: z.ZodType<T>) =>
    request<T>(path, schema ?? (z.unknown() as z.ZodType<T>), {
      method: "DELETE",
    }),
  /** Bypass token/refresh — used by login + refresh themselves. */
  postPublic: <T, B>(path: string, body: B, schema: z.ZodType<T>) =>
    request<T, B>(path, schema, { method: "POST", body, skipAuth: true }),
};

/* ----------------------------- raw upstream-proxy fetch -------------------- */

/**
 * Authenticated low-level fetch — same auth/refresh semantics as the
 * typed `api.*` helpers, but returns the raw `Response`. Caller decides
 * how to parse (JSON, text, blob, etc.).
 *
 * Use this for upstream-proxy endpoints (`/v1/upstream/debank/...`,
 * `/v1/upstream/helius/...`) where the response shape is owned by the
 * third-party provider and Zod-validating it would just duplicate
 * upstream's contract.
 *
 * Single retry on 401: same single-flight `tryRefresh()` shared with
 * `api.*`, so racing requests batch into one refresh round-trip.
 *
 * `path` must start with `/v1/...` (no leading `/api`).
 */
export interface ApiFetchOptions {
  readonly method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  readonly body?: unknown;
  readonly signal?: AbortSignal;
  /** Extra headers (e.g. Content-Type override). Caller-set
   *  Authorization is ignored — we always inject the user's Bearer. */
  readonly headers?: Record<string, string>;
}

export async function apiFetch(
  path: string,
  opts: ApiFetchOptions = {}
): Promise<Response> {
  const buildInit = (): RequestInit => {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    delete headers["Authorization"];
    delete headers["authorization"];
    if (opts.body !== undefined && headers["Content-Type"] === undefined) {
      headers["Content-Type"] = "application/json";
    }
    // Legacy Bearer header (deprecation TODO 2026-06-XX).
    const t = tokenStore.get();
    if (t) headers["Authorization"] = `Bearer ${t}`;
    const method = (opts.method ?? "GET").toUpperCase();
    if (MUTATING_METHODS.has(method)) {
      const csrf = readCsrfToken();
      if (csrf) headers[CSRF_HEADER_NAME] = csrf;
    }
    const init: RequestInit = {
      method,
      headers,
      credentials: "include",
    };
    if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
    if (opts.signal) init.signal = opts.signal;
    return init;
  };

  let res = await fetch(`${BASE_URL}${path}`, buildInit());
  if (res.status === 401) {
    const ok = await tryRefresh();
    if (ok) {
      res = await fetch(`${BASE_URL}${path}`, buildInit());
    } else {
      tokenStore.set(null);
      if (unauthHandler) unauthHandler();
    }
  }
  return res;
}
