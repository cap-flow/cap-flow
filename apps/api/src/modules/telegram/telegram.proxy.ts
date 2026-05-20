import type { FastifyBaseLogger } from "fastify";
import { ProxyAgent as UndiciProxyAgent } from "undici";

/**
 * Optional proxy for outgoing Telegram Bot API requests.
 *
 * `TelegramService.send` uses native `fetch`, which under Node 18+ runs
 * on undici. To route through a proxy we pass a `Dispatcher` instance
 * via `fetch(url, { dispatcher })`. SOCKS is not supported by undici —
 * if a `socks://` URL is configured the dispatcher is null and the
 * request goes direct (logged at refresh time so operator notices).
 */
export interface TelegramProxyConfig {
  readonly url: string;
  readonly dispatcher: UndiciProxyAgent | null;
  readonly kind: "http" | "https" | "socks";
}

export function loadTelegramProxyConfig(
  url: string | null | undefined,
): TelegramProxyConfig | null {
  const trimmed = (url ?? "").trim();
  if (!trimmed) return null;
  let kind: TelegramProxyConfig["kind"];
  let dispatcher: UndiciProxyAgent | null;
  if (/^socks/i.test(trimmed)) {
    kind = "socks";
    dispatcher = null; // undici can't SOCKS
  } else {
    kind = /^https:/i.test(trimmed) ? "https" : "http";
    dispatcher = new UndiciProxyAgent(trimmed);
  }
  return { url: trimmed, dispatcher, kind };
}

/**
 * Cached Telegram-proxy configuration with manual refresh hook.
 * Mirror of `CexProxyState` — see that file for the design rationale
 * (avoid per-request Agent allocation; hot-reload on admin PATCH).
 */
export class TelegramProxyState {
  private cached: TelegramProxyConfig | null = null;
  private readonly envFallback: string | null;

  constructor(
    envFallback: string | null | undefined,
    private readonly resolveFromDb: () => Promise<string | null>,
    private readonly log: FastifyBaseLogger,
  ) {
    this.envFallback = envFallback?.trim() || null;
  }

  currentSync(): TelegramProxyConfig | null {
    return this.cached;
  }

  async refresh(): Promise<TelegramProxyConfig | null> {
    let dbValue: string | null = null;
    try {
      dbValue = (await this.resolveFromDb())?.trim() || null;
    } catch (e) {
      this.log.warn(
        { err: (e as Error).message },
        "[telegram] proxy DB lookup failed — falling back to env",
      );
    }
    const url = dbValue ?? this.envFallback;
    const previousUrl = this.cached?.url ?? null;
    let next: TelegramProxyConfig | null = null;
    if (url) {
      try {
        next = loadTelegramProxyConfig(url);
      } catch (e) {
        this.log.error(
          { err: (e as Error).message, url: maskSecret(url) },
          "[telegram] proxy URL malformed — keeping previous config",
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
        "[telegram] proxy config updated",
      );
    }
    return this.cached;
  }
}

function maskSecret(url: string): string {
  return url.replace(/:\/\/([^@/]+@)/, "://***@");
}
