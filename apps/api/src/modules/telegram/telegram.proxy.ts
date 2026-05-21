import type { FastifyBaseLogger } from "fastify";
import tls from "node:tls";
import { SocksClient } from "socks";
import { Agent as UndiciAgent, ProxyAgent as UndiciProxyAgent } from "undici";

/**
 * Optional proxy for outgoing Telegram Bot API requests.
 *
 * `TelegramService.send` uses native `fetch`, which on Node 18+ runs on
 * undici. We pass a `Dispatcher` instance via `fetch(url, { dispatcher })`.
 *
 * Supported schemes:
 *   - http://  / https://    → undici `ProxyAgent` (CONNECT tunnel)
 *   - socks5:// / socks5h:// → custom undici `Agent` whose `connect`
 *                              callback uses `socks` package (SocksClient)
 *                              to open a TCP socket through the SOCKS5
 *                              proxy, then TLS-upgrades it for HTTPS.
 *                              `socks5h` is treated as `socks5` (we
 *                              always send the hostname literally, not
 *                              the resolved IP — DNS happens proxy-side).
 *   - socks4:// / socks4a:// → same dispatcher, SocksClient `type: 4`.
 *
 * If the URL is malformed, `loadTelegramProxyConfig` throws; caller
 * (`TelegramProxyState.refresh`) catches and logs.
 */
export interface TelegramProxyConfig {
  readonly url: string;
  readonly dispatcher: UndiciProxyAgent | UndiciAgent | null;
  readonly kind: "http" | "https" | "socks";
}

export function loadTelegramProxyConfig(
  url: string | null | undefined,
): TelegramProxyConfig | null {
  const trimmed = (url ?? "").trim();
  if (!trimmed) return null;
  if (/^socks/i.test(trimmed)) {
    return {
      url: trimmed,
      dispatcher: buildSocksDispatcher(trimmed),
      kind: "socks",
    };
  }
  return {
    url: trimmed,
    dispatcher: new UndiciProxyAgent(trimmed),
    kind: /^https:/i.test(trimmed) ? "https" : "http",
  };
}

/**
 * Build an undici Agent that tunnels through a SOCKS proxy.
 *
 * undici doesn't have native SOCKS support, but `Agent`'s `connect`
 * option lets us plug in a custom connector. We open the TCP socket
 * via `SocksClient.createConnection`, and for HTTPS upgrade it with
 * `tls.connect({ socket })`. This is the canonical pattern from the
 * undici docs.
 */
function buildSocksDispatcher(url: string): UndiciAgent {
  const parsed = new URL(url);
  const type: 4 | 5 = /^socks4/i.test(parsed.protocol) ? 4 : 5;
  const proxyHost = parsed.hostname;
  const proxyPort = Number.parseInt(parsed.port, 10);
  if (!proxyHost || !Number.isFinite(proxyPort)) {
    throw new Error(`SOCKS URL missing host/port: ${url}`);
  }
  const userId = parsed.username
    ? decodeURIComponent(parsed.username)
    : undefined;
  const password = parsed.password
    ? decodeURIComponent(parsed.password)
    : undefined;

  return new UndiciAgent({
    connect: async (opts, callback) => {
      try {
        const destHost = opts.hostname ?? "";
        // undici passes `port` as either a number, string, or empty.
        // Default to 443 (https) / 80 (http) when not specified.
        const rawPort =
          typeof opts.port === "number" && Number.isFinite(opts.port)
            ? opts.port
            : Number.parseInt(String(opts.port ?? ""), 10);
        const destPort = Number.isFinite(rawPort) && rawPort > 0
          ? rawPort
          : opts.protocol === "https:"
            ? 443
            : 80;
        const { socket } = await SocksClient.createConnection({
          proxy: {
            host: proxyHost,
            port: proxyPort,
            type,
            ...(userId !== undefined && { userId }),
            ...(password !== undefined && { password }),
          },
          command: "connect",
          destination: { host: destHost, port: destPort },
          timeout: 15_000,
        });
        if (opts.protocol === "https:") {
          const tlsSocket = tls.connect({
            socket,
            servername:
              (opts as { servername?: string }).servername ?? destHost,
            ALPNProtocols: (opts as { allowH2?: boolean }).allowH2
              ? ["h2", "http/1.1"]
              : ["http/1.1"],
          });
          tlsSocket.once("secureConnect", () => callback(null, tlsSocket));
          tlsSocket.once("error", (err) => callback(err, null));
        } else {
          callback(null, socket);
        }
      } catch (err) {
        callback(err as Error, null);
      }
    },
  });
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
