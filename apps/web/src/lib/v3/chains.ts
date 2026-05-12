/**
 * Конфиги V3 деплоя по сетям и протоколам.
 *
 * Поддерживаются Uniswap V3, PancakeSwap V3 и SushiSwap V3 — все три
 * используют идентичный ABI (NPM.positions, Pool.slot0, Factory.getPool),
 * различаются только адресами контрактов.
 *
 * Адреса проверены по официальной документации:
 *   • docs.uniswap.org/contracts/v3/reference/deployments
 *   • docs.pancakeswap.finance/contracts/v3
 *   • docs.sushi.com/docs/Products/V3%20AMM/Periphery
 */

import type { Chain } from "viem";
import {
  arbitrum,
  avalanche,
  base,
  bsc,
  mainnet,
  optimism,
  polygon,
} from "viem/chains";

export interface V3Deployment {
  /** Уникальный id (uniswap-v3, pancake-v3, sushi-v3). */
  id: string;
  /** Метка для UI. */
  label: string;
  /** Регекс для матча `LiveProtocolPosition.protocolName`. */
  protocolMatch: RegExp;
  /** DeBank chain code. */
  chainCode: string;
  /** viem Chain object. */
  chain: Chain;
  /** Alchemy network subdomain. */
  alchemySubdomain: string;
  /** NonfungiblePositionManager. */
  npm: `0x${string}`;
  /** Factory (читаем getPool). */
  factory: `0x${string}`;
}

/* =============================== Uniswap V3 =============================== */

const UNI_V3_NPM = "0xC36442b4a4522E871399CD717aBDD847Ab11FE88" as const;
const UNI_V3_FACTORY = "0x1F98431c8aD98523631AE4a59f267346ea31F984" as const;

const UNISWAP_V3: V3Deployment[] = [
  {
    id: "uniswap-v3-eth",
    label: "Uniswap V3",
    protocolMatch: /uniswap\s*v3/i,
    chainCode: "eth",
    chain: mainnet,
    alchemySubdomain: "eth-mainnet",
    npm: UNI_V3_NPM,
    factory: UNI_V3_FACTORY,
  },
  {
    id: "uniswap-v3-arb",
    label: "Uniswap V3",
    protocolMatch: /uniswap\s*v3/i,
    chainCode: "arb",
    chain: arbitrum,
    alchemySubdomain: "arb-mainnet",
    npm: UNI_V3_NPM,
    factory: UNI_V3_FACTORY,
  },
  {
    id: "uniswap-v3-op",
    label: "Uniswap V3",
    protocolMatch: /uniswap\s*v3/i,
    chainCode: "op",
    chain: optimism,
    alchemySubdomain: "opt-mainnet",
    npm: UNI_V3_NPM,
    factory: UNI_V3_FACTORY,
  },
  {
    id: "uniswap-v3-matic",
    label: "Uniswap V3",
    protocolMatch: /uniswap\s*v3/i,
    chainCode: "matic",
    chain: polygon,
    alchemySubdomain: "polygon-mainnet",
    npm: UNI_V3_NPM,
    factory: UNI_V3_FACTORY,
  },
  {
    id: "uniswap-v3-base",
    label: "Uniswap V3",
    protocolMatch: /uniswap\s*v3/i,
    chainCode: "base",
    chain: base,
    alchemySubdomain: "base-mainnet",
    npm: "0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1",
    factory: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD",
  },
  {
    id: "uniswap-v3-bsc",
    label: "Uniswap V3",
    protocolMatch: /uniswap\s*v3/i,
    chainCode: "bsc",
    chain: bsc,
    alchemySubdomain: "bnb-mainnet",
    npm: "0x7b8A01B39D58278b5DE7e48c8449c9f4F5170613",
    factory: "0xdB1d10011AD0Ff90774D0C6Bb92e5C5c8b4461F7",
  },
];

/* ============================= PancakeSwap V3 ============================= */

// Pancake V3 использует ОДИНАКОВЫЕ адреса NPM/Factory на всех сетях.
const PANCAKE_V3_NPM = "0x46A15B0b27311cedF172AB29E4f4766fbE7F4364" as const;
const PANCAKE_V3_FACTORY = "0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865" as const;

const PANCAKE_V3: V3Deployment[] = [
  {
    id: "pancake-v3-bsc",
    label: "PancakeSwap V3",
    protocolMatch: /pancake(swap)?\s*v3/i,
    chainCode: "bsc",
    chain: bsc,
    alchemySubdomain: "bnb-mainnet",
    npm: PANCAKE_V3_NPM,
    factory: PANCAKE_V3_FACTORY,
  },
  {
    id: "pancake-v3-eth",
    label: "PancakeSwap V3",
    protocolMatch: /pancake(swap)?\s*v3/i,
    chainCode: "eth",
    chain: mainnet,
    alchemySubdomain: "eth-mainnet",
    npm: PANCAKE_V3_NPM,
    factory: PANCAKE_V3_FACTORY,
  },
  {
    id: "pancake-v3-arb",
    label: "PancakeSwap V3",
    protocolMatch: /pancake(swap)?\s*v3/i,
    chainCode: "arb",
    chain: arbitrum,
    alchemySubdomain: "arb-mainnet",
    npm: PANCAKE_V3_NPM,
    factory: PANCAKE_V3_FACTORY,
  },
  {
    id: "pancake-v3-base",
    label: "PancakeSwap V3",
    protocolMatch: /pancake(swap)?\s*v3/i,
    chainCode: "base",
    chain: base,
    alchemySubdomain: "base-mainnet",
    npm: PANCAKE_V3_NPM,
    factory: PANCAKE_V3_FACTORY,
  },
];

