/**
 * EVM DeBank → LiveSnapshot adapter (server port).
 *
 * Pure, framework-free port of `adaptDeBankLive` from the web client
 * (`apps/web/src/lib/portfolio/live_adapters.ts`). Takes the RAW DeBank
 * payloads (token balances + complex-protocol positions) and produces the
 * chain-neutral `LiveSnapshot` the UCB engine consumes.
 *
 * ONLY the EVM path is ported here — Solana / Vybe / Jupiter / CoinStats
 * adapters stay client-side. No React, localStorage, window, or fetch.
 *
 * Output types come from the shared engine (`@cap-flow/ucb`); the `isStableSymbol`
 * / `isProtocolToken` heuristics are reused from `@cap-flow/ucb/protocols` rather
 * than re-ported.
 */
import type {
  LiveProtocolPosition,
  LivePositionTokenLine,
  LiveSnapshot,
  LiveTokenBalance,
} from "@cap-flow/ucb/live";
import type { SavedWallet } from "@cap-flow/ucb/wallet";
import { isProtocolToken, isStableSymbol } from "@cap-flow/ucb/protocols";

/* -------------------------------------------------------------------------- */
/*  DeBank input types (ported from apps/web/src/lib/debank.ts)                */
/* -------------------------------------------------------------------------- */

export interface DeBankTokenBalance {
  id: string;
  chain: string;
  name: string;
  symbol: string;
  decimals: number;
  logo_url: string | null;
  price?: number;
  is_verified?: boolean;
  is_core?: boolean;
  is_wallet?: boolean;
  amount: number;
  raw_amount?: number;
}

export interface DeBankComplexProtocolToken {
  id: string;
  chain: string;
  name: string;
  symbol: string;
  optimized_symbol?: string;
  decimals: number;
  amount: number;
  price?: number;
  logo_url?: string | null;
}

export interface DeBankPortfolioItemStats {
  asset_usd_value: number;
  debt_usd_value: number;
  net_usd_value: number;
}

export interface DeBankPortfolioItem {
  name: string;
  detail_types: string[];
  detail: {
    supply_token_list?: DeBankComplexProtocolToken[];
    borrow_token_list?: DeBankComplexProtocolToken[];
    reward_token_list?: DeBankComplexProtocolToken[];
    token?: DeBankComplexProtocolToken;
    health_rate?: number;
    description?: string;
  };
  stats: DeBankPortfolioItemStats;
  update_at?: number;
  pool?: { id: string; chain: string };
  proxy_detail?: unknown;
}

export interface DeBankComplexProtocol {
  id: string;
  chain: string;
  name: string;
  logo_url: string | null;
  site_url?: string;
  has_supported_portfolio?: boolean;
  portfolio_item_list: DeBankPortfolioItem[];
}

/* -------------------------------------------------------------------------- */

const DUST_USD = 1;

/**
 * EVM-токены, которые на самом деле — receipt-токены позиций (LP, depo).
 * DeBank возвращает их и в token_list, и в complex_protocol_list одновременно,
 * что приводит к двойному показу. Фильтруем из балансов; они уже видны как
 * позиции в complex_protocol_list.
 */
const EVM_RECEIPT_TOKEN_SYMBOLS = new Set([
  "GM", // GMX V2 market token (Arbitrum, Avalanche)
  "GLP", // GMX v1 liquidity provider
  "GMSL", // GMX synthetic LP
  "ESGMX", // GMX escrowed
  "FSGLP", // GMX fee-share GLP
  "MMX", // Madonna market token
]);

/**
 * Convention-based detection for receipt tokens (Aave aTokens, Compound
 * cTokens, Fluid fTokens, LST family, Pendle wrappers). NOT a security
 * filter — false-positives only hide a token from the dashboard; its value
 * is still reflected via the protocol position. The REAL filter is
 * `receiptTokenIdsFromProtocols()` below; this prefix check is the fallback
 * when the protocol payload didn't surface a contract id.
 */
