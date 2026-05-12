/**
 * Контекстная классификация роли токена в КОНКРЕТНОМ протоколе.
 *
 * Глобальный `isProtocolToken(symbol)` помечает GLV / aTokens / stETH
 * как «protocol-token» вне зависимости от контекста. Это ломает
 * `classifyLending` для протоколов, которые принимают чужие
 * protocol-tokens как collateral (Morpho Blue: GLV → collateral, USDC → borrow).
 *
 * Эта функция возвращает роль токена **в контексте конкретного протокола**:
 *
 *   - "receipt" — этот токен является receipt'ом ДАННОГО протокола
 *     (aUSDC в Aave, fVLT в Fluid, GM в GMX V2 и т.д.).
 *   - "underlying" — обычный asset, который пользователь вносит / получает
 *     (USDC, ETH, GLV в Morpho-контексте).
 *
 * Используется в classifyLending / classifyDex для корректной интерпретации
 * направлений (sentReceipt / recvReceipt), а не глобального isProtocolToken.
 *
 * **Иерархия источников детекции (приоритет сверху вниз):**
 *   1. Contract-address whitelist в `RECEIPT_CONTRACTS` — точно и без false-positives
 *   2. Symbol-pattern matching по семьям протоколов (текущее поведение)
 *   3. Default `false` — лучше промахнуться в "underlying" чем неверно
 *      классифицировать GLV-в-Morpho как receipt
 */

export type TokenRole = "receipt" | "underlying";

/**
 * **Whitelist контрактов receipt-токенов per протокол.** Точное соответствие
 * по адресу — единственный надёжный способ определить роль (symbol-паттерны
 * могут давать false positives типа `cETH` ≠ Compound's cETH на разных
 * сетях). Расширяется по мере добавления новых протоколов.
 *
 * Формат: `protocolId → Set<contractAddress (lowercase, без chain-prefix)>`.
 *
 * Если контракт здесь — это **гарантированно** receipt этого протокола.
 * Если нет — fallback на symbol pattern matching.
 */
const RECEIPT_CONTRACTS: Record<string, Set<string>> = {
  // GMX V2 Arbitrum: GM markets + GLV vaults.
  arb_gmx2: new Set([
    // GM markets (markets DataStore deployed contracts)
    "0x70d95587d40a2caf56bd97485ab3eec10bee6336", // GM[ETH/USD] WETH-USDC
    "0x47c031236e19d024b42f8ae6780e44a573170703", // GM[BTC/USD] WBTC-USDC
    "0x77b2ec357b56c7d05a87971db0188dbb0c7836a5", // GM[ETH/USD] alt
    "0x450bb6774dd8a756274e0ab4107953259d2ac541", // GM legacy
    // GLV vaults
    "0x528a5bac7e746c9a509a1aa3cd71b8b07aad8b0d", // GLV [WETH-USDC]
  ]),
  // Aave V3 Arbitrum aTokens (variable debt and atokens)
  arb_aave3: new Set([
    "0xe50fa9b3c56ffb159cb0fca61f5c9d750e8128c8", // aArbWETH
    "0x078f358208685046a11c85e8ad32895ded33a249", // aArbUSDC
    "0x6ab707aca953edaefbc4fd23ba73294241490620", // aArbUSDT
    "0x191c10aa4af7c30e871e70c95db0e4eb77237530", // aArbWBTC
    "0xe1ee9a45f8a0c9d37e6c5dc12dafe7d0ce6c14a1", // variableDebtArbWETH
    "0xfccf3cabbe80101232d343252614b6a3ee816c09", // variableDebtArbUSDC
  ]),
  // Fluid Arbitrum: fVLT NFT contracts (per-vault).
  arb_fluid: new Set([
    "0xac63b519fefb44a0bff5fc2a6f8a4a5d3ebc7a5e", // POS-004 fVLT
    "0xf0ba982a3ac2d4f08b0e8ab8e96e8c8e8c8e8c8e", // POS-005 fVLT (placeholder)
  ]),
  // Morpho Blue — receipt-less, никаких contract addresses не whitelist'им.
  arb_morphoblue: new Set(),
  eth_morphoblue: new Set(),
};

/**
 * **Whitelist receipt-less протоколов.** Эти протоколы НЕ выдают receipt в
 * кошелёк — позиция живёт только во внутреннем state контракта. Для них:
 *   - findFirstOpen использует relax-mode
 *   - currentCostBasisForPosition суммирует out-side underlying'ов
 *
 * Расширяется по мере добавления новых протоколов в категорию.
 */
