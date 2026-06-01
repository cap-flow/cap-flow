/**
 * Krystal Cloud HTTP client.
 *
 * Routed через backend upstream-proxy (`/api/v1/upstream/krystal/*`) —
 * server-side держит `KRYSTAL_API_KEY` env, фронт ничего не знает. Auth
 * через `cap_access` cookie от `requireAuth` middleware. См.
 * `apps/api/src/modules/upstream-proxy/upstream-proxy.service.ts` для
 * provider config (path allow-list + KC-APIKey injection).
 *
 * Один call в `v1/positions?wallet={addr}&positionStatus=OPEN&protocols=uniswap`
 * = 10 credits. Возвращает все V3/V4 NFT'ы юзера на всех supported chains.
 *
 * Документация Krystal: https://cloud.krystal.app/docs
 */

import { apiFetch } from "@/lib/api/client";
import type { KrystalPosition, KrystalTransaction } from "./types";

export interface KrystalCreditMeter {
  before: number;
  cost: number;
  left: number;
}

export interface KrystalResult<T> {
  data: T;
  credits?: KrystalCreditMeter;
}

function parseCreditHeaders(h: Headers): KrystalCreditMeter | undefined {
  const before = Number(h.get("KC-Credits-Before"));
  const cost = Number(h.get("KC-Credits-Cost"));
  const left = Number(h.get("KC-Credits-Left"));
  if (!Number.isFinite(before) && !Number.isFinite(left)) return undefined;
  return { before, cost, left };
}

// ─── Retry/backoff на 429/503 ─────────────────────────────────────────────
// Krystal cloud имеет rate-limit (429) + upstream-proxy отдаёт 503 при
// transient недоступности ключа. До фикса любой 429/503 → throw → Krystal-
// override пропускался → fee откатывался на DeBank → «—» (api_usage показал
// 240× 429 на рефреше). Прерывисто: часть позиций 200, часть 429 в одном
// бурсте (closed-pools allSettled + per-NFT /transactions + open — параллельно).
// Ретраим transient-статусы с экспоненциальным backoff (+ уважаем Retry-After),
// после исчерпания попыток отдаём последний response (caller бросит как раньше
// → graceful degradation). НЕ ретраим 401/402/404 (постоянные).
const RETRYABLE_STATUSES = new Set([429, 503]);
const MAX_RETRY_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 300;
const MAX_BACKOFF_MS = 4000;

/** Retry-After → ms. Поддержка delta-seconds (число) и HTTP-date. null если нет/невалидно. */
export function parseRetryAfterMs(headerValue: string | null): number | null {
  if (!headerValue) return null;
  const trimmed = headerValue.trim();
  if (/^\d+$/.test(trimmed)) {
    return Math.min(Number(trimmed) * 1000, 60_000);
  }
  const dateMs = Date.parse(trimmed);
  if (Number.isFinite(dateMs)) {
    const delta = dateMs - Date.now();
    return delta > 0 ? Math.min(delta, 60_000) : 0;
  }
  return null;
}

export interface KrystalFetchDeps {
  /** Инъекция для тестов (default = apiFetch). */
  fetchImpl?: (path: string, init: RequestInit) => Promise<Response>;
  /** Инъекция для тестов (default = setTimeout-sleep) — детерминированные тесты без реальных задержек. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * apiFetch с ретраем transient-статусов (429/503). Возвращает финальный
 * Response (caller сам разбирает статусы 401/402/404/ok как раньше). Респектит
 * Retry-After, иначе экспоненциальный backoff 300→600→1200ms (cap 4s).
 * AbortError из fetchImpl пробрасывается без ретрая (loop ломается).
 */
export async function krystalFetchWithRetry(
  path: string,
  init: RequestInit,
  deps: KrystalFetchDeps = {},
): Promise<Response> {
  const fetchImpl = deps.fetchImpl ?? apiFetch;
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let attempt = 0;
  for (;;) {
    const res = await fetchImpl(path, init);
    if (!RETRYABLE_STATUSES.has(res.status) || attempt >= MAX_RETRY_ATTEMPTS) {
      return res;
    }
    const retryAfter = parseRetryAfterMs(res.headers.get("Retry-After"));
    const backoff =
      retryAfter ?? Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** attempt);
    attempt += 1;
    await sleep(backoff);
  }
}

/**
 * Получить все OPEN Uniswap V3 / V4 LP позиции для одного wallet.
 *
 * Note: protocol filter "uniswap" покрывает Uniswap V2/V3/V4. На нашей
 * стороне фильтруем дальше по `protocol.key === "uniswapv3"` в adapter.
 */
export async function fetchKrystalUniswapV3Positions(
  wallet: string,
  options?: { signal?: AbortSignal },
): Promise<KrystalResult<KrystalPosition[]>> {
  if (!wallet || !/^0x[0-9a-fA-F]{40}$/.test(wallet)) {
    throw new Error(`Invalid wallet address: ${wallet}`);
  }
  const qs = new URLSearchParams({
    wallet,
    positionStatus: "OPEN",
    protocols: "uniswap",
  });
  const path = `/v1/upstream/krystal/v1/positions?${qs.toString()}`;

  const res = await krystalFetchWithRetry(path, {
    method: "GET",
    ...(options?.signal && { signal: options.signal }),
  });

  if (res.status === 401) throw new Error("Krystal proxy: unauthorized");
  if (res.status === 402) throw new Error("Krystal: out of credits");
  if (res.status === 429) throw new Error("Krystal: rate limited");
  if (!res.ok) throw new Error(`Krystal proxy: HTTP ${res.status}`);

  const data = (await res.json()) as KrystalPosition[];
  const credits = parseCreditHeaders(res.headers);
  return credits ? { data, credits } : { data };
}

