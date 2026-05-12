import type {
  DeBankComplexProtocol,
  DeBankPortfolioItem,
  DeBankTokenBalance,
} from "../debank";
import type { HeliusBalances } from "../helius";
import type { SavedWallet } from "../wallets";
import type {
  VybeDefiPositionsResponse,
  VybePosition,
  VybeTokenLine,
} from "../vybe";
import type {
  JupiterPortfolioElement,
  JupiterPortfolioResponse,
  JupiterPortfolioTokenAsset,
} from "../jupiter";
import type {
  CoinStatsBalanceItem,
  CoinStatsDefiResponse,
  CoinStatsDefiProtocol,
} from "../coinstats";
import { coinStatsChainLabel } from "../coinstats_chains";
import { isProtocolToken, isStableSymbol } from "./protocols";
import {
  SOL_NATIVE_MINT,
  SPL_TOKENS,
  isStableMint,
  looksLikeSpam,
  positionForMint,
  symbolForMint,
} from "./spl_tokens";
import type {
  LiveProtocolPosition,
  LiveSnapshot,
  LiveTokenBalance,
} from "./live";

const DUST_USD = 1;

/**
 * EVM-токены, которые на самом деле — receipt-токены позиций (LP, depo).
 * DeBank возвращает их и в token_list, и в complex_protocol_list одновременно,
 * что приводит к двойному показу. Фильтруем из балансов; они уже видны как
 * позиции в complex_protocol_list.
 */
const EVM_RECEIPT_TOKEN_SYMBOLS = new Set([
  "GM",       // GMX V2 market token (Arbitrum, Avalanche)
  "GLP",      // GMX v1 liquidity provider
  "GMSL",     // GMX synthetic LP
  "ESGMX",    // GMX escrowed
  "FSGLP",    // GMX fee-share GLP
  "MMX",      // Madonna market token
]);

/* -------------------------------------------------------------------------- */
/*  EVM (DeBank) → LiveSnapshot                                                */
/* -------------------------------------------------------------------------- */

export function adaptDeBankLive(args: {
  wallet: SavedWallet;
  totalUsd: number;
  tokens: DeBankTokenBalance[];
  protocols: DeBankComplexProtocol[];
}): LiveSnapshot {
  const tokens: LiveTokenBalance[] = [];
  for (const tk of args.tokens) {
    const usd = (tk.price ?? 0) * tk.amount;
    if (usd < DUST_USD) continue;

    // Skip GMX V2 GM, GLP и пр. receipt-токены — они не "наличные" пользователя,
    // они — позиция. Будут показаны в Active DeFi positions через DeBank.
    if (EVM_RECEIPT_TOKEN_SYMBOLS.has(tk.symbol.toUpperCase())) continue;

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
      // У DeBank пометки verified нет в этом эндпоинте, но он сам фильтрует
      // дешёвый спам — токены с ненулевой price считаем «известными».
      isKnown: Boolean(tk.price && tk.logo_url),
    });
  }

  const positions: LiveProtocolPosition[] = [];
  for (const proto of args.protocols) {
    for (const item of proto.portfolio_item_list) {
      if (item.stats.net_usd_value < DUST_USD && item.stats.asset_usd_value < DUST_USD) continue;
      positions.push(deBankItemToPosition(args.wallet, proto, item));
    }
  }

  return { totalUsd: args.totalUsd, tokens, positions };
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
  // lpTokenId — идентификатор маркета/пула для уникализации позиций
  // в протоколах с множеством маркетов (GMX V2: GM[BTC]/GM[ETH]/GLV[…]).
  // Берём в порядке предпочтения:
  //   1. detail.token.id — прямой адрес LP-receipt'а (для vault-style).
  //   2. Ищем protocol-token (GM/GLV/GLP/FLP/aXXX/cXXX/...) в supply_token_list
  //      и берём его id — т.к. DeBank часто кладёт LP-receipt именно сюда.
  //   3. pool.id — DeBank's pool identifier (может НЕ совпадать с mint'ом).
  // Нормализуем убирая chain prefix ("arb:0x..." → "0x...") чтобы
  // совпадало с `linkedLpTokenId` из ops после `link_async_deposits`.
  const supplyProtoToken = (item.detail.supply_token_list ?? []).find((t) =>
    isProtocolToken(t.symbol),
  );
  const rawLpId =
    item.detail.token?.id ?? supplyProtoToken?.id ?? item.pool?.id;
  // Нормализуем формат:
  //   "arb:0x..."         → "0x..."  (срезаем chain prefix СПЕРЕДИ)
  //   "0x...:lending"     → "0x..."  (срезаем market suffix СЗАДИ)
  //   "0x..."             → "0x..."  (без изменений)
  const lpTokenId = rawLpId
    ? rawLpId
        .replace(/^[a-z]{2,6}:/i, "")
        .replace(/:[a-z][a-z0-9_-]+$/i, "")
    : undefined;
  // Если DeBank вернул нулевой asset_usd_value/debt_usd_value, но
  // супплай/borrow содержит стейблы со фолбэк-ценой $1 — пересчитываем
  // через сумму отдельных токенов.
  const supplyUsdSum = supply.reduce((s, t) => s + (t.usd || 0), 0);
  const borrowUsdSum = borrow.reduce((s, t) => s + (t.usd || 0), 0);
  const finalAssetUsd =
    item.stats.asset_usd_value > 0
      ? item.stats.asset_usd_value
      : supplyUsdSum;
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
}) {
  const symbol = tk.optimized_symbol ?? tk.symbol;
  // Стейбл-токены (AUSD/GHO/USDe/новые) от DeBank иногда приходят с
  // price=0 (не popular enough в DeBank price feed). Фолбэкаем на $1.
  // Без этого Morpho-позиция с AUSD-долгом показывает debtUsd=$0 и
  // соответственно "Стартовая = $0".
  const isStable = isStableSymbol(symbol);
  const fallbackPrice = isStable ? 1 : 0;
  const price = tk.price && tk.price > 0 ? tk.price : fallbackPrice;
  const usd = price * tk.amount;
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
  if (dt.includes("liquidity") || name.includes("liquidity") || name.includes("pool")) return "lp";
  if (dt.includes("staked") || dt.includes("locked") || name.includes("stak")) return "staking";
  if (name.includes("vault") || name.includes("yield")) return "vault";
  if (name.includes("perp") || name.includes("future")) return "perp";
  return dt || "other";
}