function isReceiptTokenByConvention(symbol: string): boolean {
  const s = symbol.toUpperCase();
  if (EVM_RECEIPT_TOKEN_SYMBOLS.has(s)) return true;
  // Aave aTokens — second char must be uppercase (avoid matching "APE", "ATOM").
  if (/^A(USDC|USDT|DAI|WETH|ETH|WBTC|LINK|UNI|AAVE|MATIC|FRAX|SUSDE)$/.test(s)) {
    return true;
  }
  // Compound cTokens.
  if (/^C(USDC|USDT|DAI|WETH|ETH|WBTC|COMP|UNI|MATIC|FRAX)$/.test(s)) {
    return true;
  }
  // Fluid fTokens.
  if (/^F(USDC|USDT|DAI|WETH|ETH|WBTC)$/.test(s)) return true;
  // Compound III ("Comet") — cWETHv3, cUSDCv3.
  if (/^C(USDC|USDT|WETH|ETH|WBTC)V3$/.test(s)) return true;
  // Liquid staking / restaking tokens.
  if (/^(ST|WST|R|SFRX|UNI|RSWST|EZ|WEEZ|WEETH|WBETH|CBETH)ETH$/.test(s)) {
    return true;
  }
  if (s === "SAVAX" || s === "STMATIC" || s === "RETH" || s === "STBTC") return true;
  // Pendle.
  if (/^(PT|YT|SY|LP)[-_]/.test(s)) return true;
  // Spark sToken.
  if (/^S(USDC|USDT|DAI|WETH|ETH)$/.test(s)) return true;
  return false;
}

/**
 * Build the set of receipt-token contract IDs that already participate in
 * this wallet's DeFi positions. Any matching id in the bare token list is a
 * double-count and must be filtered. Indexed by lowercase id; both chain-
 * prefixed and naked forms are added so callers needn't normalize.
 */
