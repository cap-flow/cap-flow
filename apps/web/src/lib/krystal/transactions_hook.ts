/**
 * React hook: для каждой V3/V4 LP позиции с известным `tokenId` загружает
 * per-tx историю событий (DEPOSIT / WITHDRAW / COLLECT_FEE) через Krystal
 * Cloud `/v1/positions/{chainId}/{npm-tokenId}/transactions` endpoint.
 *
 * 2026-05-27 (VolnyySanya audit + lex POS-006/007 verification): эти данные
 * **authoritative** — на 3 проверенных позициях суммы совпали byte-в-byte
 * с реальностью (memory's "POS-007 real $80" vs Krystal $80.37, "POS-006
 * real $271" vs Krystal $271.02). Заменяет UCB+PR-2 split механизм для
 * V3 LP claimed fees полностью.
 *
 * Cost: 1 call per position на refresh. Cache TTL 24h (как у /positions).
 * Manual refresh — clearKrystalTransactionsCacheForToken().
 *
 * Hook gating: `enabled` flag + non-empty target list. Targets — V3 LP
 * positions с set'нутым `matchedV3TokenId`. Те у которых нет — пропускаем
 * (нечего смотреть в Krystal'е).
 */

import { useEffect, useMemo, useState } from "react";

import {
  krystalTransactionsToSummary,
  type KrystalTransactionsSummary,
} from "./adapter";
import { fetchKrystalPositionTransactions } from "./client";
import type { KrystalTransaction } from "./types";

const CACHE_PREFIX = "capflow.cache.krystal.tx.v1:";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

interface Target {
  /** Krystal chain.id (numeric). */
  chainId: number;
  npmAddress: string;
  tokenId: string;
}

interface CacheEntry {
  txs: KrystalTransaction[];
  fetchedAt: number;
}

function cacheKey(chainId: number, npm: string, tokenId: string): string {
  return `${CACHE_PREFIX}${chainId}:${npm.toLowerCase()}:${tokenId}`;
}

function readCache(t: Target): KrystalTransaction[] | null {
  try {
    const raw = localStorage.getItem(cacheKey(t.chainId, t.npmAddress, t.tokenId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CacheEntry>;
    if (typeof parsed.fetchedAt !== "number" || !Array.isArray(parsed.txs)) return null;
    if (Date.now() - parsed.fetchedAt > CACHE_TTL_MS) return null;
    return parsed.txs as KrystalTransaction[];
  } catch {
    return null;
  }
}

function writeCache(t: Target, txs: KrystalTransaction[]): void {
  try {
    const entry: CacheEntry = { txs, fetchedAt: Date.now() };
    localStorage.setItem(cacheKey(t.chainId, t.npmAddress, t.tokenId), JSON.stringify(entry));
  } catch {
    /* quota — ignore */
  }
}

export function clearKrystalTransactionsCacheForToken(args: {
  chainId: number;
  npmAddress: string;
  tokenId: string;
}): void {
  try {
    localStorage.removeItem(cacheKey(args.chainId, args.npmAddress, args.tokenId));
  } catch {
    /* ignore */
  }
}

/** Wipe all transactions entries. Использовать при version-bump схемы. */
export function clearAllKrystalTransactionsCache(): void {
  try {
    const toRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(CACHE_PREFIX)) toRemove.push(k);
    }
    for (const k of toRemove) localStorage.removeItem(k);
  } catch {
    /* ignore */
  }
}

export interface KrystalV3TransactionsState {
  /** key: tokenId (string). Merged across all targets. */
  data: Map<string, KrystalTransactionsSummary>;
  loading: boolean;
  error: string | null;
  creditsLeft: number | null;
}

const EMPTY: KrystalV3TransactionsState = {
  data: new Map(),
  loading: false,
  error: null,
  creditsLeft: null,
};

/**
 * Per-tokenId in-flight Promise dedup (React 18 StrictMode + re-renders).
 */
const inFlight = new Map<string, Promise<KrystalTransaction[] | null>>();

export function useKrystalV3Transactions(
  targets: Target[],
  enabled: boolean,
): KrystalV3TransactionsState {
  const targetsKey = useMemo(
    () =>
      targets
        .map((t) => `${t.chainId}:${t.npmAddress.toLowerCase()}:${t.tokenId}`)
        .sort()
        .join("|"),
    [targets],
  );
  const [state, setState] = useState<KrystalV3TransactionsState>(EMPTY);

  useEffect(() => {
    if (!enabled || targets.length === 0) {
      setState(EMPTY);
      return;
    }
    const controller = new AbortController();
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: null }));

    (async () => {
      const result = new Map<string, KrystalTransactionsSummary>();
      const errors: string[] = [];
      let creditsLeft: number | null = null;
      let cacheHits = 0;
      let fetched = 0;

      for (const t of targets) {
        if (cancelled) return;
        const key = cacheKey(t.chainId, t.npmAddress, t.tokenId);
        // Cache hit
        const cached = readCache(t);
        if (cached) {
          result.set(t.tokenId, krystalTransactionsToSummary(cached));
          cacheHits++;
          continue;
        }
        // In-flight dedup
        const pending = inFlight.get(key);
        if (pending) {
          try {
            const r = await pending;
            if (r) result.set(t.tokenId, krystalTransactionsToSummary(r));
          } catch (e) {
            errors.push(`${t.tokenId}: ${(e as Error).message} (in-flight)`);
          }
          continue;
        }
        // Fresh fetch
        let resolveInFlight: (r: KrystalTransaction[] | null) => void = () => {};
        const promise = new Promise<KrystalTransaction[] | null>((resolve) => {
          resolveInFlight = resolve;
        });
        inFlight.set(key, promise);

        try {
          const { data, credits } = await fetchKrystalPositionTransactions({
            chainId: t.chainId,
            npmAddress: t.npmAddress,
            tokenId: t.tokenId,
            options: { signal: controller.signal },
          });
          fetched++;
          if (credits?.left != null) creditsLeft = credits.left;
          if (data.length > 0) {
            writeCache(t, data);
            result.set(t.tokenId, krystalTransactionsToSummary(data));
          }
          resolveInFlight(data);
        } catch (e) {
          if ((e as Error).name === "AbortError") {
            resolveInFlight(null);
            return;
          }
          resolveInFlight(null);
          errors.push(`${t.tokenId}: ${(e as Error).message}`);
        } finally {
          inFlight.delete(key);
        }
      }

      if (cancelled) return;
      setState({
        data: result,
        loading: false,
        error: errors.length > 0 ? errors.slice(0, 3).join("; ") : null,
        creditsLeft,
      });
      if (typeof window !== "undefined") {
        console.log(
          `[Krystal /transactions] ${result.size} positions ` +
            `(${cacheHits} cache hits, ${fetched} fresh) ` +
            (creditsLeft != null ? `credits left: ${creditsLeft}` : ""),
        );
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
    // targetsKey хеш чтобы не re-fetch'ить при ре-рендерах с тем же набором.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetsKey, enabled]);

  return state;
}
