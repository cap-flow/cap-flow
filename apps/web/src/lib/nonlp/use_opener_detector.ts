/**
 * React hook: для НЕ-LP позиций без `openedAt` (Lending/Yield/Staked/...)
 * определяет дату открытия через первый IN-transfer receipt-токена на
 * Etherscan (см. `opener_detector.ts`).
 *
 * Stage 1 (этот hook): только дата открытия. Заполняет `openedAt` где
 * UCB/DeBank дали null → разблокирует `ageDays` → разблокирует APR.
 *
 * Архитектура повторяет `useV3LiquidityEvents`:
 *   - module-scope cache + localStorage (TTL 7d — дата открытия неизменна)
 *   - in-flight Promise dedup (React 18 StrictMode)
 *   - sequential fetch с throttle 250ms (Etherscan free tier 5 req/s)
 *   - fail-soft: ошибка одного target'а / unsupported chain → skip, не валит
 *
 * Cache TTL длинный (7d) т.к. openedAt — историческая константа (момент
 * открытия в прошлом не меняется). Refetch только при version-bump.
 */

import { useEffect, useMemo, useState } from "react";

import {
  detectNonLpOpener,
  EtherscanChainNotSupportedError,
  type NonLpOpener,
} from "./opener_detector";

const CACHE_KEY = "capflow.cache.nonlp.opener.v1";
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface NonLpOpenerTarget {
  /** Уникальный ключ позиции — для матча обратно в OpenPosition. */
  positionId: string;
  chainCode: string;
  /** Receipt token contract (= OpenPosition.lpTokenId). */
  receiptToken: string;
  /** Owner wallet address. */
  wallet: string;
}

interface CacheEntry {
  opener: NonLpOpener | null; // null = проверили, IN transfer не найден
  fetchedAt: number;
}

/** key: `${chain}|${receiptToken.toLowerCase()}|${wallet.toLowerCase()}`. */
function keyOf(t: { chainCode: string; receiptToken: string; wallet: string }): string {
  return `${t.chainCode.toLowerCase()}|${t.receiptToken.toLowerCase()}|${t.wallet.toLowerCase()}`;
}

const moduleCache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<NonLpOpener | null>>();

// Load cache from localStorage at module init.
try {
  const raw = localStorage.getItem(CACHE_KEY);
  if (raw) {
    const parsed = JSON.parse(raw) as Record<string, CacheEntry>;
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v?.fetchedAt === "number") moduleCache.set(k, v);
    }
  }
} catch {
  /* ignore */
}

function persistCache(): void {
  try {
    const obj: Record<string, CacheEntry> = {};
    for (const [k, v] of moduleCache) obj[k] = v;
    localStorage.setItem(CACHE_KEY, JSON.stringify(obj));
  } catch {
    /* quota — ignore */
  }
}

export interface NonLpOpenerState {
  /** key: positionId → NonLpOpener. */
  data: Map<string, NonLpOpener>;
  loading: boolean;
  error: string | null;
}

const EMPTY: NonLpOpenerState = { data: new Map(), loading: false, error: null };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Hook. `targets` — позиции без openedAt с известным receipt token.
 * Возвращает Map<positionId, NonLpOpener>. Fail-soft на всех уровнях.
 */
export function useNonLpOpenerDetector(
  targets: NonLpOpenerTarget[],
  enabled: boolean,
): NonLpOpenerState {
  // Стабильный ключ для deps — не re-fetch'ить при ре-рендерах с тем же набором.
  const targetsKey = useMemo(
    () =>
      targets
        .map((t) => `${t.positionId}:${keyOf(t)}`)
        .sort()
        .join("|"),
    [targets],
  );
  const [state, setState] = useState<NonLpOpenerState>(EMPTY);

  useEffect(() => {
    if (!enabled || targets.length === 0) {
      setState(EMPTY);
      return;
    }
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: null }));

    (async () => {
      const result = new Map<string, NonLpOpener>();
      const errors: string[] = [];
      let didFetch = false;

      for (const t of targets) {
        if (cancelled) return;
        const cacheKey = keyOf(t);

        // 1. Cache hit (включая negative cache: opener === null).
        const cached = moduleCache.get(cacheKey);
        if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
          if (cached.opener) result.set(t.positionId, cached.opener);
          continue;
        }

        // 2. In-flight dedup.
        const pending = inFlight.get(cacheKey);
        if (pending) {
          try {
            const r = await pending;
            if (r) result.set(t.positionId, r);
          } catch {
            /* in-flight owner логирует */
          }
          continue;
        }

        // 3. Fresh fetch. Throttle между сетевыми вызовами.
        if (didFetch) await sleep(250);
        didFetch = true;
        const promise = detectNonLpOpener({
          chainCode: t.chainCode,
          receiptToken: t.receiptToken,
          wallet: t.wallet,
        });
        inFlight.set(cacheKey, promise);
        try {
          const opener = await promise;
          moduleCache.set(cacheKey, { opener, fetchedAt: Date.now() });
          if (opener) result.set(t.positionId, opener);
        } catch (e) {
          if (e instanceof EtherscanChainNotSupportedError) {
            // BASE/SONIC и т.п. — negative-cache чтобы не долбить каждый mount.
            moduleCache.set(cacheKey, { opener: null, fetchedAt: Date.now() });
          } else {
            errors.push(`${t.positionId}: ${(e as Error).message}`);
          }
        } finally {
          inFlight.delete(cacheKey);
        }
      }

      if (cancelled) return;
      persistCache();
      setState({
        data: result,
        loading: false,
        error: errors.length > 0 ? errors.slice(0, 3).join("; ") : null,
      });
      if (typeof window !== "undefined") {
        console.log(
          `[NonLP opener] resolved ${result.size}/${targets.length} dates` +
            (errors.length > 0 ? ` — errors: ${errors.length}` : ""),
        );
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetsKey, enabled]);

  return state;
}

/** Wipe cache (version-bump / manual refresh). */
export function clearNonLpOpenerCache(): void {
  moduleCache.clear();
  try {
    localStorage.removeItem(CACHE_KEY);
  } catch {
    /* ignore */
  }
}
