/**
 * Универсальный registry receipt-token адресов для lending протоколов.
 *
 * Используется для on-chain audit'а supply yield (см. `useLendingAudit`):
 * зная receipt-token address (aToken/spToken/cToken/...), фетчим все его
 * Transfer events (from=0x0 mint, to=0x0 burn) для адреса юзера через
 * Etherscan tokentx → получаем authoritative net deposited, которое
 * заменяет ops-derived `depositAmountSum` если DeBank пропустил supply tx.
 *
 * **Архитектура pattern recognition:**
 * Для **Aave V2/V3 fork** протоколов (Aave V3, Spark, Radiant, Sonne, Seamless,
 * Granary, ZeroLend, Tenderize, …) механизм идентичен:
 *  - Receipt-token = aToken/spToken/rToken/...
 *  - balanceOf(user) растёт автоматически через rebase (liquidity index)
 *  - Mint event при supply: Transfer(from=0x0, to=user, value=amount)
 *  - Burn event при withdraw: Transfer(from=user, to=0x0, value=amount)
 *
 * Для **Compound V3 (Comet)**:
 *  - Single market contract per asset (cUSDCv3, cWETHv3)
 *  - balanceOf тоже растёт, mints/burns на этом же контракте
 *
 * Для **Compound V2 fork** (cToken, vToken, oToken):
 *  - cToken — shares, не 1:1 с underlying. Требует `exchangeRate()` для
 *    конвертации. **Сейчас не поддерживается** в audit'е, fallback на ops.
 *
 * Для **Fluid, Morpho Blue**:
 *  - Уникальная архитектура, требует отдельных resolver'ов. **TODO**.
 *
 * Ключ записи: `${protocolId}|${chain}|${underlyingAddress.toLowerCase()}`
 * Значение: receipt token address.
 *
 * Когда нужно добавить новый протокол:
 *   1. Если Aave-fork — добавить entries в STATIC_RECEIPT_REGISTRY ниже
 *   2. Если своя архитектура — добавить resolver в `resolveReceiptByProtocol`
 */

const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

/**
 * Static registry: топ-assets на топ-chains для Aave-fork протоколов.
 * Использовать как primary source; on-chain getReserveTokensAddresses
 * — fallback для exotic assets.
 */
const STATIC_RECEIPT_REGISTRY: Record<string, string> = {
  // ─────────────── Aave V3 — Ethereum mainnet ───────────────
  "aave3|eth|0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2": // WETH
    "0x4d5F47FA6A74757f35C14fD3a6Ef8E3C9BC514E8",
  "aave3|eth|0x2260fac5e5542a773aa44fbcfedf7c193bc2c599": // WBTC
    "0x5Ee5bf7ae06D1Be5997A1A72006FE6C607eC6DE8",
  "aave3|eth|0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": // USDC
    "0x98C23E9d8f34FEFb1B7BD6a91B7FF122F4e16F5c",
  "aave3|eth|0xdac17f958d2ee523a2206206994597c13d831ec7": // USDT
    "0x23878914EFE38d27C4D67Ab83ed1b93A74D4086a",
  "aave3|eth|0x6b175474e89094c44da98b954eedeac495271d0f": // DAI
    "0x018008bfb33d285247A21d44E50697654f754e63",
  "aave3|eth|0xae78736cd615f374d3085123a210448e74fc6393": // rETH
    "0xCc9EE9483f662091a1de4795249E24aC0aC2630f",
  "aave3|eth|0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0": // wstETH
    "0x0B925eD163218f6662a35e0f0371Ac234f9E9371",
  "aave3|eth|0x4c9edd5852cd905f086c759e8383e09bff1e68b3": // USDe
    "0x4F5923Fc5FD4a93352581b38B7cD26943012DECF",

  // ─────────────── Aave V3 — Arbitrum ───────────────
  "aave3|arb|0x82af49447d8a07e3bd95bd0d56f35241523fbab1": // WETH
    "0xe50fA9b3c56FfB159cB0FCA61F5c9D750e8128c8",
  "aave3|arb|0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f": // WBTC
    "0x078f358208685046a11C85e8ad32895DED33A249",
  "aave3|arb|0xaf88d065e77c8cc2239327c5edb3a432268e5831": // USDC
    "0x724dc807b04555b71ed48a6896b6F41593b8C637",
  "aave3|arb|0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9": // USDT
    "0x6ab707Aca953eDAeFBc4fD23bA73294241490620",
  "aave3|arb|0xff970a61a04b1ca14834a43f5de4533ebddb5cc8": // USDC.e
    "0x625E7708f30cA75bfd92586e17077590C60eb4cD",
  "aave3|arb|0x5979d7b546e38e414f7e9822514be443a4800529": // wstETH
    "0x513c7e3a9c69ca3e22550ef58ac1c0088e918fff",

  // ─────────────── Aave V3 — Optimism ───────────────
  "aave3|op|0x4200000000000000000000000000000000000006": // WETH
    "0xe50fA9b3c56FfB159cB0FCA61F5c9D750e8128c8",
  "aave3|op|0x68f180fcce6836688e9084f035309e29bf0a2095": // WBTC
    "0x078f358208685046a11C85e8ad32895DED33A249",
  "aave3|op|0x0b2c639c533813f4aa9d7837caf62653d097ff85": // USDC
    "0x38d693cE1dF5AaDF7bC62595A37D667aD57922e5",

  // ─────────────── Aave V3 — Base ───────────────
  "aave3|base|0x4200000000000000000000000000000000000006": // WETH
    "0xD4a0e0b9149BCee3C920d2E00b5dE09138fd8bb7",
  "aave3|base|0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": // USDC
    "0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB",

  // ─────────────── Spark Lend — Ethereum (Aave V3 fork) ───────────────
  "spark|eth|0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2": // WETH → spWETH
    "0x59cD1C87501baa753d0B5B5Ab5D8416A45cD71DB",
  "spark|eth|0x6b175474e89094c44da98b954eedeac495271d0f": // DAI → spDAI
    "0x4DEDf26112B3Ec8eC46e7E31EA5e123490B05B8B",
  "spark|eth|0x2260fac5e5542a773aa44fbcfedf7c193bc2c599": // WBTC → spWBTC
    "0x4197ba364AE6698015AE5c1468f54087602715b2",
  "spark|eth|0xae78736cd615f374d3085123a210448e74fc6393": // rETH → sprETH
    "0x9985dF20D7e9103ECBCeb16a84956434B6f06ae8",
  "spark|eth|0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0": // wstETH → spwstETH
    "0x12B54025C112Aa61fAce2CDB7118740875A566E9",

  // ─────────────── Compound V3 (Comet) ───────────────
  // Comet = single contract per market, sits as receipt for base asset.
  // balanceOf(user) — это сразу underlying-units (rebase в native).
  // Ethereum: cUSDCv3, cUSDTv3, cWETHv3
  "compoundv3|eth|0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": // cUSDCv3 (USDC market)
    "0xc3d688B66703497DAA19211EEdff47f25384cdc3",
  "compoundv3|eth|0xdac17f958d2ee523a2206206994597c13d831ec7": // cUSDTv3 (USDT market)
    "0x3Afdc9BCA9213A35503b077a6072F3D0d5AB0840",
  "compoundv3|eth|0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2": // cWETHv3 (WETH market)
    "0xA17581A9E3356d9A858b789D68B4d866e593aE94",
  // Arbitrum
  "compoundv3|arb|0xaf88d065e77c8cc2239327c5edb3a432268e5831": // cUSDCv3 ARB
    "0x9c4ec768c28520B50860ea7a15bd7213a9fF58bf",
  // Base
  "compoundv3|base|0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": // cUSDCv3 Base
    "0xb125E6687d4313864e53df431d5425969c15Eb2F",
};

