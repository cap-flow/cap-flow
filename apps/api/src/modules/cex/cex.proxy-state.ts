import type { FastifyBaseLogger } from "fastify";

import { type CexProxyConfig, loadCexProxyConfig } from "./cex.proxy.js";

/**
 * Cached CEX-proxy configuration with manual refresh hook.
 *
 * Why a class instead of recomputing on every CCXT-client construction:
 *   - Resolving the proxy URL means DB read (admin-integrations
 *     override) and an HttpsProxyAgent allocation. Allocating an Agent
 *     per request both wastes CPU and prevents HTTP keep-alive across
 *     calls — Bitget hits /api/v2/tax/p2p-record up to 3 times per
 *     sync, all hot-paths.
 *   - We DO need staleness control: when an admin types a new proxy
 *     URL in the Integrations UI, the change has to land without a
 *     server restart. The PATCH handler explicitly calls
 *     `cexProxyState.refresh()` after saving so the next CEX sync
 *     picks up the new agent.
 *
 * Lifecycle:
 *   - app.ts constructs ONE instance per process and calls
 *     `.refresh()` once at boot (awaiting it so the first request
 *     already sees the right proxy).
 *   - `currentSync()` returns the last cached value with no I/O — the
 *     factory used by CexService calls this on every connect/sync.
 *   - Admin PATCH on `cex_proxy` → `refresh()` → cache updated.
 */
export class CexProxyState {
  private cached: CexProxyConfig | null = null;
  private envFallback: string | null;

  constructor(
    envFallback: string | null | undefined,
    private readonly resolveFromDb: () => Promise<string | null>,
    private readonly log: FastifyBaseLogger
  ) {
    this.envFallback = envFallback?.trim() || null;
  }

  currentSync(): CexProxyConfig | null {
    return this.cached;
  }

  async refresh(): Promise<CexProxyConfig | null> {
    let dbValue: string | null = null;
    try {
      dbValue = (await this.resolveFromDb())?.trim() || null;
    } catch (e) {
      this.log.warn(
        { err: (e as Error).message },
        "[cex] proxy DB lookup failed — falling back to env"
      );
    }
    const url = dbValue ?? this.envFallback;
    const previousUrl = this.cached?.url ?? null;
    let next: CexProxyConfig | null = null;
    if (url) {
      try {
        next = loadCexProxyConfig({ CEX_HTTPS_PROXY: url });
      } catch (e) {
        this.log.error(
          { err: (e as Error).message, url: maskSecret(url) },
          "[cex] proxy URL malformed — keeping previous config"
        );
        return this.cached;
      }
    }
    this.cached = next;
    if (previousUrl !== (next?.url ?? null)) {
      this.log.info(
        {
          proxy: next ? maskSecret(next.url) : null,
          kind: next?.kind ?? "direct",
          source: dbValue ? "db" : this.envFallback ? "env" : "none",
        },
        "[cex] proxy config updated"
      );
    }
    return this.cached;
  }
}

/** Hides `user:pass@` in a proxy URL for logs. */
function maskSecret(url: string): string {
  return url.replace(/:\/\/([^@/]+@)/, "://***@");
}
