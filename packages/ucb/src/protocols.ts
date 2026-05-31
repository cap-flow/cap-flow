import type { ProtocolCategory, ProtocolInfo } from "./types.js";

/* -------------------------------------------------------------------------- */
/*  Карта подстрок DeBank project_id → категория                               */
/*  Список покрывает топ-50 протоколов по TVL; для остальных вернётся "other". */
/* -------------------------------------------------------------------------- */

const PATTERNS: { match: RegExp; category: ProtocolCategory; name?: string }[] = [
  // Lending
  { match: /aave/i,        category: "lending", name: "Aave" },
  { match: /\bfluid\b/i,   category: "lending", name: "Fluid" },
  { match: /compound/i,    category: "lending", name: "Compound" },
  { match: /morpho/i,      category: "lending", name: "Morpho" },
  { match: /spark/i,       category: "lending", name: "Spark" },
  { match: /radiant/i,     category: "lending", name: "Radiant" },
  { match: /benqi/i,       category: "lending", name: "Benqi" },
  { match: /silo/i,        category: "lending", name: "Silo" },
  { match: /euler/i,       category: "lending", name: "Euler" },
  { match: /venus/i,       category: "lending", name: "Venus" },

  // CDP
  { match: /makerdao|sky\b/i, category: "cdp",  name: "MakerDAO/Sky" },
  { match: /liquity/i,        category: "cdp",  name: "Liquity" },

  // DEX / LP
  { match: /uniswap/i,     category: "dex",     name: "Uniswap" },
  { match: /sushi/i,       category: "dex",     name: "SushiSwap" },
  { match: /pancake/i,     category: "dex",     name: "PancakeSwap" },
  { match: /curve/i,       category: "dex",     name: "Curve" },
  { match: /balancer/i,    category: "dex",     name: "Balancer" },
  { match: /1inch/i,       category: "dex",     name: "1inch" },
  { match: /kyber/i,       category: "dex",     name: "Kyberswap" },
  { match: /paraswap/i,    category: "dex",     name: "ParaSwap" },
  { match: /odos/i,        category: "dex",     name: "Odos" },
  { match: /matcha|0x\b/i, category: "dex",     name: "0x / Matcha" },
  { match: /camelot/i,     category: "dex",     name: "Camelot" },
  { match: /trader.?joe/i, category: "dex",     name: "Trader Joe" },
  { match: /velodrome/i,   category: "dex",     name: "Velodrome" },
  { match: /aerodrome/i,   category: "dex",     name: "Aerodrome" },

  // Staking / LST / LRT
  { match: /lido/i,        category: "staking", name: "Lido" },
  { match: /rocket.?pool/i,category: "staking", name: "Rocket Pool" },
  { match: /frax.?eth|sfrxeth/i, category: "staking", name: "Frax ETH" },
  { match: /ether\.?fi|etherfi/i, category: "restaking", name: "Ether.fi" },
  { match: /eigen/i,       category: "restaking", name: "EigenLayer" },
  { match: /kelp/i,        category: "restaking", name: "Kelp" },
  { match: /renzo/i,       category: "restaking", name: "Renzo" },
  { match: /swell/i,       category: "restaking", name: "Swell" },

  // Yield / pool deposits
  { match: /pendle/i,      category: "yield",   name: "Pendle" },
  { match: /convex/i,      category: "yield",   name: "Convex" },
  { match: /aura/i,        category: "yield",   name: "Aura" },
  { match: /yearn/i,       category: "yield",   name: "Yearn" },
  { match: /beefy/i,       category: "yield",   name: "Beefy" },
  // GMX используется как для perps, так и для пулов (GLP/GM-токены).
  // Категория "yield" даёт правильное taint-отслеживание при депозитах.
  { match: /\bgmx\b/i,     category: "yield",   name: "GMX" },
  { match: /flash.?trade/i, category: "yield",  name: "Flash Trade" },
  { match: /\bjlp\b|jupiter.?lp|jupiter perpetual/i, category: "yield", name: "Jupiter LP" },

  // Perps / derivatives
  { match: /hyperliquid/i, category: "perp",    name: "Hyperliquid" },
  { match: /dydx/i,        category: "perp",    name: "dYdX" },
  { match: /gains/i,       category: "perp",    name: "Gains Network" },
  { match: /vertex/i,      category: "perp",    name: "Vertex" },
  { match: /synthetix/i,   category: "perp",    name: "Synthetix" },

  // Bridges
  { match: /stargate/i,    category: "bridge",  name: "Stargate" },
  { match: /across/i,      category: "bridge",  name: "Across" },
  { match: /synapse/i,     category: "bridge",  name: "Synapse" },
  { match: /cbridge|celer/i, category: "bridge", name: "Celer cBridge" },
  { match: /hop/i,         category: "bridge",  name: "Hop" },
  { match: /connext/i,     category: "bridge",  name: "Connext" },
  { match: /layerzero/i,   category: "bridge",  name: "LayerZero" },
];