/**
 * Известные protocolId regex patterns → нормализованный key для registry.
 * Используется чтобы DeBank protocolId формата `arb_aave_v3` / `aave_v3` /
 * `aave3` нормализовать к одному ключу `aave3` (или аналогично).
 */
function normalizeProtocolId(protocolId: string, protocolName: string): string | null {
  const lower = (protocolId + "|" + protocolName).toLowerCase();
  if (/aave\s*v?3|aave3/.test(lower)) return "aave3";
  if (/aave\s*v?2|aave2/.test(lower)) return "aave2"; // not yet supported
  if (/\bspark\b/.test(lower)) return "spark";
  if (/compound\s*v?3|comet|\bcompound3\b/.test(lower)) return "compoundv3";
  if (/\bradiant\b/.test(lower)) return "radiant"; // not yet supported
  if (/\bseamless\b/.test(lower)) return "seamless"; // not yet supported
  if (/\bfluid\b/.test(lower)) return "fluid"; // not yet supported
  return null;
}

/**
 * Резолв receipt token address для (protocolId, chain, underlying).
 *
 * Возвращает null если протокол не поддерживается или нет entry в static
 * registry. Caller должен gracefully fallback на ops-derived deposit sum.
 *
 * @param protocolId — DeBank protocolId (e.g. "aave3", "arb_aave3", "spark")
 * @param protocolName — DeBank protocolName (used для нормализации)
 * @param chain — DeBank chain code (e.g. "eth", "arb", "op", "base")
 * @param underlyingAddress — underlying asset address (lowercase ok)
 */
export function resolveReceiptAddress(
  protocolId: string,
  protocolName: string,
  chain: string,
  underlyingAddress: string,
): string | null {
  const normProtoId = normalizeProtocolId(protocolId, protocolName);
  if (!normProtoId) return null;
  const key = `${normProtoId}|${chain}|${underlyingAddress.toLowerCase()}`;
  const addr = STATIC_RECEIPT_REGISTRY[key];
  if (!addr) return null;
  if (addr === ZERO_ADDR) return null;
  return addr;
}

/**
 * Возвращает список поддерживаемых protocolId для diagnostic / coverage UI.
 */
export const SUPPORTED_LENDING_PROTOCOLS = [
  "aave3",
  "spark",
  "compoundv3",
] as const;

export type SupportedLendingProtocol =
  (typeof SUPPORTED_LENDING_PROTOCOLS)[number];

/**
 * Проверить поддержан ли protocol для on-chain audit'а.
 * Используется в diagnostics: если протокол НЕ supported, показываем
 * tooltip "audit not available для этого протокола, supply yield = ops-based".
 */
export function isLendingAuditSupported(
  protocolId: string,
  protocolName: string,
): boolean {
  const norm = normalizeProtocolId(protocolId, protocolName);
  if (!norm) return false;
  return (SUPPORTED_LENDING_PROTOCOLS as readonly string[]).includes(norm);
}