/* -------------------------------------------------------------------------- */
/*  Solana (Helius + Jupiter) → LiveSnapshot                                   */
/* -------------------------------------------------------------------------- */

export function adaptSolanaLive(args: {
  wallet: SavedWallet;
  balances: HeliusBalances;
  prices: Map<string, number>;     // mint → USD price
}): LiveSnapshot {
  const tokens: LiveTokenBalance[] = [];
  const positions: LiveProtocolPosition[] = [];

  // Native SOL.
  const sol = args.balances.nativeBalance / 1_000_000_000;
  const solPrice = args.prices.get(SOL_NATIVE_MINT) ?? null;
  const solUsd = solPrice ? solPrice * sol : 0;
  if (solUsd >= DUST_USD || sol > 0) {
    tokens.push({
      symbol: "SOL",
      tokenId: SOL_NATIVE_MINT,
      chain: "sol",
      amount: sol,
      price: solPrice,
      usd: solUsd,
      walletId: args.wallet.id,
      walletName: args.wallet.name,
      isStable: false,
      isKnown: true,
    });
  }

  // SPL-токены.
  for (const t of args.balances.tokens ?? []) {
    if (!t.mint || !t.amount) continue;
    const decimals = t.decimals ?? 0;
    const amount = t.amount / 10 ** decimals;
    if (amount === 0) continue;

    const symbol = symbolForMint(t.mint);
    const price = args.prices.get(t.mint) ?? (isStableMint(t.mint) ? 1 : null);
    const usd = price ? price * amount : 0;
    if (usd < DUST_USD) continue;

    // Явный SPL-спам — пропускаем целиком (даже если Jupiter дал цену).
    if (looksLikeSpam(symbol)) continue;

    const tokenLine: LiveTokenBalance = {
      symbol,
      tokenId: t.mint,
      chain: "sol",
      amount,
      price,
      usd,
      walletId: args.wallet.id,
      walletName: args.wallet.name,
      isStable: isStableMint(t.mint),
      // Известным считаем токен из реестра.
      isKnown: Boolean(SPL_TOKENS[t.mint]),
    };

    // Если это токен-репрезентация позиции (mSOL/JitoSOL/JLP/kTokens) —
    // и кладём в positions, и в tokens (чтобы видеть и в балансе, и как позицию).
    const pos = positionForMint(t.mint, symbol);
    if (pos) {
      positions.push({
        protocolId: pos.protocol,
        protocolName: pos.protocol,
        chain: "sol",
        walletId: args.wallet.id,
        walletName: args.wallet.name,
        category: pos.category,
        itemName:
          pos.category === "staking"
            ? "Staking"
            : pos.category === "lp"
            ? "Liquidity Pool"
            : pos.category === "lending"
            ? "Lending"
            : "Vault",
        netUsd: usd,
        assetUsd: usd,
        debtUsd: 0,
        supply: [{ symbol, amount, usd }],
        borrow: [],
        rewards: [],
      });
    } else {
      tokens.push(tokenLine);
    }
  }

  const totalUsd =
    tokens.reduce((s, t) => s + t.usd, 0) +
    positions.reduce((s, p) => s + p.netUsd, 0);

  return { totalUsd, tokens, positions };
}

