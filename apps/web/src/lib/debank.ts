/**
 * Минимальный типизированный клиент для DeBank Cloud Pro API.
 * Документация: https://docs.cloud.debank.com/
 *
 * **Phase S3**: запросы идут через **backend upstream-proxy**
 * (`/api/v1/upstream/debank/*`). Бекенд инжектит `AccessKey` header
 * со своим (admin'овским) ключом — frontend ключ **никогда не нужен**
 * и игнорируется. Параметр `accessKey` оставлен в сигнатурах для
 * обратной совместимости со старыми call-site'ами; будет удалён в S4.
 */

import { apiFetch } from "./api/client";

const BASE = "/v1/upstream/debank";

/* ----------------------------- Типы ответа -------------------------------- */

export interface DeBankToken {
  id: string;
  chain: string;
  name: string;
  symbol: string;
  decimals: number;
  logo_url: string | null;
  price?: number;
  /**
   * Спам-фильтр от самого DeBank. Эти поля приходят в /v1/user/all_token_list
   * (но не во всех других ответах), и мы используем их, чтобы отбраковать
   * скам-токены с фейковой high-price (типа "$5000 за CLAIM-airdrop"),
   * которые иначе бы инфлировали Σ tokens.usd дашборда в десятки раз.
   * `is_verified` — токен опознан issuer'ом.
   * `is_core`     — DeBank сам признаёт его «настоящим» токеном.
   * `is_wallet`   — токен в кошельке (а не receipt-токен протокола; не путать
   *                 с EVM_RECEIPT_TOKEN_SYMBOLS из live_adapters.ts).
   */
  is_verified?: boolean;
  is_core?: boolean;
  is_wallet?: boolean;
}

export interface DeBankProject {
  id: string;
  chain: string;
  name: string;
  logo_url: string | null;
  site_url?: string;
}

export interface DeBankSendOrReceive {
  amount: number;
  to_addr?: string;
  from_addr?: string;
  token_id: string;
}

export interface DeBankTokenApprove {
  spender: string;
  token_id: string;
  value: number;
}

export interface DeBankTx {
  from_addr: string;
  to_addr: string;
  value?: number;
  eth_gas_fee?: number;
  usd_gas_fee?: number;
  status?: number; // 1 — успех, 0 — failed
  name?: string;
  params?: unknown[];
}

export interface DeBankHistoryItem {
  id: string; // tx hash
  chain: string; // "eth", "arb", "op"…
  cate_id: string | null; // "send" | "receive" | "approve" | "swap" | …
  time_at: number; // unix seconds
  project_id: string | null;
  cex_id: string | null;
  sends: DeBankSendOrReceive[];
  receives: DeBankSendOrReceive[];
  token_approve: DeBankTokenApprove | null;
  tx: DeBankTx | null;
}

export interface DeBankHistoryResponse {
  cate_dict: Record<string, { id: string; name: string }>;
  history_list: DeBankHistoryItem[];
  project_dict: Record<string, DeBankProject>;
  token_dict: Record<string, DeBankToken>;
  cex_dict: Record<string, { id: string; name: string; logo_url?: string }>;
}

/* ----------------------------- Клиент ------------------------------------- */

export class DeBankAuthError extends Error {
  constructor() {
    super("DeBank: invalid or missing AccessKey");
    this.name = "DeBankAuthError";
  }
}

async function request<T>(
  path: string,
  params: Record<string, string | number | undefined>,
  // S3: accessKey is ignored — backend injects its own.
  _accessKey: string,
  signal?: AbortSignal,
): Promise<T> {
  // Build the query string against a dummy origin so URL doesn't need to
  // know about real origin (apiFetch prepends API base URL).
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") search.set(k, String(v));
  }
  const qs = search.toString();
  const fullPath = `${BASE}${path}${qs ? `?${qs}` : ""}`;

  const res = await apiFetch(fullPath, signal ? { signal } : {});

  if (res.status === 401 || res.status === 403) {
    throw new DeBankAuthError();
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`DeBank ${res.status}: ${body || res.statusText}`);
  }
  return (await res.json()) as T;
}

/**
 * Один шаг истории по всем сетям. Передайте `start_time` (unix sec),
 * чтобы получить страницу записей строго раньше указанной отметки.
 */