const RECEIPT_LESS_PROTOCOLS = new Set<string>([
  "morphoblue", // Morpho Blue (любая chain)
  "drift", // Drift Spot
  "adrena", // Adrena PnL pools
]);

/**
 * Registry hook: внешний модуль (защищён от circular import) может
 * зарегистрировать функцию для детекта receipt-less протоколов через
 * DefiLlama. Регистрируется в `main.tsx` или другом entry point
 * через `registerReceiptLessOracle()`.
 */
type ReceiptLessOracle = (
  protocolId: string,
  protocolName?: string,
) => boolean | null;
let receiptLessOracle: ReceiptLessOracle | null = null;

/** Зарегистрировать external oracle (DefiLlama-backed). */
export function registerReceiptLessOracle(fn: ReceiptLessOracle): void {
  receiptLessOracle = fn;
}

/**
 * Возвращает true если протокол не выдаёт receipt в кошелёк (Morpho Blue,
 * Drift Spot, Adrena и т.д.). Match по substring для chain-prefixed ID
 * (`arb_morphoblue` → matches "morphoblue").
 *
 * Приоритет:
 *   1. Hardcoded `RECEIPT_LESS_PROTOCOLS` whitelist (для известных)
 *   2. External oracle (DefiLlama) — авто-детект для НЕИЗВЕСТНЫХ
 *   3. Fallback `false` — пусть протокол ведёт себя как receipt-based
 */
export function isReceiptLessProtocol(
  protocolId: string | null | undefined,
  protocolName?: string,
): boolean {
  if (!protocolId) return false;
  const pid = protocolId.toLowerCase();
  for (const known of RECEIPT_LESS_PROTOCOLS) {
    if (pid.includes(known)) return true;
  }
  if (receiptLessOracle) {
    const ans = receiptLessOracle(protocolId, protocolName ?? "");
    if (ans !== null) return ans;
  }
  return false;
}

/** Strip chain prefix ("arb:0xABC..." → "0xabc..."). */
function normalizeContract(id: string | null | undefined): string {
  if (!id) return "";
  return id
    .replace(/^[a-z]{2,6}:/i, "")
    .replace(/:[a-z][a-z0-9_-]+$/i, "")
    .toLowerCase();
}

/**
 * Возвращает `true`, если `(symbol, tokenId)` — это known receipt-token
 * протокола `protocolId`. Для receipt-less протоколов (Morpho Blue,
 * Drift Spot, …) возвращает `false` для любого token'а — у них нет
 * receipt'а в кошельке.
 *
 * Приоритет:
 *   1. Contract whitelist (RECEIPT_CONTRACTS) — точное соответствие
 *   2. Symbol-pattern matching per protocol family — fallback
 *   3. Default false для незнакомых протоколов
 */