/**
 * Получить все CLOSED Uniswap V3/V4 LP позиции для одного wallet.
 *
 * Krystal /positions с `positionStatus=CLOSED` отдаёт NFT'ы у которых
 * `liquidity = "0"` — пользователь полностью вывел ликвидность. На стороне
 * нашего pipeline нужны для **точечной фильтрации dust-фантомов**:
 * DeBank live snapshot иногда продолжает показывать $0.50-$5 остатков
 * (uncollected fees / pricing residual) в пулах, где NFT уже закрыт.
 * Без CLOSED-знания эти dust строки идут в /performance как обычные
 * open positions с -90%+ PnL display.
 *
 * 2026-05-28 (MMaksimuk POS-046 audit, Option B'): отдельный fetch path
 * с safe Promise.allSettled в hook — НЕ объединяем с OPEN flow (тот баг
 * #89 показал что Promise.all rejected кладёт OPEN data). При любой
 * ошибке CLOSED fetch'а — пустой результат, фильтр просто не применяется.
 */
export async function fetchKrystalClosedV3Positions(
  wallet: string,
  options?: { signal?: AbortSignal; chainId?: number },
): Promise<KrystalResult<KrystalPosition[]>> {
  if (!wallet || !/^0x[0-9a-fA-F]{40}$/.test(wallet)) {
    throw new Error(`Invalid wallet address: ${wallet}`);
  }
  // 2026-05-28 (MMaksimuk POS-046 follow-up): Krystal CLOSED endpoint без
  // явного chainIds возвращает позиции только ОДНОЙ chain'и (видимо
  // дефолтит на самую активную для wallet'а — для MMaksimuk это ARB).
  // OPEN endpoint так не делает. Чтобы покрыть все chain'ы — ОБЯЗАТЕЛЬНО
  // вызывать с `chainId` параметром per chain. Multiple chainIds в одном
  // request'е (через repeated `chainIds=N`) тоже возвращает только 1
  // chain — пробовал и не работает. Итог: hook делает Promise.allSettled
  // по списку supported chains.
  const qsParams: Record<string, string> = {
    wallet,
    positionStatus: "CLOSED",
    protocols: "uniswap",
  };
  if (options?.chainId != null) {
    qsParams.chainIds = String(options.chainId);
  }
  const qs = new URLSearchParams(qsParams);
  const path = `/v1/upstream/krystal/v1/positions?${qs.toString()}`;

  const res = await krystalFetchWithRetry(path, {
    method: "GET",
    ...(options?.signal && { signal: options.signal }),
  });

  if (res.status === 401) throw new Error("Krystal proxy: unauthorized");
  if (res.status === 402) throw new Error("Krystal: out of credits");
  if (res.status === 429) throw new Error("Krystal: rate limited");
  if (!res.ok) throw new Error(`Krystal proxy: HTTP ${res.status}`);

  const data = (await res.json()) as KrystalPosition[];
  const credits = parseCreditHeaders(res.headers);
  return credits ? { data, credits } : { data };
}

/**
 * Получить per-tx историю событий (DEPOSIT / WITHDRAW / COLLECT_FEE) для
 * конкретного V3/V4 NFT.
 *
 * Endpoint: `/v1/positions/{chainId}/{npmAddress}-{tokenId}/transactions`
 * (см. 2026-05-27 VolnyySanya audit: подтверждён на BASE/ETH/ARB byte-в-byte).
 *
 * Возвращает массив events newest-first. Каждый event имеет `type` (string),
 * `txHash`, `blockTime` (unix sec), и `transactions[]` с per-token amounts +
 * **historical USD** (slot0/oracle price at block, не current spot).
 *
 * Используется для построения `OpenPosition.feesClaimedHistory` без
 * необходимости own on-chain Collect event indexer (Variant 1).
 */
export async function fetchKrystalPositionTransactions(args: {
  chainId: number;
  npmAddress: string;
  tokenId: string | bigint;
  options?: { signal?: AbortSignal };
}): Promise<KrystalResult<KrystalTransaction[]>> {
  const npm = args.npmAddress.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(npm)) {
    throw new Error(`Invalid NPM address: ${args.npmAddress}`);
  }
  const tokenIdStr = String(args.tokenId);
  if (!/^\d+$/.test(tokenIdStr)) {
    throw new Error(`Invalid tokenId: ${tokenIdStr}`);
  }
  const path = `/v1/upstream/krystal/v1/positions/${args.chainId}/${npm}-${tokenIdStr}/transactions`;

  const res = await krystalFetchWithRetry(path, {
    method: "GET",
    ...(args.options?.signal && { signal: args.options.signal }),
  });

  if (res.status === 401) throw new Error("Krystal proxy: unauthorized");
  if (res.status === 402) throw new Error("Krystal: out of credits");
  if (res.status === 429) throw new Error("Krystal: rate limited");
  if (res.status === 404) {
    // Position не найдена — возвращаем пустой массив (graceful).
    return { data: [] };
  }
  if (!res.ok) throw new Error(`Krystal proxy: HTTP ${res.status}`);

  const data = (await res.json()) as KrystalTransaction[];
  const credits = parseCreditHeaders(res.headers);
  return credits ? { data, credits } : { data };
}