export function fetchAllHistoryPage(
  args: {
    address: string;
    accessKey: string;
    startTime?: number;
    pageCount?: number; // ≤ 20
    chainIds?: string;
  },
  signal?: AbortSignal,
): Promise<DeBankHistoryResponse> {
  return request<DeBankHistoryResponse>(
    "/v1/user/all_history_list",
    {
      id: args.address.toLowerCase(),
      start_time: args.startTime,
      page_count: args.pageCount ?? 20,
      chain_ids: args.chainIds,
    },
    args.accessKey,
    signal,
  );
}

/**
 * Загружает всю историю последовательными страницами по 20 записей,
 * с защитой от бесконечного цикла и возможностью отмены.
 *
 * @param onPage — колбэк, чтобы постепенно отрисовывать данные.
 * @param maxPages — предел страниц (по умолчанию 200 → до 4000 операций).
 */
export async function fetchAllHistory(
  args: {
    address: string;
    accessKey: string;
    chainIds?: string;
    maxPages?: number;
    onPage?: (page: DeBankHistoryResponse, pageIndex: number) => void;
    /**
     * Инкрементальная синхронизация: возвращает true, если данная tx уже
     * была загружена ранее. Цикл остановится на первой такой tx и вернёт
     * только новые операции.
     */
    stopWhen?: (it: DeBankHistoryItem) => boolean;
  },
  signal?: AbortSignal,
): Promise<{
  items: DeBankHistoryItem[];
  tokens: Record<string, DeBankToken>;
  projects: Record<string, DeBankProject>;
  /**
   * `true`, если пагинация дошла до естественного конца истории (пустая или
   * неполная страница, либо `stopWhen` догнал уже известную tx). `false`, если
   * цикл упёрся в `maxPages` (история, вероятно, длиннее — усечена). Call-site
   * использует это, чтобы пометить кэш `historyComplete` и в следующий раз
   * грузить лишь инкремент (несколько страниц).
   */
  reachedEnd: boolean;
}> {
  const items: DeBankHistoryItem[] = [];
  const tokens: Record<string, DeBankToken> = {};
  const projects: Record<string, DeBankProject> = {};

  let startTime: number | undefined = undefined;
  let lastSeenTime = Number.POSITIVE_INFINITY;
  // Стал ли выход из цикла «естественным» (история закончилась) или это упор
  // в maxPages-cap. По умолчанию false → если for-loop отработал все maxPages
  // итераций без natural-break, история усечена.
  let reachedEnd = false;
  // Стратегия (2026-06, замена H13-компромисса):
  //   - ПЕРВАЯ загрузка кошелька (call-site передаёт большой cap, напр. 500):
  //     грузим историю ДО ЕСТЕСТВЕННОГО КОНЦА, чтобы не терять старшие лоты
  //     (раньше обрыв на 25 стр. = 500 ops → cost basis активных юзеров
  //     был неполным).
  //   - ИНКРЕМЕНТ (есть кэш/server-hydration → активен `stopWhen`): call-site
  //     передаёт малый cap (напр. 5). `stopWhen` стопит на первой известной
  //     tx, малый cap — явный предохранитель.
  // Конкретные значения настраиваются админом (knobs
  // `debank.historyMaxPagesFirstLoad` / `debank.historyMaxPagesIncremental`)
  // и прокидываются сюда из call-site. `?? 25` — safe fallback для прочих
  // вызовов без явного maxPages.
  const maxPages = args.maxPages ?? 25;

  for (let page = 0; page < maxPages; page++) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

    const pageArgs: Parameters<typeof fetchAllHistoryPage>[0] = {
      address: args.address,
      accessKey: args.accessKey,
      pageCount: 20,
    };
    if (startTime !== undefined) pageArgs.startTime = startTime;
    if (args.chainIds) pageArgs.chainIds = args.chainIds;
    const data = await fetchAllHistoryPage(pageArgs, signal);

    // Инкрементальный stop: ищем первую известную tx в странице.
    if (args.stopWhen) {
      const hitIdx = data.history_list.findIndex((it) => args.stopWhen!(it));
      if (hitIdx !== -1) {
        // Берём только новые tx, словари тоже обновляем.
        const newItems = data.history_list.slice(0, hitIdx);
        items.push(...newItems);
        Object.assign(tokens, data.token_dict);
        Object.assign(projects, data.project_dict);
        args.onPage?.({ ...data, history_list: newItems }, page);
        // Догнали уже известную tx → дальше только синканое, история «полна».
        reachedEnd = true;
        break;
      }
    }

    Object.assign(tokens, data.token_dict);
    Object.assign(projects, data.project_dict);
    items.push(...data.history_list);

    args.onPage?.(data, page);

    if (data.history_list.length === 0) {
      reachedEnd = true;
      break;
    }

    const tail = data.history_list[data.history_list.length - 1]!;
    if (tail.time_at >= lastSeenTime) {
      reachedEnd = true;
      break;
    }
    lastSeenTime = tail.time_at;

    if (data.history_list.length < 20) {
      reachedEnd = true;
      break;
    }
    startTime = tail.time_at;
  }

  // No silent caps: если упёрлись в maxPages, не достигнув конца — историю
  // могли усечь. Логируем, чтобы усечение было видно (важно для cost basis).
  if (!reachedEnd) {
    // eslint-disable-next-line no-console
    console.warn(
      `[debank] history pagination hit maxPages=${maxPages} cap for ` +
        `${args.address} — loaded ${items.length} ops, older history may be truncated`,
    );
  }

  return { items, tokens, projects, reachedEnd };
}

