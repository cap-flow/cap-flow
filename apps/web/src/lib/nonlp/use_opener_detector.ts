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
  /**
   * key: `${chain}|${receiptToken}|${wallet}` (all lowercase) → NonLpOpener.
   *
   * 2026-05-28 fix: раньше ключевали по positionId (POS-NNN), но они
   * переномеровываются при прогрессивной загрузке → targetsKey менялся →
   * effect рестартовал → throttled loop не успевал. Стабильный ключ
   * (receipt token + wallet) не зависит от порядка позиций.
   */
  data: Map<string, NonLpOpener>;
  loading: boolean;
  error: string | null;
}

/** Public helper — построить стабильный ключ (для override match'а). */
export function nonLpOpenerKey(
  chainCode: string,
  receiptToken: string,
  wallet: string,
): string {
  return keyOf({ chainCode, receiptToken, wallet });
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
  // Стабильный ключ для deps — БЕЗ positionId (POS-NNN переномеровываются при
  // прогрессивной загрузке). Только receipt token + wallet — это не зависит
  // от порядка позиций, поэтому effect не рестартует когда POS-NNN сдвигается.
  const targetsKey = useMemo(
    () =>
      Array.from(new Set(targets.map((t) => keyOf(t))))
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
      // result keyed by STABLE key (chain|receiptToken|wallet), не positionId.
      const result = new Map<string, NonLpOpener>();
      const errors: string[] = [];
      let didFetch = false;
      // Dedup targets по стабильному ключу (2 позиции в одном пуле — 1 fetch).
      const seen = new Set<string>();

      for (const t of targets) {
        if (cancelled) return;
        const cacheKey = keyOf(t);
        if (seen.has(cacheKey)) continue;
        seen.add(cacheKey);

        // 1. Cache hit (включая negative cache: opener === null).
        const cached = moduleCache.get(cacheKey);
        if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
          if (cached.opener) result.set(cacheKey, cached.opener);
          continue;
        }

        // 2. In-flight dedup.
        const pending = inFlight.get(cacheKey);
        if (pending) {
          try {
            const r = await pending;
            if (r) result.set(cacheKey, r);
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
          // Persist ПОСЛЕ КАЖДОГО fetch — прогресс выживает отмену effect'а
          // (re-render во время throttled loop'а раньше терял всё).
          persistCache();
          if (opener) result.set(cacheKey, opener);
        } catch (e) {
          if (e instanceof EtherscanChainNotSupportedError) {
            // BASE/SONIC и т.п. — negative-cache чтобы не долбить каждый mount.
            moduleCache.set(cacheKey, { opener: null, fetchedAt: Date.now() });
            persistCache();
          } else {
            errors.push(`${cacheKey.slice(0, 24)}: ${(e as Error).message}`);
          }
        } finally {
          inFlight.delete(cacheKey);
        }
        // Инкрементально обновляем state по мере резолва (не ждём весь loop).
        if (!cancelled) {
          setState({ data: new Map(result), loading: true, error: null });
        }
      }

      if (cancelled) return;
      setState({
        data: result,
        loading: false,
        error: errors.length > 0 ? errors.slice(0, 3).join("; ") : null,
      });
      if (typeof window !== "undefined") {
        console.log(
          `[NonLP opener] resolved ${result.size} dates (${seen.size} unique targets)` +
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