/**
 * Классифицирует DeBank project по подстроке его id или имени.
 */

/**
 * Injectable DefiLlama-catalog fallback (A0). The web client wires this in
 * `main.tsx` via `getProtocolMetadataSync` + `mapDefiLlamaToProtocolCategory`;
 * the server (Epic B) may register a DB-backed resolver or none. When NOT
 * registered, `classifyProtocol` skips the catalog and returns "other" for
 * unknown protocols — identical to the previous cold-start behaviour (the
 * in-memory snapshot was empty until `loadLlamaProtocols()` resolved).
 *
 * Mirrors the existing `registerReceiptLessOracle` pattern in token_roles.ts.
 */
export type ProtocolCatalogOracle = (
  projectId: string,
  projectName: string,
) => { name: string | null; category: ProtocolCategory } | null;
let protocolCatalogOracle: ProtocolCatalogOracle | null = null;

/** Register the external DefiLlama-backed protocol-catalog resolver. */
export function registerProtocolCatalogOracle(
  fn: ProtocolCatalogOracle,
): void {
  protocolCatalogOracle = fn;
}

/**
 * Классифицирует DeBank project в три ступени:
 *   1. PATTERNS — топ-50 hard-coded по TVL (быстро, никаких сетевых вызовов).
 *   2. DefiLlama protocols catalog — `getProtocolMetadataSync` ищет в уже
 *      загруженном in-memory snapshot'е ~5000 протоколов. Снапшот
 *      бутстрапится при загрузке приложения через `loadLlamaProtocols()`
 *      в `main.tsx`. Это позволяет ловить нишевые V3/V4 DEX'ы, новые
 *      lending-маркеты и пр., не дописывая каждый раз hardcoded whitelist.
 *   3. Fallback "other" — если catalog ещё не загружен (cold start
 *      первого визита) или DefiLlama не знает протокол. В этом случае
 *      classifier пойдёт по дженерик-веткам (swap / transfer_in / out).
 */
export function classifyProtocol(
  projectId: string | null | undefined,
  projectName: string | null | undefined,
): ProtocolInfo | null {
  if (!projectId && !projectName) return null;
  const haystack = `${projectId ?? ""} ${projectName ?? ""}`;
  for (const p of PATTERNS) {
    if (p.match.test(haystack)) {
      return {
        id: projectId ?? p.name ?? "unknown",
        name: projectName || p.name || projectId || "Unknown",
        category: p.category,
      };
    }
  }
  if (projectId || projectName) {
    // DefiLlama-fallback: ищем в их каталоге по slug/id/name (injected oracle).
    const resolved = protocolCatalogOracle?.(
      projectId ?? "",
      projectName ?? "",
    );
    if (resolved?.category) {
      return {
        id: projectId ?? projectName!,
        name: projectName ?? resolved.name ?? projectId!,
        category: resolved.category,
      };
    }
    return {
      id: projectId ?? projectName!,
      name: projectName ?? projectId!,
      category: "other",
    };
  }
  return null;
}

/* ---------------------------- стейблкоины --------------------------------- */

/**
 * **USD-pegged stablecoins**. Эти токены = $1 в нашей cost basis math.
 *
 * НЕ включает EUR-pegged стейблы (EURC, EURE, EURS, EUROC) — они
 * **не равны $1**, они равны курсу EUR/USD (~$1.05-1.20). Для них
 * используем historical price lookup через DefiLlama (как для любого
 * non-stable). См. `EUR_STABLES` ниже.
 */
