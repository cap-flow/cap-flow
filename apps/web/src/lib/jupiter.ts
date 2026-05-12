/**
 * Минимальный клиент Jupiter Price API + Jupiter Portfolio API.
 *
 * Price API — публичный, без auth, через `/jupiter` → https://api.jup.ag.
 * Portfolio API — DeFi-позиции (Jupiter-родные платформы: JLP, perp, DCA,
 * limit orders, JUP staking; внешние протоколы как Flash Trade пока в beta
 * не подключены). Требует x-api-key.
 *
 * Формат ответа Portfolio API наследует Sonar (бывший portfolio-api.sonar.watch
 * до того как Jupiter купил Sonar и закрыл их публичный API).
 */

const BASE = "/jupiter";
const PORTFOLIO_BASE = "/jup-portfolio";

/* -------------------------------------------------------------------------- */
/*  Jupiter Portfolio response types (бывший SonarResponse)                    */
/* -------------------------------------------------------------------------- */

export type JupiterPortfolioElementType =
  | "multiple"
  | "borrowlend"
  | "liquidity"
  | "leverage"
  | "single"
  | string;

export interface JupiterPortfolioTokenAsset {
  type?: string;
  networkId?: string;
  value?: number;
  data?: { address?: string; amount?: number; price?: number };
  name?: string;
  imageUri?: string;
  attributes?: Record<string, unknown>;
}

export interface JupiterPortfolioElement {
  networkId: string;
  platformId: string;
  type: JupiterPortfolioElementType;
  label: string;
  name?: string;
  value: number;
  data: {
    assets?: JupiterPortfolioTokenAsset[];
    suppliedAssets?: JupiterPortfolioTokenAsset[];
    borrowedAssets?: JupiterPortfolioTokenAsset[];
    rewardAssets?: JupiterPortfolioTokenAsset[];
    suppliedValue?: number;
    borrowedValue?: number;
    healthRatio?: number;
    [key: string]: unknown;
  };
  tags?: string[];
}

export interface JupiterPortfolioResponse {
  date: number;
  owner: string;
  elements: JupiterPortfolioElement[];
  fetcherReports?: { id: string; status: string; duration?: number }[];
  duration?: number;
  tokenInfo?: Record<string, unknown>;
}

export interface JupiterPriceItem {
  id: string;       // mint
  type?: string;    // "derivedPrice" | "buyLiquiditySources"
  price: string;    // "1.0001" — десятичная строка
}

export interface JupiterPriceResponse {
  data: Record<string, JupiterPriceItem | null>;
  timeTaken?: number;
}

/**
 * Пакетно получает цены до 100 mint'ов за раз.
 * Возвращает Map<mint, price>.
 */
export async function fetchJupiterPrices(
  mints: string[],
  signal?: AbortSignal,
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (mints.length === 0) return result;

  // Уникализируем и режем на батчи по 100.
  const unique = Array.from(new Set(mints));
  const batches: string[][] = [];
  for (let i = 0; i < unique.length; i += 100) {
    batches.push(unique.slice(i, i + 100));
  }

  for (const batch of batches) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    try {
      const url = new URL(BASE + "/price/v2", window.location.origin);
      url.searchParams.set("ids", batch.join(","));
      const init: RequestInit = { method: "GET", headers: { Accept: "application/json" } };
      if (signal) init.signal = signal;
      const res = await fetch(url.toString(), init);
      if (!res.ok) continue;
      const json = (await res.json()) as JupiterPriceResponse;
      for (const [mint, item] of Object.entries(json.data ?? {})) {
        if (!item) continue;
        const p = Number(item.price);
        if (Number.isFinite(p) && p > 0) result.set(mint, p);
      }
    } catch {
      // молча игнорируем; ценовая инфа — best-effort.
    }
  }
  return result;
}

/**
 * Получает DeFi-позиции для Solana-кошелька через Jupiter Portfolio API.
 *
 * Эндпоинт: GET /portfolio/v1/positions/{address}
 * Auth: x-api-key header.
 *
 * В текущей бете покрывает только Jupiter-родные платформы (JLP, perp,
 * DCA, limit orders, JUP staking). Внешние Solana-протоколы (Flash Trade,
 * Drift, Kamino, Marginfi и т.п.) пока не подключены — для них используем
 * inferred-позиции из истории ops.
 */
export async function fetchJupiterPortfolio(
  args: { address: string; apiKey: string },
  signal?: AbortSignal,
): Promise<JupiterPortfolioResponse | null> {
  if (!args.apiKey) return null;
  const url = new URL(
    `${PORTFOLIO_BASE}/v1/positions/${args.address}`,
    window.location.origin,
  );
  const init: RequestInit = {
    method: "GET",
    headers: {
      Accept: "application/json",
      "x-api-key": args.apiKey,
    },
  };
  if (signal) init.signal = signal;
  const res = await fetch(url.toString(), init);
  if (!res.ok) {
    throw new Error(`Jupiter Portfolio HTTP ${res.status}`);
  }
  return (await res.json()) as JupiterPortfolioResponse;
}