function receiptTokenIdsFromProtocols(
  protocols: DeBankComplexProtocol[],
): Set<string> {
  const out = new Set<string>();
  for (const proto of protocols) {
    for (const item of proto.portfolio_item_list) {
      const tokId = item.detail.token?.id;
      if (tokId) {
        const lc = tokId.toLowerCase();
        out.add(lc);
        out.add(lc.replace(/^[a-z]{2,6}:/, ""));
      }
      const poolId = item.pool?.id;
      if (poolId) {
        const lc = poolId.toLowerCase();
        out.add(lc);
        out.add(lc.replace(/^[a-z]{2,6}:/, ""));
      }
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*  EVM (DeBank) → LiveSnapshot                                                */
/* -------------------------------------------------------------------------- */

export function adaptDeBankLive(args: {
  wallet: SavedWallet;
  tokens: DeBankTokenBalance[];
  protocols: DeBankComplexProtocol[];
  /**
   * DeBank `total_balance.total_usd_value` — passed straight through to the
   * snapshot when available. If omitted, the snapshot total is derived from
   * the kept tokens + positions (sum of usd / netUsd).
   */
  totalUsd?: number;
}): LiveSnapshot {
  // Pre-compute receipt-token contract ids from this wallet's actual DeFi
  // positions; any matching id in the bare token list is a double-count.
  const receiptIds = receiptTokenIdsFromProtocols(args.protocols);

  const tokens: LiveTokenBalance[] = [];
  for (const tk of args.tokens) {
    const usd = (tk.price ?? 0) * tk.amount;
    if (usd < DUST_USD) continue;

    // Content-driven receipt-token filter.
    const lowerId = tk.id.toLowerCase();
    if (
      receiptIds.has(lowerId) ||
      receiptIds.has(lowerId.replace(/^[a-z]{2,6}:/, ""))
    ) {
      continue;
    }
    // Convention-based fallback for receipts DeBank failed to list.
    if (isReceiptTokenByConvention(tk.symbol)) continue;

    // Closed-by-default spam filter: require at least one DeBank flag, or the
    // conservative price+logo proxy capped at <$1000 for un-flagged tokens.
    const debankAcknowledges =
      tk.is_verified === true || tk.is_core === true || tk.is_wallet === true;
    const looksLegitWithoutFlag =
      !debankAcknowledges &&
      typeof tk.price === "number" &&
      tk.price > 0 &&
      typeof tk.logo_url === "string" &&
      tk.logo_url.length > 0 &&
      usd < 1000;
    if (!debankAcknowledges && !looksLegitWithoutFlag) continue;

    tokens.push({
      symbol: tk.symbol,
      tokenId: tk.id,
      chain: tk.chain,
      amount: tk.amount,
      price: tk.price ?? null,
      usd,
      walletId: args.wallet.id,
      walletName: args.wallet.name,
      isStable: isStableSymbol(tk.symbol),
      logo: tk.logo_url ?? null,
      isKnown: debankAcknowledges || Boolean(tk.price && tk.logo_url),
    });
  }

  const positions: LiveProtocolPosition[] = [];
  for (const proto of args.protocols) {
    for (const item of proto.portfolio_item_list) {
      if (
        item.stats.net_usd_value < DUST_USD &&
        item.stats.asset_usd_value < DUST_USD
      ) {
        continue;
      }
      positions.push(deBankItemToPosition(args.wallet, proto, item));
    }
  }

  const totalUsd =
    typeof args.totalUsd === "number"
      ? args.totalUsd
      : tokens.reduce((s, t) => s + t.usd, 0) +
        positions.reduce((s, p) => s + p.netUsd, 0);

  return { totalUsd, tokens, positions };
}

function deBankItemToPosition(
  wallet: SavedWallet,
  proto: DeBankComplexProtocol,
  item: DeBankPortfolioItem,
): LiveProtocolPosition {
  const cat = inferCategory(item);
  const supply = (item.detail.supply_token_list ?? []).map(toLine);
  const borrow = (item.detail.borrow_token_list ?? []).map(toLine);
  const rewards = (item.detail.reward_token_list ?? []).map(toLine);
  if (item.detail.token) supply.push(toLine(item.detail.token));

  // lpTokenId — market/pool identifier to uniquify positions in protocols with
  // multiple markets (GMX V2: GM[BTC]/GM[ETH]/GLV[…]). Preference order:
  //   1. detail.token.id (vault-style LP receipt address)
  //   2. a protocol-token's id in supply_token_list (GM/GLV/aXXX/cXXX/…)
  //   3. pool.id (DeBank's pool identifier)
  const supplyProtoToken = (item.detail.supply_token_list ?? []).find((t) =>
    isProtocolToken(t.symbol),
  );
  const rawLpId =
    item.detail.token?.id ?? supplyProtoToken?.id ?? item.pool?.id;
  // Normalize: strip chain prefix ("arb:0x…" → "0x…") and market suffix
  // ("0x…:lending" → "0x…").
  const lpTokenId = rawLpId
    ? rawLpId.replace(/^[a-z]{2,6}:/i, "").replace(/:[a-z][a-z0-9_-]+$/i, "")
    : undefined;

  // Recompute USD from token lines when DeBank returned 0 (stable fallback $1).
  const supplyUsdSum = supply.reduce((s, t) => s + (t.usd || 0), 0);
  const borrowUsdSum = borrow.reduce((s, t) => s + (t.usd || 0), 0);
  const finalAssetUsd =
    item.stats.asset_usd_value > 0 ? item.stats.asset_usd_value : supplyUsdSum;
  const finalDebtUsd =
    item.stats.debt_usd_value > 0 ? item.stats.debt_usd_value : borrowUsdSum;
  const finalNetUsd =
    item.stats.net_usd_value !== 0
      ? item.stats.net_usd_value
      : finalAssetUsd - finalDebtUsd;

  return {
    protocolId: proto.id,
    protocolName: proto.name,
    protocolLogo: proto.logo_url,
    chain: proto.chain,
    walletId: wallet.id,
    walletName: wallet.name,
    category: cat,
    itemName: item.name || cat,
    netUsd: finalNetUsd,
    assetUsd: finalAssetUsd,
    debtUsd: finalDebtUsd,
    healthRate: item.detail.health_rate ?? null,
    supply,
    borrow,
    rewards,
    ...(lpTokenId && { lpTokenId }),
  };
}

function toLine(tk: {
  id?: string;
  amount: number;
  price?: number;
  symbol: string;
  optimized_symbol?: string;
}): LivePositionTokenLine {
  const symbol = tk.optimized_symbol ?? tk.symbol;
  // Stable tokens (AUSD/GHO/USDe/новые) sometimes arrive price=0 from DeBank;
  // fall back to $1 so debt/supply USD isn't silently $0.
  const isStable = isStableSymbol(symbol);
  const fallbackPrice = isStable ? 1 : 0;
  const price = tk.price && tk.price > 0 ? tk.price : fallbackPrice;
  const usd = price * tk.amount;
  // NB: match the client adapter EXACTLY — `isStable` is computed for the
  // price fallback but NOT surfaced on the line. The shared cost-basis engine
  // (open_positions buildSupplyToken) reads `supplyToken.isStable` to PIN cost
  // basis to $1; the client leaves it undefined → tracker WAC. Surfacing it here
  // would make the SERVER pin stable supply to $1 while the client uses the
  // tracker — a client↔server cost-basis divergence (depeg / EUR-stable / stable
  // bought off $1). Leave it off for byte-parity.
  return {
    symbol,
    amount: tk.amount,
    usd,
    ...(tk.id && { tokenId: tk.id }),
  };
}

function inferCategory(item: DeBankPortfolioItem): string {
  const dt = (item.detail_types?.[0] ?? "").toLowerCase();
  const name = (item.name ?? "").toLowerCase();
  if (dt.includes("lending") || name.includes("lending")) return "lending";
  if (
    dt.includes("liquidity") ||
    name.includes("liquidity") ||
    name.includes("pool")
  ) {
    return "lp";
  }
  if (dt.includes("staked") || dt.includes("locked") || name.includes("stak")) {
    return "staking";
  }
  if (name.includes("vault") || name.includes("yield")) return "vault";
  if (name.includes("perp") || name.includes("future")) return "perp";
  return dt || "other";
}