const STABLES = new Set([
  "USDT", "USDC", "USDC.E", "DAI", "TUSD", "USDP", "LUSD",
  "BUSD", "FDUSD", "PYUSD", "USDE", "SUSDE", "USDD", "GUSD",
  "FRAX", "CRVUSD", "MIM", "USDS",
  // Tether-native варианты (USD₮0, USDT0, USD0) — те же $1.
  "USDT0", "USD₮0", "USD0",
  // Newer stables (2024-2026): AUSD (Agora USD), GHO (Aave native),
  // sUSDS (Sky savings), USDM (Mountain Protocol), DOLA (Inverse Finance),
  // FXUSD (f(x) Protocol).
  "AUSD", "GHO", "SUSDS", "USDM", "DOLA", "FXUSD",
  // RWA-pegged: BUIDL (BlackRock), USDX (Verified USDX),
  // syrupUSDC (Maple), aUSDC (Aave receipt — но это special case).
]);

/**
 * **EUR-pegged stablecoins**. Не равны $1 — равны курсу EUR/USD.
 * Должны идти через DefiLlama hist price lookup, не через stable=$1.
 */
const EUR_STABLES = new Set([
  "EURC",   // Circle Euro Coin (новый symbol)
  "EUROC",  // Circle Euro Coin (старый symbol, deprecated 2024)
  "EURE",   // Monerium e-Money EUR
  "EURS",   // Stasis Euro
  "AGEUR",  // Angle EUR (deprecated)
  "EURT",   // Tether EUR
  "EURI",   // Eurite (Binance)
  "EUROE",  // Membrane Finance EURO€
]);

/** Returns true if symbol is EUR-pegged stablecoin (NOT $1, use hist price). */
export function isEurStableSymbol(symbol: string): boolean {
  if (!symbol) return false;
  const upper = symbol.toUpperCase();
  return EUR_STABLES.has(upper);
}

/**
 * Liquid-staking ETH derivatives → ETH family.
 *
 * UCB D4: для **display rollup** (E1 AssetsPage) LSTs объединяются с
 * нативным ETH чтобы пользователь видел «суммарный ETH-экспозьюр». Цена
 * 1 stETH ≈ 1 ETH (slight premium/discount from accrued yield), но в
 * USD-units сумма корректна.
 *
 * **Важно**: lot tracker (normalizeSymbol в lot_tracker.ts) их **НЕ**
 * объединяет — каждый stETH-лот хранит свой cost basis отдельно от ETH,
 * чтобы при unstake (Lido → ETH) cost basis передавался через supply chain.
 * Объединение здесь — чисто косметика для group-by-family.
 */
const LST_TO_ETH = new Set([
  "STETH", "WSTETH",
  "RETH",
  "CBETH",
  "FRXETH", "SFRXETH",
  "EETH", "WEETH",
  "EZETH",
  "WBETH",
  "OETH",   // Origin ETH
  "SWETH",  // Swell
  "ANKRETH",
  "OSETH",  // StakeWise V3
  "METH",   // Mantle staked ETH
  "RSWETH", // Renzo restaked swETH
  "RSETH",  // Kelp restaked ETH
]);

/**
 * Liquid-staked / wrapped BTC variants → BTC family.
 * 1:1 pegged or yield-bearing claims on BTC.
 */
const LST_TO_BTC = new Set([
  "WBTC", "TBTC", "CBBTC",
  "LBTC",  // Lombard BTC
  "EBTC",  // Etherfi BTC
  "FBTC",  // Ignition FBTC
  "MBTC",  // Manta merlin BTC
  "SOLVBTC", "SOLVBTCBBN", // Solv BTC + babylon-staked
  "STBTC", // Lorenzo staked BTC
  "PUMPBTC",
  "UNIBTC", // Bedrock uniBTC
]);

