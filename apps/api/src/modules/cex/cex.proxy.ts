import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";
import { ProxyAgent as UndiciProxyAgent } from "undici";
import type { Agent as HttpAgent } from "node:http";

/**
 * Optional proxy configuration for outgoing CEX traffic.
 *
 * Use this when the API runs in a region the exchange's CDN
 * geoblocks (Bybit / OKX / BingX from RU/CIS). One URL covers BOTH
 * the CCXT client (uses a Node `http.Agent`) AND the native-fetch
 * Bitget P2P client (uses an undici `Dispatcher`).
 *
 * Resolution order (first non-empty wins):
 *   1. explicit env arg passed to `loadCexProxyConfig()`
 *   2. `HTTPS_PROXY` (standard ops convention)
 *   3. `https_proxy` (lowercase — also common)
 *
 * Schemes:
 *   - http://  / https://   →  HttpsProxyAgent  +  undici ProxyAgent
 *   - socks5:// / socks4://  →  SocksProxyAgent (CCXT only; undici has
 *                              no native SOCKS support, the Bitget P2P
 *                              client will fall back to a direct
 *                              connection and log a warning)
 */
export interface CexProxyConfig {
  readonly url: string;
  /** http.Agent compatible — assign to `ccxt-Exchange.agent`. */
  readonly agent: HttpAgent;
  /** undici Dispatcher — pass to native fetch via `{ dispatcher }`. */
  readonly dispatcher: UndiciProxyAgent | null;
  readonly kind: "http" | "https" | "socks";
}

export function loadCexProxyConfig(env: {
  CEX_HTTPS_PROXY?: string | undefined;
}): CexProxyConfig | null {
  const url = (
    env.CEX_HTTPS_PROXY ??
    process.env["HTTPS_PROXY"] ??
    process.env["https_proxy"] ??
    ""
  ).trim();
  if (!url) return null;

  let kind: CexProxyConfig["kind"];
  let agent: HttpAgent;
  let dispatcher: UndiciProxyAgent | null;
  try {
    if (/^socks/i.test(url)) {
      kind = "socks";
      agent = new SocksProxyAgent(url);
      // undici has no built-in SOCKS support — the native-fetch path
      // will run without a proxy. Capflow logs this fact at startup
      // so operators know to also provide an HTTP(S) proxy if Bitget
      // P2P sync also needs proxying.
      dispatcher = null;
    } else {
      kind = /^https:/i.test(url) ? "https" : "http";
      agent = new HttpsProxyAgent(url);
      dispatcher = new UndiciProxyAgent(url);
    }
  } catch (e) {
    throw new Error(
      `Failed to build CEX proxy from URL '${url}': ${(e as Error).message}`
    );
  }
  return { url, agent, dispatcher, kind };
}
