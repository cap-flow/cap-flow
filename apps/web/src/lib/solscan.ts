/**
 * Solscan Pro API клиент.
 *
 * Используется как **обогащение** (не замена) Helius parsed history.
 * Helius даёт `tx.type` для базовых событий (TRANSFER, SWAP, STAKE,
 * DEPOSIT...) но для нестандартных DeFi-протоколов часто не определяет
 * тип. Solscan Pro `/account/defi/activities` возвращает parsed
 * activity_type + platform для **гораздо более широкого** круга
 * протоколов (Raydium, Orca, Marinade, Sanctum, Drift, Kamino, Meteora,
 * Jupiter Perps, Jito Restaking и т.д.).
 *
 * Auth: `token` header с API ключом (https://pro-api.solscan.io).
 * Free tier: 60 RPM, 1000 req/day.
 *
 * Документация: https://pro-api.solscan.io/pro-api-docs/v2.0
 */

const ENDPOINT = "https://pro-api.solscan.io/v2.0";

/**
 * Solscan менял формат auth header несколько раз. Пробуем по очереди:
 *   1. `token: <key>` — текущий v2 doc (январь 2026).
 *   2. `Authorization: Bearer <key>` — стандарт OAuth/REST.
 *   3. `Authorization: <key>` — fallback некоторых старых deployments.
 * Если все вернули 401 — ключ реально неверный.
 */
function buildAuthHeaders(apiKey: string): Array<Record<string, string>> {
  return [
    { token: apiKey },
    { Authorization: `Bearer ${apiKey}` },
    { Authorization: apiKey },
  ];
}
const CACHE_KEY = "capflow.solscan_defi";
const CACHE_VERSION = 1;
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 минут — DeFi активность может обновиться
const PAGE_SIZE = 100; // максимум для Pro

/** Activity types из Solscan API. */
export type SolscanActivityType =
  | "ACTIVITY_TOKEN_SWAP"
  | "ACTIVITY_AGG_TOKEN_SWAP"
  | "ACTIVITY_TOKEN_ADD_LIQ"
  | "ACTIVITY_TOKEN_REMOVE_LIQ"
  | "ACTIVITY_SPL_TOKEN_STAKE"
  | "ACTIVITY_SPL_TOKEN_UNSTAKE"
  | "ACTIVITY_TOKEN_DEPOSIT_VAULT"
  | "ACTIVITY_TOKEN_WITHDRAW_VAULT"
  | "ACTIVITY_LOAN"
  | "ACTIVITY_REPAY"
  | "ACTIVITY_REWARDS"
  | string; // на всякий — могут добавить новые

export interface SolscanDefiActivity {
  /** Tx signature — общий ключ с Helius. */
  signature: string;
  /** Unix seconds. */
  blockTime: number;
  activityType: SolscanActivityType;
  /** Имя протокола: "Raydium V2", "Marinade", "Drift Protocol" и т.д. */
  platform?: string;
  /** Адрес программы / контракта. */
  programId?: string;
  /** Сводка движений токенов в этой activity. */
  tokens?: {
    address: string;
    decimals: number;
    amount: number;
  }[];
  /** Адрес кошелька (для каких операций). */
  fromAddress?: string;
  toAddress?: string;
}

interface CacheEntry {
  data: SolscanDefiActivity[];
  fetchedAt: number;
  /** Если запрос делался incremental — храним самую свежую signature. */
  latestSignature?: string;
}

interface CacheShape {
  v: number;
  byAddress: Record<string, CacheEntry>;
}

interface RawActivity {
  block_id: number;
  block_time: number;
  trans_id: string; // signature
  activity_type: string;
  from_address?: string;
  to_address?: string;
  sources?: string[];
  platform?: string[];
  routers?: { token1?: string; token2?: string }[];
  amount_info?: {
    token1?: string;
    token1_decimals?: number;
    amount1?: string;
    token2?: string;
    token2_decimals?: number;
    amount2?: string;
  };
  child_routers?: unknown[];
  value?: number;
}

interface RawResponse {
  success: boolean;
  data?: RawActivity[];
  metadata?: { tokens?: Record<string, { token_symbol?: string; token_decimals?: number }> };
  message?: string;
}

function loadCache(): CacheShape {
  if (typeof window === "undefined") return { v: CACHE_VERSION, byAddress: {} };
  try {
    const raw = window.localStorage.getItem(CACHE_KEY);
    if (!raw) return { v: CACHE_VERSION, byAddress: {} };
    const parsed = JSON.parse(raw) as CacheShape;
    if (parsed.v !== CACHE_VERSION) return { v: CACHE_VERSION, byAddress: {} };
    return parsed;
  } catch {
    return { v: CACHE_VERSION, byAddress: {} };
  }
}

function saveCache(cache: CacheShape) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch {
    /* ignore quota */
  }
}

function isFresh(entry: CacheEntry): boolean {
  return Date.now() - entry.fetchedAt < CACHE_TTL_MS;
}