/* -------------------------------------------------------------------------- */
/*  Vybe Network → набор LiveProtocolPosition'ов                               */
/* -------------------------------------------------------------------------- */

const VYBE_TYPE_TO_CATEGORY: Record<string, string> = {
  liquidity_pool: "lp",
  liquidity: "lp",
  lending: "lending",
  borrow_lend: "lending",
  borrowlend: "lending",
  staking: "staking",
  liquid_staking: "staking",
  yield: "yield",
  farming: "yield",
  vault: "vault",
  perp: "perp",
  perpetual: "perp",
  leverage: "perp",
};

function lineUsd(t: VybeTokenLine): number {
  return Number(t.valueUsd ?? t.amountUsd ?? 0);
}

function pickRewards(p: VybePosition): VybeTokenLine[] {
  if (!p.rewards) return [];
  if (Array.isArray(p.rewards)) return p.rewards;
  return p.rewards.pending ?? [];
}

function classifyVybeLine(t: VybeTokenLine): "supply" | "borrow" | "reward" {
  const k = `${t.type ?? ""} ${t.side ?? ""}`.toLowerCase();
  if (k.includes("borrow") || k.includes("debt")) return "borrow";
  if (k.includes("reward") || k.includes("yield")) return "reward";
  return "supply";
}

export function adaptVybeLive(args: {
  wallet: SavedWallet;
  vybe: VybeDefiPositionsResponse;
}): LiveProtocolPosition[] {
  const out: LiveProtocolPosition[] = [];
  for (const p of args.vybe.positions ?? []) {
    const protocolName = p.protocolName ?? p.protocol ?? "Solana DeFi";
    const protocolId = p.protocolId ?? protocolName;
    const category =
      VYBE_TYPE_TO_CATEGORY[(p.category ?? p.type ?? "").toLowerCase()] ??
      (p.category ?? p.type ?? "other");

    const supply: { symbol: string; amount: number; usd: number }[] = [];
    const borrow: { symbol: string; amount: number; usd: number }[] = [];
    const rewards: { symbol: string; amount: number; usd: number }[] = [];

    // Раздельные supply/borrow.
    for (const t of p.supplied ?? []) {
      supply.push({ symbol: t.symbol ?? "?", amount: Number(t.amount ?? 0), usd: lineUsd(t) });
    }
    for (const t of p.borrowed ?? []) {
      borrow.push({ symbol: t.symbol ?? "?", amount: Number(t.amount ?? 0), usd: lineUsd(t) });
    }
    for (const t of pickRewards(p)) {
      rewards.push({ symbol: t.symbol ?? "?", amount: Number(t.amount ?? 0), usd: lineUsd(t) });
    }
    // Универсальный массив tokens — режем по type/side.
    for (const t of p.tokens ?? []) {
      const cls = classifyVybeLine(t);
      const line = { symbol: t.symbol ?? "?", amount: Number(t.amount ?? 0), usd: lineUsd(t) };
      if (cls === "borrow") borrow.push(line);
      else if (cls === "reward") rewards.push(line);
      else supply.push(line);
    }

    const assetUsd =
      p.assetUsd ??
      supply.reduce((s, l) => s + l.usd, 0) + rewards.reduce((s, l) => s + l.usd, 0);
    const debtUsd =
      p.debtUsd ?? borrow.reduce((s, l) => s + l.usd, 0);
    const netUsd = p.netValueUsd ?? p.valueUsd ?? assetUsd - debtUsd;

    // Принимаем позицию, если есть хоть какие-то ассеты или netUsd. Раньше
    // фильтр был слишком строгим и мог отбрасывать низколиквидные позиции.
    const hasContent =
      Math.abs(netUsd) > 0 || supply.length > 0 || borrow.length > 0 ||
      Math.abs(assetUsd) > 0 || Math.abs(debtUsd) > 0;
    if (!hasContent) continue;

    const position: LiveProtocolPosition = {
      protocolId,
      protocolName,
      protocolLogo: p.protocolLogo ?? null,
      chain: "sol",
      walletId: args.wallet.id,
      walletName: args.wallet.name,
      category,
      itemName: p.poolName ?? p.name ?? humanItemName(category),
      netUsd,
      assetUsd,
      debtUsd,
      healthRate: p.healthRatio ?? p.healthRate ?? null,
      supply,
      borrow,
      rewards,
    };
    out.push(position);
  }
  return out;
}

