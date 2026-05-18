import type { CexCredentials, ExchangeId } from "./cex.types.js";
import type { CexProxyConfig } from "./cex.proxy.js";
import type { IP2pClient, IP2pClientFactory } from "./cex.p2p.types.js";
import { BitgetP2pClient } from "./cex.p2p.bitget.js";

/**
 * Map exchange id → P2P client. Returns `null` for exchanges where we
 * haven't yet built a P2P adapter — service layer surfaces that as
 * `supported: false` so the UI can grey the button out instead of
 * 500-ing.
 *
 * To add a new exchange:
 *   1. Implement `IP2pClient` in a new file (e.g. `cex.p2p.bybit.ts`)
 *      with the exchange's HMAC/JWT scheme
 *   2. Wire it into the switch below
 *   3. Pin the JSON response shape with a fixture-based test (formats
 *      drift; without a pin future regressions go unnoticed)
 */
export const createP2pClient: IP2pClientFactory = (
  exchange: ExchangeId,
  creds: CexCredentials,
  proxy: CexProxyConfig | null = null
): IP2pClient | null => {
  switch (exchange) {
    case "bitget":
      return new BitgetP2pClient(creds, proxy);
    case "bybit":
    case "okx":
    case "mexc":
    case "bingx":
      // TODO: implement per-exchange P2P clients. Each exchange has
      // its own auth scheme and endpoint structure:
      //   - Bybit:  /v5/otc/buy-history, /v5/otc/sell-history (HMAC v3)
      //   - OKX:    /api/v5/c2c/... (OK-ACCESS-* headers)
      //   - MEXC:   public P2P API not stably documented for retail
      //   - BingX:  P2P API not publicly documented (skip for now)
      return null;
    default:
      return null;
  }
};