function normalizeActivity(raw: RawActivity): SolscanDefiActivity {
  const platform =
    Array.isArray(raw.platform) && raw.platform.length > 0
      ? raw.platform[0]
      : undefined;
  const tokens: SolscanDefiActivity["tokens"] = [];
  if (raw.amount_info?.token1 && raw.amount_info.amount1) {
    const dec = raw.amount_info.token1_decimals ?? 0;
    const amt = Number(raw.amount_info.amount1) / 10 ** dec;
    tokens.push({
      address: raw.amount_info.token1,
      decimals: dec,
      amount: amt,
    });
  }
  if (raw.amount_info?.token2 && raw.amount_info.amount2) {
    const dec = raw.amount_info.token2_decimals ?? 0;
    const amt = Number(raw.amount_info.amount2) / 10 ** dec;
    tokens.push({
      address: raw.amount_info.token2,
      decimals: dec,
      amount: amt,
    });
  }
  return {
    signature: raw.trans_id,
    blockTime: raw.block_time,
    activityType: raw.activity_type,
    ...(platform && { platform }),
    ...(raw.from_address && { fromAddress: raw.from_address }),
    ...(raw.to_address && { toAddress: raw.to_address }),
    ...(tokens.length > 0 && { tokens }),
  };
}

/**
 * Запрашивает все DeFi activities для адреса.
 *
 * Pagination: page=1, page=2, ... пока возвращается page_size элементов.
 * Если кэш свежий — возвращает кэшированное.
 *
 * @returns массив activities (от самых свежих к старым).
 */
export async function fetchSolscanDefiActivities(args: {
  address: string;
  apiKey: string;
  signal?: AbortSignal;
  /** Максимальное число страниц (защита от runaway). По умолчанию 20 = 2000 activities. */
  maxPages?: number;
}): Promise<SolscanDefiActivity[]> {
  const { address, apiKey, signal, maxPages = 20 } = args;
  if (!apiKey) return [];

  const cache = loadCache();
  const cached = cache.byAddress[address];
  if (cached && isFresh(cached)) {
    return cached.data;
  }

  const all: SolscanDefiActivity[] = [];
  // На первой странице пробуем 3 формата auth и запоминаем работающий.
  let workingHeaders: Record<string, string> | null = null;
  const headerVariants = buildAuthHeaders(apiKey);
  let page = 1;
  while (page <= maxPages) {
    const url =
      `${ENDPOINT}/account/defi/activities?address=${encodeURIComponent(address)}` +
      `&page=${page}&page_size=${PAGE_SIZE}&sort_by=block_time&sort_order=desc`;
    let res: Response | null = null;
    try {
      if (workingHeaders) {
        res = await fetch(url, {
          headers: workingHeaders,
          ...(signal ? { signal } : {}),
        });
      } else {
        // Пробуем поочерёдно три варианта auth header. Первый который не 401
        // — запоминаем как working для последующих страниц.
        for (const headers of headerVariants) {
          const r = await fetch(url, {
            headers,
            ...(signal ? { signal } : {}),
          });
          if (r.status !== 401) {
            workingHeaders = headers;
            res = r;
            break;
          }
        }
        if (!res) {
          // Все три варианта вернули 401 — ключ реально неверный.
          console.warn("Solscan API: all auth variants returned 401");
          break;
        }
      }
    } catch (e) {
      if ((e as Error).name === "AbortError") throw e;
      break;
    }
    if (!res.ok) {
      console.warn(
        `Solscan API ${res.status} for page ${page}:`,
        await res.text().catch(() => ""),
      );
      break;
    }
    const json = (await res.json()) as RawResponse;
    if (!json.success || !json.data) break;
    for (const raw of json.data) all.push(normalizeActivity(raw));
    if (json.data.length < PAGE_SIZE) break; // последняя страница
    page += 1;
  }

  cache.byAddress[address] = {
    data: all,
    fetchedAt: Date.now(),
    ...(all[0]?.signature && { latestSignature: all[0].signature }),
  };
  saveCache(cache);
  return all;
}

/**
 * Маппинг Solscan activity_type → CapFlow op type.
 *
 * Возвращает `null` если activity не имеет аналога в наших OpType (или
 * это что-то нерелевантное, типа token approve).
 */
export function mapSolscanActivityToOpType(
  activityType: SolscanActivityType,
):
  | "swap"
  | "lp_add"
  | "lp_remove"
  | "stake"
  | "unstake"
  | "lend_supply"
  | "lend_withdraw"
  | "borrow"
  | "repay"
  | "claim_rewards"
  | null {
  switch (activityType) {
    case "ACTIVITY_TOKEN_SWAP":
    case "ACTIVITY_AGG_TOKEN_SWAP":
      return "swap";
    case "ACTIVITY_TOKEN_ADD_LIQ":
      return "lp_add";
    case "ACTIVITY_TOKEN_REMOVE_LIQ":
      return "lp_remove";
    case "ACTIVITY_SPL_TOKEN_STAKE":
      return "stake";
    case "ACTIVITY_SPL_TOKEN_UNSTAKE":
      return "unstake";
    case "ACTIVITY_TOKEN_DEPOSIT_VAULT":
      return "lend_supply";
    case "ACTIVITY_TOKEN_WITHDRAW_VAULT":
      return "lend_withdraw";
    case "ACTIVITY_LOAN":
      return "borrow";
    case "ACTIVITY_REPAY":
      return "repay";
    case "ACTIVITY_REWARDS":
      return "claim_rewards";
    default:
      return null;
  }
}