function humanItemName(category: string): string {
  switch (category) {
    case "lp": return "Liquidity Pool";
    case "lending": return "Lending";
    case "staking": return "Staking";
    case "yield": return "Yield";
    case "perp": return "Perp";
    case "vault": return "Vault";
    default: return category || "Position";
  }
}

/* -------------------------------------------------------------------------- */
/*  Jupiter Portfolio (бывший SonarWatch) → LiveProtocolPosition[]             */
/* -------------------------------------------------------------------------- */

const JUP_TYPE_TO_CATEGORY: Record<string, string> = {
  borrowlend: "lending",
  liquidity: "lp",
  leverage: "perp",
  multiple: "yield",
  single: "yield",
};

function jupAssetToLine(a: JupiterPortfolioTokenAsset): { symbol: string; amount: number; usd: number } {
  return {
    symbol: a.name ?? "?",
    amount: a.data?.amount ?? 0,
    usd: a.value ?? 0,
  };
}

function adaptJupiterPortfolioElement(wallet: SavedWallet, el: JupiterPortfolioElement): LiveProtocolPosition | null {
  if (!el.value || el.value < 1) return null;
  const platformName = el.platformId
    .split(/[-_]/)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join(" ");
  const category =
    JUP_TYPE_TO_CATEGORY[el.type] ?? (el.label?.toLowerCase().includes("liquid") ? "staking" : "yield");

  const supply: { symbol: string; amount: number; usd: number }[] = [];
  const borrow: { symbol: string; amount: number; usd: number }[] = [];
  const rewards: { symbol: string; amount: number; usd: number }[] = [];

  for (const a of el.data.suppliedAssets ?? []) supply.push(jupAssetToLine(a));
  for (const a of el.data.borrowedAssets ?? []) borrow.push(jupAssetToLine(a));
  for (const a of el.data.rewardAssets ?? []) rewards.push(jupAssetToLine(a));
  for (const a of el.data.assets ?? []) supply.push(jupAssetToLine(a));

  const debtUsd = el.data.borrowedValue ?? borrow.reduce((s, l) => s + l.usd, 0);
  const assetUsd = el.data.suppliedValue ?? supply.reduce((s, l) => s + l.usd, 0) + rewards.reduce((s, l) => s + l.usd, 0);

  return {
    protocolId: el.platformId,
    protocolName: platformName,
    chain: "sol",
    walletId: wallet.id,
    walletName: wallet.name,
    category,
    itemName: el.name ?? el.label ?? humanItemName(category),
    netUsd: el.value,
    assetUsd,
    debtUsd,
    healthRate: el.data.healthRatio ?? null,
    supply,
    borrow,
    rewards,
  };
}

