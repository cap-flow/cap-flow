/**
 * Контекстная роль токена в КОНКРЕТНОМ протоколе — server port of
 * `apps/web/src/lib/portfolio/token_roles.ts` (P5.2).
 *
 * Глобальный `isProtocolToken(symbol)` помечает GLV / aTokens / stETH как
 * «protocol-token» вне зависимости от контекста. Это ломает classifier для
 * протоколов, которые принимают чужие protocol-tokens как collateral
 * (Morpho Blue: GLV → collateral, USDC → borrow). Эта функция возвращает
 * роль токена **в контексте конкретного протокола**:
 *
 *   - "receipt" — токен является receipt'ом ДАННОГО протокола
 *     (aUSDC в Aave, fVLT в Fluid, GM в GMX V2)
 *   - "underlying" — обычный asset, который пользователь вносит / получает
 *
 * Иерархия источников детекции (приоритет сверху вниз):
 *   1. Contract-address whitelist в `RECEIPT_CONTRACTS` — точно, без FP
 *   2. Symbol-pattern matching по семьям протоколов
 *   3. Default `false` — лучше промахнуться в "underlying"
 */

export type TokenRole = "receipt" | "underlying";

const RECEIPT_CONTRACTS: Record<string, Set<string>> = {
  arb_gmx2: new Set([
    "0x70d95587d40a2caf56bd97485ab3eec10bee6336",
    "0x47c031236e19d024b42f8ae6780e44a573170703",
    "0x77b2ec357b56c7d05a87971db0188dbb0c7836a5",
    "0x450bb6774dd8a756274e0ab4107953259d2ac541",
    "0x528a5bac7e746c9a509a1aa3cd71b8b07aad8b0d",
  ]),
  arb_aave3: new Set([
    "0xe50fa9b3c56ffb159cb0fca61f5c9d750e8128c8",
    "0x078f358208685046a11c85e8ad32895ded33a249",
    "0x6ab707aca953edaefbc4fd23ba73294241490620",
    "0x191c10aa4af7c30e871e70c95db0e4eb77237530",
    "0xe1ee9a45f8a0c9d37e6c5dc12dafe7d0ce6c14a1",
    "0xfccf3cabbe80101232d343252614b6a3ee816c09",
  ]),
  arb_fluid: new Set([
    "0xac63b519fefb44a0bff5fc2a6f8a4a5d3ebc7a5e",
    "0xf0ba982a3ac2d4f08b0e8ab8e96e8c8e8c8e8c8e",
  ]),
  arb_morphoblue: new Set(),
  eth_morphoblue: new Set(),
};

const RECEIPT_LESS_PROTOCOLS = new Set<string>([
  "morphoblue",
  "drift",
  "adrena",
]);

type ReceiptLessOracle = (
  protocolId: string,
  protocolName?: string
) => boolean | null;
let receiptLessOracle: ReceiptLessOracle | null = null;

export function registerReceiptLessOracle(fn: ReceiptLessOracle): void {
  receiptLessOracle = fn;
}

export function isReceiptLessProtocol(
  protocolId: string | null | undefined,
  protocolName?: string
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

function normalizeContract(id: string | null | undefined): string {
  if (!id) return "";
  return id
    .replace(/^[a-z]{2,6}:/i, "")
    .replace(/:[a-z][a-z0-9_-]+$/i, "")
    .toLowerCase();
}

export function isReceiptOfProtocol(
  symbol: string,
  protocolId: string,
  tokenId?: string | null
): boolean {
  if (!symbol || !protocolId) return false;
  const pid = protocolId.toLowerCase();

  if (tokenId) {
    const addr = normalizeContract(tokenId);
    const whitelist = RECEIPT_CONTRACTS[pid];
    if (whitelist && whitelist.has(addr)) return true;
  }

  const sym = symbol.toUpperCase();

  if (pid.includes("morpho")) return false;

  if (pid.includes("aave")) {
    // Aave V3 receipt naming: `a<ChainPrefix><Symbol>` (aArbUSDC,
    // aEthWETH, aArbARB, …). The convention is STRICT lowercase 'a'
    // followed by an uppercase chain-letter. We must check the original
    // `symbol` (not the upper-cased `sym`), otherwise plain assets like
    // ARB / AAVE / AERO / AUSD false-positive against /^A[A-Z]/ —
    // those start with uppercase A followed by uppercase R/A/E/U.
    //
    // Before the fix: bob's aArbARB → ARB withdraw was classified as
    // lend_supply because BOTH `aArbARB` AND `ARB` matched the
    // upper-cased regex → sentSupply && recvSupply → fallback branch.
    if (/^a[A-Z][a-zA-Z]/.test(symbol)) return true;
    if (sym.startsWith("VARIABLEDEBT") || sym.startsWith("STABLEDEBT"))
      return true;
    return false;
  }

  if (pid.includes("compound")) {
    // Same convention as Aave: cToken names are `c<Symbol>` strictly
    // lowercase 'c' (cUSDC, cDAI, cETH). Use original `symbol` to avoid
    // false-positives on plain assets starting with uppercase 'C'.
    if (/^c[A-Z][a-zA-Z]/.test(symbol)) return true;
    return false;
  }

  if (pid.includes("fluid")) {
    if (sym === "FVLT" || sym.startsWith("FVLT")) return true;
    return false;
  }

  if (pid.includes("gmx") || pid.includes("gmsol")) {
    if (/^GM($|[\s:[(])/.test(sym)) return true;
    if (/^GLV($|[\s:[(])/.test(sym)) return true;
    if (sym === "GLP") return true;
    return false;
  }

  if (pid.includes("flash")) {
    if (/^FLP($|[\s:[])/.test(sym)) return true;
    return false;
  }

  if (
    pid.includes("lido") ||
    pid.includes("rocket-pool") ||
    pid.includes("eigenlayer") ||
    pid.includes("etherfi") ||
    pid.includes("renzo") ||
    pid.includes("kelp")
  ) {
    if (
      /^(W?STETH|RETH|SFRXETH|EETH|WEETH|EZETH|RSETH|SWETH|OSETH)$/.test(sym)
    )
      return true;
    return false;
  }

  if (pid.includes("traderjoe") || pid.includes("lfj")) {
    if (sym === "LBT" || sym.startsWith("LBT")) return true;
    return false;
  }

  if (pid.includes("pendle")) {
    if (/^(PT|YT)-/.test(sym)) return true;
    return false;
  }

  if (pid.includes("aerodrome") || pid.includes("velodrome")) {
    if (/^AERO-/.test(sym) || /^VELO-/.test(sym)) return true;
    return false;
  }

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

  return false;
}

export function isDebtReceiptOfProtocol(
  symbol: string,
  protocolId: string
): boolean {
  if (!symbol || !protocolId) return false;
  const sym = symbol.toUpperCase();
  const pid = protocolId.toLowerCase();
  if (pid.includes("aave")) {
    if (sym.startsWith("VARIABLEDEBT") || sym.startsWith("STABLEDEBT")) {
      return true;
    }
  }
  return false;
}

export function classifyTokenRole(
  movement: { symbol: string; isProtocolToken: boolean; tokenId?: string },
  protocolId: string | null | undefined
): TokenRole {
  if (!protocolId) return movement.isProtocolToken ? "receipt" : "underlying";
  return isReceiptOfProtocol(movement.symbol, protocolId, movement.tokenId)
    ? "receipt"
    : "underlying";
}