/**
 * Нормализованное «семейство» токена — для группировки разных сетевых
 * вариантов одного актива. Примеры:
 *  - `USD₮0` → `USDT` (юникодный T → ASCII)
 *  - `USDC.e` → `USDC` (Avalanche bridged)
 *  - `WETH` / `stETH` / `rETH` → `ETH` (UCB D4)
 *  - `WBTC` / `LBTC` / `cbBTC` → `BTC`
 *  - `USDT0` → `USDT` (Arbitrum обёртка)
 *  - `sDAI` → `DAI` (savings DAI — yield-bearing wrapper)
 *
 * Используется для:
 *  - Поиска в реестре операций (запрос «usdt» находит `USD₮0` тоже)
 *  - Группировки токенов в bulk-разметке фиата
 *  - Аналитики: «по семействам токенов» (asset rollup, realized PnL)
 *
 * **Не используется** для cost-basis pooling в lot tracker — там работает
 * только `normalizeSymbol` (WETH→ETH, всё остальное как есть), чтобы
 * сохранять precise cost basis между LST/native pairs.
 */
export function tokenFamily(symbol: string): string {
  if (!symbol) return "";
  let s = symbol.toUpperCase().trim();
  s = s.replace(/₮/g, "T");
  // Срезаем суффиксы вариантов: USDC.E → USDC, USDT0 → USDT, USDT.0 → USDT.
  s = s.replace(/\.[A-Z0-9]+$/, ""); // .E, .0, .B и т.д.
  s = s.replace(/(?<=[A-Z])0+$/, ""); // USDT0 → USDT
  // ETH family (нативный + WETH + LSTs)
  if (s === "WETH" || LST_TO_ETH.has(s)) return "ETH";
  // BTC family (wrapped + LSTs)
  if (LST_TO_BTC.has(s)) return "BTC";
  // Other simple wrappers
  if (s === "WSOL") return "SOL";
  if (s === "WBNB") return "BNB";
  if (s === "WMATIC") return "MATIC";
  if (s === "WAVAX") return "AVAX";
  // Savings stables → base stable family (UCB D4):
  //   sDAI = yield-bearing DAI deposit receipt → DAI family
  //   sUSDS = sky savings → USDS family (но USDS уже в STABLES,
  //   а SUSDS отдельно; объединяем здесь чтобы пользователь видел
  //   «total USDS exposure»).
  if (s === "SDAI") return "DAI";
  if (s === "SUSDS") return "USDS";
  return s;
}

/**
 * Стейбл-токен. Различаем подделки/обёртки по нормализованному имени:
 *  - Юникодный «₮» → ASCII «T»
 *  - суффиксы `.e`, `.0`, `0` (USDT0, USDC.e, …) → как базовый
 */
export function isStableSymbol(symbol: string): boolean {
  if (!symbol) return false;
  const upper = symbol.toUpperCase();
  if (STABLES.has(upper)) return true;
  // Нормализация: USD₮0 → USDT0, USD₮ → USDT.
  const normalized = upper.replace(/₮/g, "T");
  if (STABLES.has(normalized)) return true;
  // Любой токен начинающийся с USDT/USDC/DAI/USDE и оканчивающийся на цифру/точку — вариант стейбла.
  if (/^(USDT|USDC|DAI|USDE)(\.|[0-9]|$)/.test(normalized)) return true;
  return false;
}

/**
 * Case-SENSITIVE паттерны: критично что aTokens (Aave) пишутся с
 * **lowercase** 'a' (aUSDC, aArbWETH, aEthUSDC), а cTokens — с lowercase 'c'.
 * Если делать `s.toUpperCase()` перед проверкой — получаем ложные срабатывания
 * на любых обычных токенах с заглавной A/C в начале (ARB, AAVE, AVAX, ATOM,
 * ANKR, CRV, CVX, COMP, CAKE и т.п.).
 *
 * Aave V3 chain-specific префиксы: aArb (Arbitrum), aEth (Ethereum), aOpt
 * (Optimism), aPol (Polygon), aBase, aBsc, aAvax. Также legacy без префикса:
 * aUSDC, aWETH, aDAI и т.п.
 *
 * Compound v2: cUSDC, cETH (lowercase c).
 */