export function adaptJupiterPortfolioLive(args: {
  wallet: SavedWallet;
  portfolio: JupiterPortfolioResponse;
}): LiveProtocolPosition[] {
  const out: LiveProtocolPosition[] = [];
  for (const el of args.portfolio.elements ?? []) {
    // В `elements` встречается также раздел "Wallet" с балансами
    // токенов — он у нас уже есть из Helius; пропускаем.
    if (el.label === "Wallet" || el.platformId === "wallet-tokens") continue;
    const pos = adaptJupiterPortfolioElement(args.wallet, el);
    if (pos) out.push(pos);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*  CoinStats → LiveSnapshot (TON, Bitcoin, Aptos, Sui, Cosmos, новые EVM L2) */
/* -------------------------------------------------------------------------- */

export function adaptCoinStatsLive(args: {
  wallet: SavedWallet;
  /** CoinStats `connectionId` — копируем в LiveTokenBalance.chain. */
  connectionId: string;
  balance: CoinStatsBalanceItem[];
  defi: CoinStatsDefiResponse;
}): LiveSnapshot {
  const chainLabel = coinStatsChainLabel(args.connectionId);
  const tokens: LiveTokenBalance[] = args.balance
    .filter((b) => b.amount > 0)
    .map((b) => {
      const usd = b.amount * (b.price ?? 0);
      return {
        symbol: b.symbol,
        tokenId: b.contractAddress ?? b.coinId,
        chain: args.connectionId,
        amount: b.amount,
        price: b.price ?? null,
        usd,
        walletId: args.wallet.id,
        walletName: args.wallet.name,
        isStable: isStableSymbol(b.symbol),
        ...(b.imgUrl && { logo: b.imgUrl }),
        // CoinStats возвращает только токены, которые он знает →
        // считаем их known.
        isKnown: true,
      };
    });

  const positions: LiveProtocolPosition[] = [];
  for (const proto of args.defi.protocols ?? []) {
    const protoPositions = adaptCoinStatsProtocol(
      args.wallet,
      args.connectionId,
      chainLabel,
      proto,
    );
    positions.push(...protoPositions);
  }

  const totalUsd =
    args.defi.totalAssets?.USD ??
    tokens.reduce((s, t) => s + t.usd, 0) +
      positions.reduce((s, p) => s + p.netUsd, 0);

  return { totalUsd, tokens, positions };
}

/**
 * Раскладывает `assets[]` инвестиции CoinStats по supply / borrow / rewards
 * на основании поля `title`. Реальные значения из API:
 *   "Deposit" / "Supply" / "Stake" / "Provide Liquidity" / "Locked" → supply
 *   "Borrow" / "Debt" → borrow
 *   "Reward" / "Pending Reward" / "Claimable" → rewards
 */
function bucketCoinStatsAsset(
  title: string,
): "supply" | "borrow" | "rewards" {
  const t = title.toLowerCase();
  if (t.includes("debt") || t.includes("borrow")) return "borrow";
  if (t.includes("reward") || t.includes("claim")) return "rewards";
  return "supply";
}

function adaptCoinStatsProtocol(
  wallet: SavedWallet,
  connectionId: string,
  chainLabel: string,
  proto: CoinStatsDefiProtocol,
): LiveProtocolPosition[] {
  const out: LiveProtocolPosition[] = [];
  // CoinStats реально кладёт позиции в `investments`. Старое имя `positions`
  // оставлено как fallback на случай старых ответов.
  const subs = proto.investments ?? proto.positions ?? [];
  for (const inv of subs) {
    const supply: { symbol: string; amount: number; usd: number }[] = [];
    const borrow: { symbol: string; amount: number; usd: number }[] = [];
    const rewards: { symbol: string; amount: number; usd: number }[] = [];

    for (const a of inv.assets ?? []) {
      const usd = a.price?.USD ?? 0;
      const line = {
        symbol: a.symbol ?? "?",
        amount: Number(a.amount ?? 0),
        usd,
      };
      const bucket = bucketCoinStatsAsset(a.title ?? "");
      if (bucket === "borrow") borrow.push(line);
      else if (bucket === "rewards") rewards.push(line);
      else supply.push(line);
    }

    const assetUsd = supply.reduce((s, t) => s + t.usd, 0);
    const debtUsd = borrow.reduce((s, t) => s + t.usd, 0);
    const netUsd =
      inv.value?.USD ?? assetUsd - debtUsd + rewards.reduce((s, t) => s + t.usd, 0);
    if (Math.abs(netUsd) < 0.01 && supply.length === 0 && borrow.length === 0) {
      continue;
    }

    const category = inferCategoryFromName(
      inv.type ?? inv.name ?? proto.name ?? "",
    );

    out.push({
      protocolId: proto.protocolId ?? proto.name.toLowerCase().replace(/\s+/g, "_"),
      protocolName: proto.name,
      ...(proto.logo && { protocolLogo: proto.logo }),
      chain: connectionId,
      walletId: wallet.id,
      walletName: wallet.name,
      category,
      itemName: inv.name ?? inv.type ?? chainLabel,
      netUsd,
      assetUsd,
      debtUsd,
      supply,
      borrow,
      rewards,
    });
  }
  return out;
}

function inferCategoryFromName(s: string): string {
  const x = s.toLowerCase();
  if (x.includes("lend") || x.includes("supply") || x.includes("loan")) return "lending";
  if (x.includes("liquid") || x.includes("lp") || x.includes("pool")) return "lp";
  if (x.includes("stak") || x.includes("locked")) return "staking";
  if (x.includes("vault") || x.includes("yield")) return "vault";
  if (x.includes("perp") || x.includes("future")) return "perp";
  return "other";
}
