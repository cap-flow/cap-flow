/**
 * Vybe Network — unified Solana DeFi positions API.
 * https://docs.vybenetwork.com/docs/positions-yields-staking
 *
 * Покрывает 50+ протоколов на Solana, в т.ч. Flash Trade, Drift, Kamino,
 * Marginfi, Solend, Marinade, Jito и др.
 *
 * Free-tier: 4 RPS, 12k запросов/мес. Ключ — X-API-Key header.
 * Регистрация: https://vybe.fyi/api-pricing
 */

const BASE = "/vybe";

/* ------------------------------ типы -------------------------------------- */

export interface VybeTokenLine {
  /** Символ токена (USDC / SOL / mSOL / kSOL / …). */
  symbol?: string;
  mint?: string;
  amount?: number;
  /** USD-стоимость элементарной единицы / общая. Vybe использует разные имена. */
  valueUsd?: number;
  amountUsd?: number;
  /** Направление: для lending — 'supply' | 'borrow'; для farming — 'reward'. */
  type?: "supply" | "borrow" | "reward" | "deposit" | "withdraw" | string;
  /** Иногда используется доп. префикс ("Supplied" / "Borrowed"). */
  side?: string;
}

export interface VybePosition {
  /** Имя протокола: "Flash Trade", "Drift", "Kamino", "Marginfi", … */
  protocol?: string;
  protocolName?: string;
  protocolId?: string;
  protocolLogo?: string;
  /** Тип позиции: "liquidity_pool" | "lending" | "staking" | "farming" | … */
  type?: string;
  category?: string;
  /** Человекочитаемое название позиции / пула. */
  poolName?: string;
  name?: string;
  /** Текущая USD-стоимость (нетто). */
  valueUsd?: number;
  netValueUsd?: number;
  /** Активы / долги отдельно. */
  assetUsd?: number;
  debtUsd?: number;
  /** Список токенов в позиции (универсальный). */
  tokens?: VybeTokenLine[];
  /** Раздельные supply/borrow листы — встречается в lending. */
  supplied?: VybeTokenLine[];
  borrowed?: VybeTokenLine[];
  rewards?: VybeTokenLine[] | { pending?: VybeTokenLine[] };
  /** APR/APY. */
  apr?: number;
  apy?: number;
  /** Здоровье (для lending/perp). */
  healthRatio?: number;
  healthRate?: number;
  /** Для perps. */
  leverage?: number;
  pnl?: number;
  pnlUsd?: number;
  direction?: "long" | "short";
  /** Произвольное мета. */
  metadata?: Record<string, unknown>;
}

export interface VybeDefiPositionsResponse {
  ownerAddress: string;
  totalDefiValueUsd: number;
  positions: VybePosition[];
}

/* ----------------------------- клиент ------------------------------------- */

export class VybeAuthError extends Error {
  constructor() {
    super("Vybe Network: invalid or missing X-API-Key");
    this.name = "VybeAuthError";
  }
}

export async function fetchVybeDefiPositions(
  args: { address: string; apiKey: string },
  signal?: AbortSignal,
): Promise<VybeDefiPositionsResponse> {
  if (!args.apiKey) throw new VybeAuthError();

  const url = new URL(
    `${BASE}/wallets/${args.address}/defi-positions`,
    window.location.origin,
  );

  const init: RequestInit = {
    method: "GET",
    headers: {
      Accept: "application/json",
      "X-API-Key": args.apiKey,
    },
  };
  if (signal) init.signal = signal;

  const res = await fetch(url.toString(), init);
  if (res.status === 401 || res.status === 403) throw new VybeAuthError();
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Vybe ${res.status}: ${body || res.statusText}`);
  }
  return (await res.json()) as VybeDefiPositionsResponse;
}