const PROTOCOL_TOKEN_PREFIXES_SENSITIVE = [
  // Aave V3 (chain-prefixed): aArbWETH, aEthUSDC, aPolWETH, aOptETH, aBaseUSDC...
  /^a(Arb|Eth|Opt|Pol|Bsc|Avax|Base|Met|Sca|Lin)[A-Z]/,
  // Aave legacy / cross-chain: aUSDC, aWETH, aDAI, aWBTC (lowercase 'a' + caps)
  /^a(USDC|USDT|DAI|WETH|ETH|WBTC|BTC|EURS|LUSD|FRAX|TUSD|sUSDC|sUSDT)/,
  // Aave variable/stable debt tokens (camelCase patterns)
  /^variableDebt/,
  /^stableDebt/,
  // Compound v2: cUSDC, cETH, cDAI, cWBTC (lowercase 'c')
  /^c(USDC|USDT|DAI|WETH|ETH|WBTC|BTC|UNI|LINK|COMP)/,
  // Compound v3 (cToken markets): cUSDCv3, cWETHv3
  /^c[A-Z][a-zA-Z]+v3$/,
];

/**
 * Case-INSENSITIVE паттерны для receipt-токенов где регистр не критичен:
 * staking-LST'ы, LP-токены, GM/GLV market-tokens.
 */
const PROTOCOL_TOKEN_PREFIXES_UPPER = [
  /^MOO/, // Beefy mooXxx
  /^YV/, // Yearn yvXxx
  /^XV/,
  // Liquid staking — фиксированный список (полное совпадение, чтобы не
  // ловить произвольные "ETH"-производные).
  /^STETH$|^WSTETH$|^RETH$|^SFRXETH$|^EETH$|^WEETH$|^EZETH$|^RSETH$|^SWETH$|^OSETH$/,
  // Uniswap / Sushi / Curve / Balancer / Pancake LP-receipts.
  /^SLP$/, /^UNI-V/, /^CRV-?LP/, /^BPT/, /^CAKE-LP/, /VELO-/, /AERO-/,
  // GMX V2 / GMSOL / Flash Trade / Adrena — async-deposit market tokens.
  // DeBank/Helius лейблит их как "GM", "GM [BTC]", "GM:ETH/USD[WETH-USDC]",
  // "GLV(Forex)[USDC]", "GLP", "FLP".
  /^GM($|[\s:[(])/,
  /^GLV($|[\s:[(])/,
  /^GLP$/,
  /^FLP($|[\s:[])/,
  // Fluid Vault NFT — fVLT (case-insensitive: пользователь может видеть как
  // FVLT в DeBank — оба варианта).
  /^FVLT/,
  // LFJ (Trader Joe) Liquidity Book Token — каждый bin даёт отдельный LBT.
  // DeBank нередко возвращает 50+ LBT с amount=2^63 (overflow placeholder).
  /^LBT$/,
  // Pendle PT (Principal Token) и YT (Yield Token) — yield-tranche.
  /^PT-/,
  /^YT-/,
];

export function isProtocolToken(symbol: string): boolean {
  if (!symbol) return false;
  // 1. Case-sensitive проверка для aTokens / cTokens / debt-tokens.
  for (const re of PROTOCOL_TOKEN_PREFIXES_SENSITIVE) {
    if (re.test(symbol)) return true;
  }
  // 2. Case-insensitive проверка для всего остального.
  const upper = symbol.toUpperCase();
  for (const re of PROTOCOL_TOKEN_PREFIXES_UPPER) {
    if (re.test(upper)) return true;
  }
  return false;
}

/**
 * **Строгая расписка** (supply/debt receipt): только aTokens / cTokens /
 * variableDebt / stableDebt — 1:1 «бумажки» в lending протоколах.
 *
 * Не включает GM/GLV/fVLT/LP-токены — они не «расписки» в строгом смысле,
 * это **активные позиции** (perp market-making, vault NFT, AMM LP).
 *
 * Используется для UI-категоризации в Cap Wallet (отдельный блок
 * «Расписки» vs «LP / Vault позиции»), оба исключаются из total капитала.
 */
export function isLendingReceipt(symbol: string): boolean {
  if (!symbol) return false;
  // Case-sensitive: aTokens (Aave) / cTokens (Compound) / debt-tokens.
  for (const re of PROTOCOL_TOKEN_PREFIXES_SENSITIVE) {
    if (re.test(symbol)) return true;
  }
  return false;
}