/* ============================== SushiSwap V3 ============================== */

const SUSHI_V3: V3Deployment[] = [
  {
    id: "sushi-v3-eth",
    label: "SushiSwap V3",
    protocolMatch: /sushi(swap)?\s*v3/i,
    chainCode: "eth",
    chain: mainnet,
    alchemySubdomain: "eth-mainnet",
    npm: "0x2214A42d8e2A1d20635c2cb0664422c528B6A432",
    factory: "0xbACEB8eC6b9355Dfc0269C18bac9d6E2Bdc29C4F",
  },
  {
    id: "sushi-v3-arb",
    label: "SushiSwap V3",
    protocolMatch: /sushi(swap)?\s*v3/i,
    chainCode: "arb",
    chain: arbitrum,
    alchemySubdomain: "arb-mainnet",
    npm: "0xb7402ee99F0A008e461098AC3A27F4957Df89a40",
    factory: "0x1af415a1EbA07a4986a52B6f2e7dE7003D82231e",
  },
  {
    id: "sushi-v3-op",
    label: "SushiSwap V3",
    protocolMatch: /sushi(swap)?\s*v3/i,
    chainCode: "op",
    chain: optimism,
    alchemySubdomain: "opt-mainnet",
    npm: "0x88FB8d9bdAa8eAcdA4F3d3e6f206E2C99e5fc14b",
    factory: "0x9c6522117e2ed1fE5bdb72bb0eD5E3f2bdE7DBe0",
  },
  {
    id: "sushi-v3-matic",
    label: "SushiSwap V3",
    protocolMatch: /sushi(swap)?\s*v3/i,
    chainCode: "matic",
    chain: polygon,
    alchemySubdomain: "polygon-mainnet",
    npm: "0xb7402ee99F0A008e461098AC3A27F4957Df89a40",
    factory: "0x917933899c6a5F8E37F31E19f92CdBFF7e8FF0e2",
  },
  {
    id: "sushi-v3-base",
    label: "SushiSwap V3",
    protocolMatch: /sushi(swap)?\s*v3/i,
    chainCode: "base",
    chain: base,
    alchemySubdomain: "base-mainnet",
    npm: "0x80C7DD17B01855a6D2347444a0FCC36136a314de",
    factory: "0xc35DADB65012eC5796536bD9864eD8773aBc74C4",
  },
  {
    id: "sushi-v3-bsc",
    label: "SushiSwap V3",
    protocolMatch: /sushi(swap)?\s*v3/i,
    chainCode: "bsc",
    chain: bsc,
    alchemySubdomain: "bnb-mainnet",
    npm: "0xF0cBce1942A68BEB3d1b73F0dd86C8DCc363eF49",
    factory: "0x126555dd55a39328F69400d6aE4F782Bd4C34ABb",
  },
  {
    id: "sushi-v3-avax",
    label: "SushiSwap V3",
    protocolMatch: /sushi(swap)?\s*v3/i,
    chainCode: "avax",
    chain: avalanche,
    alchemySubdomain: "avax-mainnet",
    npm: "0x18cb7889a9417e2ba305b9442226Ee0e2eb83AAC",
    factory: "0x3e603C14aF37EBdaD31709C4f848Fc6aD5BEc715",
  },
];

export const V3_DEPLOYMENTS: V3Deployment[] = [
  ...UNISWAP_V3,
  ...PANCAKE_V3,
  ...SUSHI_V3,
];

/**
 * Phase S3.5: returns the backend upstream-proxy URL for the given
 * Alchemy chain. The admin's `ALCHEMY_API_KEY` is injected server-side
 * by the proxy — frontend `apiKey` is ignored.
 *
 * Authentication: callers using viem's `http()` transport must pass
 * `fetchOptions: { credentials: "include" }` so the browser attaches
 * the `cap_access` cookie (HttpOnly, scoped to `/api/v1/upstream`). The
 * proxy's `requireAuth` accepts the cookie as a fallback when the
 * Bearer header is absent (viem can't inject a refreshable Bearer
 * dynamically). See `auth.cookies.ts` / `plugins/auth.ts`.
 */
export function alchemyRpcUrl(dep: V3Deployment, apiKey: string): string {
  void apiKey;
  return `/api/v1/upstream/alchemy/${dep.alchemySubdomain}`;
}

/** Найти все деплойменты, подходящие под (chainCode, protocolName). */
export function findV3Deployments(
  chainCode: string,
  protocolName: string,
): V3Deployment[] {
  return V3_DEPLOYMENTS.filter(
    (d) => d.chainCode === chainCode && d.protocolMatch.test(protocolName),
  );
}