/* ------------------------- Live state: balances --------------------------- */

export interface DeBankTokenBalance extends DeBankToken {
  amount: number;
  raw_amount?: number;
  /** USD-стоимость = amount × price (DeBank сам не возвращает, считаем сами). */
}

/** GET /v1/user/all_token_list — текущие балансы токенов по всем сетям. */
export function fetchAllTokenList(
  args: { address: string; accessKey: string; isAll?: boolean },
  signal?: AbortSignal,
): Promise<DeBankTokenBalance[]> {
  return request<DeBankTokenBalance[]>(
    "/v1/user/all_token_list",
    {
      id: args.address.toLowerCase(),
      is_all: args.isAll ? "true" : undefined,
    },
    args.accessKey,
    signal,
  );
}

/* ------------------------ Live state: protocols --------------------------- */

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
  name: string;                  // "Lending" | "Liquidity Pool" | "Vault" | "Yield" | …
  detail_types: string[];        // ["lending"], ["common"], ["locked"]
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
  has_supported_portfolio: boolean;
  portfolio_item_list: DeBankPortfolioItem[];
}

/** GET /v1/user/all_complex_protocol_list — все открытые DeFi-позиции. */
export function fetchAllComplexProtocolList(
  args: { address: string; accessKey: string; chainIds?: string },
  signal?: AbortSignal,
): Promise<DeBankComplexProtocol[]> {
  return request<DeBankComplexProtocol[]>(
    "/v1/user/all_complex_protocol_list",
    {
      id: args.address.toLowerCase(),
      chain_ids: args.chainIds,
    },
    args.accessKey,
    signal,
  );
}

/** GET /v1/user/total_balance — суммарная USD-стоимость по всем сетям. */
export interface DeBankTotalBalance {
  total_usd_value: number;
  chain_list: { id: string; community_id: number; name: string; native_token_id: string; logo_url: string; usd_value: number }[];
}

export function fetchTotalBalance(
  args: { address: string; accessKey: string },
  signal?: AbortSignal,
): Promise<DeBankTotalBalance> {
  return request<DeBankTotalBalance>(
    "/v1/user/total_balance",
    { id: args.address.toLowerCase() },
    args.accessKey,
    signal,
  );
}

/* ----------------------------- Утилиты ------------------------------------ */

/** Проверка адреса EVM (без чек-суммы). */
export function isLikelyEvmAddress(s: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(s.trim());
}

/** Нормализованный человекочитаемый "тип" операции. */
export function classifyOperation(item: DeBankHistoryItem): string {
  const cate = item.cate_id?.toLowerCase() ?? "";
  if (cate) return cate;
  if (item.sends.length && item.receives.length) return "swap";
  if (item.sends.length) return "send";
  if (item.receives.length) return "receive";
  if (item.token_approve) return "approve";
  if (item.tx?.status === 0) return "cancel";
  return "contract";
}