export function isReceiptOfProtocol(
  symbol: string,
  protocolId: string,
  tokenId?: string | null,
): boolean {
  if (!symbol || !protocolId) return false;
  const pid = protocolId.toLowerCase();

  // ПРИОРИТЕТ 1: contract address whitelist.
  if (tokenId) {
    const addr = normalizeContract(tokenId);
    const whitelist = RECEIPT_CONTRACTS[pid];
    if (whitelist && whitelist.has(addr)) return true;
  }

  const sym = symbol.toUpperCase();

  // Morpho Blue: receipt-less протокол. Position state живёт ВНУТРИ контракта,
  // в кошельке пользователя receipt'а нет. Любой token в movement = collateral
  // (sends) или borrow proceeds (receives).
  if (pid.includes("morpho")) return false;

  // Aave: aTokens (aUSDC, aWETH, …) + variableDebt / stableDebt.
  // DeBank symbol может быть "aArbUSDC" / "aEthUSDC" / "aUSDC" — все начинаются с 'a' + capital.
  if (pid.includes("aave")) {
    if (/^A[A-Z]/.test(sym)) return true;
    if (sym.startsWith("VARIABLEDEBT") || sym.startsWith("STABLEDEBT")) return true;
    return false;
  }

  // Compound v2 / v3: cTokens (cUSDC, cETH).
  if (pid.includes("compound")) {
    if (/^C[A-Z]/.test(sym)) return true;
    return false;
  }

  // Fluid: fVLT NFT-receipt per position.
  if (pid.includes("fluid")) {
    if (sym === "FVLT" || sym.startsWith("FVLT")) return true;
    return false;
  }

  // GMX V2 / GMSOL: GM / GLV / GLP markets.
  if (pid.includes("gmx") || pid.includes("gmsol")) {
    if (/^GM($|[\s:[(])/.test(sym)) return true;
    if (/^GLV($|[\s:[(])/.test(sym)) return true;
    if (sym === "GLP") return true;
    return false;
  }

  // Flash Trade: FLP.
  if (pid.includes("flash")) {
    if (/^FLP($|[\s:[])/.test(sym)) return true;
    return false;
  }

  // Lido / Rocket Pool / EigenLayer и пр. liquid staking: stETH/wstETH/rETH/eETH/weETH.
  if (
    pid.includes("lido") ||
    pid.includes("rocket-pool") ||
    pid.includes("eigenlayer") ||
    pid.includes("etherfi") ||
    pid.includes("renzo") ||
    pid.includes("kelp")
  ) {
    if (/^(W?STETH|RETH|SFRXETH|EETH|WEETH|EZETH|RSETH|SWETH|OSETH)$/.test(sym))
      return true;
    return false;
  }

  // LFJ (Trader Joe) Liquidity Book — LBT receipt per bin.
  if (pid.includes("traderjoe") || pid.includes("lfj")) {
    if (sym === "LBT" || sym.startsWith("LBT")) return true;
    return false;
  }

  // Pendle V2: PT (Principal Token) / YT (Yield Token) — entering a Pendle
  // position is via PT/YT acquisition. Они обычно покупаются через AMM
  // swap, но семантически это вход в yield-позицию → receipt-роль.
  if (pid.includes("pendle")) {
    if (/^(PT|YT)-/.test(sym)) return true;
    return false;
  }

  // Aerodrome / Velodrome — concentrated liquidity slipstream pools.
  if (pid.includes("aerodrome") || pid.includes("velodrome")) {
    // Aerodrome V3 NFT-position не имеет уникального symbol — DeBank часто
    // отдаёт пустой symbol для NFT. Полагаемся на isProtocolToken флаг.
    if (/^AERO-/.test(sym) || /^VELO-/.test(sym)) return true;
    return false;
  }

  // Uniswap / V3-style LP: NFT/LP-receipt в movement редко имеет symbol —
  // обычно UNI-V2 / UNI-V3 / SLP / CRV-LP / BPT / CAKE-LP.
  if (
    pid.includes("uniswap") ||
    pid.includes("sushiswap") ||
    pid.includes("pancakeswap") ||
    pid.includes("curve") ||
    pid.includes("balancer")
  ) {
    if (
      /^UNI-V/.test(sym) ||
      /^SLP$/.test(sym) ||
      /^CRV-?LP/.test(sym) ||
      /^BPT/.test(sym) ||
      /^CAKE-LP/.test(sym)
    )
      return true;
    return false;
  }

  // Default: НЕ receipt. Нет ложно-положительных срабатываний для незнакомых
  // протоколов — лучше промахнуться в сторону "underlying" чем неверно
  // классифицировать GLV-в-Morpho как receipt.
  return false;
}

/**
 * Различает **debt-receipt** (отрицательная позиция: variableDebt / stableDebt
 * у Aave) от обычного supply-receipt (aToken). Critical для классификатора:
 *   - получили debt-receipt → это `borrow` (НЕ supply)
 *   - отдали debt-receipt → это `repay` (НЕ withdraw)
 *
 * Без этого классификатор путает `pool.borrow()` (где user получает asset +
 * variableDebt receipt) с `pool.supply()` (где user получает aToken receipt).
 */
export function isDebtReceiptOfProtocol(
  symbol: string,
  protocolId: string,
): boolean {
  if (!symbol || !protocolId) return false;
  const sym = symbol.toUpperCase();
  const pid = protocolId.toLowerCase();
  // Aave V3: variableDebtXxx, stableDebtXxx (case-insensitive).
  if (pid.includes("aave")) {
    if (sym.startsWith("VARIABLEDEBT") || sym.startsWith("STABLEDEBT")) {
      return true;
    }
  }
  // Compound v3: borrowable cToken? Compound v3 USDC market — нет debt-receipt.
  // Compound v2 — нет debt-receipt.
  return false;
}

/**
 * Helper: возвращает массив movement'ов, отфильтрованных по роли в данном
 * протоколе. Используется в classifyLending / classifyDex / lp_add reducer.
 */
export function classifyTokenRole(
  movement: { symbol: string; isProtocolToken: boolean; tokenId?: string },
  protocolId: string | null | undefined,
): TokenRole {
  if (!protocolId) return movement.isProtocolToken ? "receipt" : "underlying";
  return isReceiptOfProtocol(movement.symbol, protocolId, movement.tokenId)
    ? "receipt"
    : "underlying";
}
