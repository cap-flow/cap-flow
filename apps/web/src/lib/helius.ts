/**
 * Минимальный клиент Helius Enhanced Transactions API для Solana.
 * Документация: https://www.helius.dev/docs/enhanced-transactions/overview
 *
 * **Phase S3**: запросы идут через backend upstream-proxy
 * (`/api/v1/upstream/helius/*`). Бекенд добавляет `?api-key=...`
 * со своим (admin'овским) ключом — клиентский `apiKey` параметр
 * игнорируется и оставлен для обратной совместимости (удалится в S4).
 */

import { apiFetch } from "./api/client";

const BASE = "/v1/upstream/helius";

/* ----------------------------- Типы ответа -------------------------------- */

export interface HeliusNativeTransfer {
  fromUserAccount: string;
  toUserAccount: string;
  amount: number; // лампорты
}

export interface HeliusTokenTransfer {
  fromUserAccount: string;
  toUserAccount: string;
  fromTokenAccount?: string;
  toTokenAccount?: string;
  tokenAmount: number; // декодированное значение (с учётом decimals)
  mint: string;
}

export interface HeliusInstruction {
  programId: string;
  data?: string;
  accounts?: string[];
}

export interface HeliusTransaction {
  description?: string;
  type: string;       // SWAP, TRANSFER, NFT_SALE, STAKE, …
  source: string;     // JUPITER, RAYDIUM, MAGIC_EDEN, MARINADE, SYSTEM_PROGRAM, …
  fee: number;        // в лампортах
  feePayer: string;
  signature: string;
  slot: number;
  timestamp: number;  // unix sec
  nativeTransfers?: HeliusNativeTransfer[];
  tokenTransfers?: HeliusTokenTransfer[];
  instructions?: HeliusInstruction[];
  events?: {
    swap?: unknown;
    nft?: unknown;
  };
  transactionError?: { error: string } | null;
}

/* --------------------------- ошибки/клиент -------------------------------- */

export class HeliusAuthError extends Error {
  constructor() {
    super("Helius: invalid or missing api-key");
    this.name = "HeliusAuthError";
  }
}

async function request<T>(
  path: string,
  params: Record<string, string | number | undefined>,
  // S3: backend injects api-key; client value ignored.
  _apiKey: string,
  signal?: AbortSignal,
): Promise<T> {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") search.set(k, String(v));
  }
  const qs = search.toString();
  const fullPath = `${BASE}${path}${qs ? `?${qs}` : ""}`;

  const res = await apiFetch(fullPath, signal ? { signal } : {});
  if (res.status === 401 || res.status === 403) {
    throw new HeliusAuthError();
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Helius ${res.status}: ${body || res.statusText}`);
  }
  return (await res.json()) as T;
}

/** Одна страница истории транзакций по адресу. */
export function fetchHeliusPage(
  args: {
    address: string;
    apiKey: string;
    beforeSignature?: string;
    limit?: number; // ≤ 100
    type?: string;
    source?: string;
  },
  signal?: AbortSignal,
): Promise<HeliusTransaction[]> {
  return request<HeliusTransaction[]>(
    `/v0/addresses/${args.address}/transactions`,
    {
      "before-signature": args.beforeSignature,
      limit: args.limit ?? 100,
      type: args.type,
      source: args.source,
    },
    args.apiKey,
    signal,
  );
}

/**
 * Прокачивает всю историю по курсору `before-signature` страницами по 100,
 * с защитой от зацикливания и поддержкой отмены.
 */
export async function fetchAllHeliusHistory(
  args: {
    address: string;
    apiKey: string;
    maxPages?: number;
    onPage?: (page: HeliusTransaction[], pageIndex: number) => void;
    /**
     * Инкрементальная синхронизация: возвращает true, если tx уже загружена.
     * Цикл остановится на первой known-tx и вернёт только новые операции.
     */
    stopWhen?: (tx: HeliusTransaction) => boolean;
  },
  signal?: AbortSignal,
): Promise<HeliusTransaction[]> {
  const acc: HeliusTransaction[] = [];
  let cursor: string | undefined = undefined;
  const maxPages = args.maxPages ?? 200;
  let lastTime = Number.POSITIVE_INFINITY;

  for (let i = 0; i < maxPages; i++) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

    const pageArgs: Parameters<typeof fetchHeliusPage>[0] = {
      address: args.address,
      apiKey: args.apiKey,
      limit: 100,
    };
    if (cursor) pageArgs.beforeSignature = cursor;

    const page = await fetchHeliusPage(pageArgs, signal);
    if (page.length === 0) {
      args.onPage?.(page, i);
      break;
    }

    // Инкрементальный stop: ищем первую известную tx.
    if (args.stopWhen) {
      const hitIdx = page.findIndex((tx) => args.stopWhen!(tx));
      if (hitIdx !== -1) {
        const newOnly = page.slice(0, hitIdx);
        acc.push(...newOnly);
        args.onPage?.(newOnly, i);
        break;
      }
    }

    acc.push(...page);
    args.onPage?.(page, i);

    const tail = page[page.length - 1]!;
    if (tail.timestamp >= lastTime) break;
    lastTime = tail.timestamp;
    if (page.length < 100) break;
    cursor = tail.signature;
  }
  return acc;
}

/* ------------------------- balances --------------------------------------- */

export interface HeliusBalanceToken {
  mint: string;
  amount: number;          // raw amount (без decimals!)
  decimals: number;
  tokenAccount?: string;
}

export interface HeliusBalances {
  nativeBalance: number;   // лампорты (10^9 = 1 SOL)
  tokens: HeliusBalanceToken[];
}

/** GET /v0/addresses/{addr}/balances — текущие балансы кошелька Solana. */
export function fetchHeliusBalances(
  args: { address: string; apiKey: string },
  signal?: AbortSignal,
): Promise<HeliusBalances> {
  return request<HeliusBalances>(
    `/v0/addresses/${args.address}/balances`,
    {},
    args.apiKey,
    signal,
  );
}

/* ----------------------------- утилиты ------------------------------------ */

/** Грубая проверка Solana-адреса (base58, 32–44 символов). */
export function isLikelySolanaAddress(s: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s.trim());
}
