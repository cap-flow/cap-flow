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
  detectNonLpOpenersForWalletChain,
  EtherscanChainNotSupportedError,
  type NonLpOpener,
} from "./opener_detector";

// v2: NonLpOpener расширен openedInTokens + startUsd (Stage 2a).
// v3: Stage 2b — volatile OUT оценивается через DefiLlama historical. v2
// entries имели startUsd=null для volatile депозитов → bump чтобы пересчитать.
const CACHE_KEY = "capflow.cache.nonlp.opener.v3";
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

      // Группируем targets по (chain|wallet) — один Etherscan fetch всей
      // token-transfer истории резолвит ВСЕ receiptTokens этой группы
      // (vault receipts + staking/locked contracts). Намного меньше запросов
      // и покрывает staking где per-token fetch не работал.
      const groups = new Map<
        string,
        { chainCode: string; wallet: string; receiptTokens: string[] }
      >();
      for (const t of targets) {
        const cacheKey = keyOf(t);
        // Сразу подхватываем cache hit (включая negative cache).
        const cached = moduleCache.get(cacheKey);
        if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
          if (cached.opener) result.set(cacheKey, cached.opener);
          continue;
        }
        const gk = `${t.chainCode.toLowerCase()}|${t.wallet.toLowerCase()}`;
        let g = groups.get(gk);
        if (!g) {
          g = { chainCode: t.chainCode, wallet: t.wallet, receiptTokens: [] };
          groups.set(gk, g);
        }
        if (!g.receiptTokens.includes(t.receiptToken.toLowerCase())) {
          g.receiptTokens.push(t.receiptToken.toLowerCase());
        }
      }

      // 2026-05-28 fix: группы фетчим ПАРАЛЛЕЛЬНО через Promise.allSettled,
      // НЕ sequential throttled loop. Sequential + re-render churn при загрузке
      // приводил к отмене effect'а после 2-4 групп → avax/bsc никогда не
      // достигались. Параллельно = один await, все группы резолвятся за раз;
      // на стабильном rerun все завершаются together (как Krystal CLOSED hook).
      const writeGroup = (
        g: { chainCode: string; wallet: string; receiptTokens: string[] },
        openers: Map<string, NonLpOpener> | null, // null = negative-cache всю группу
      ) => {
        const now = Date.now();
        for (const rt of g.receiptTokens) {
          const cacheKey = keyOf({ chainCode: g.chainCode, receiptToken: rt, wallet: g.wallet });
          const opener = openers?.get(rt) ?? null;
          moduleCache.set(cacheKey, { opener, fetchedAt: now });
          if (opener) result.set(cacheKey, opener);
        }
      };

      await Promise.allSettled(
        Array.from(groups.values()).map(async (g) => {
          try {
            const openers = await detectNonLpOpenersForWalletChain({
              chainCode: g.chainCode,
              wallet: g.wallet,
              receiptTokens: g.receiptTokens,
            });
            writeGroup(g, openers);
          } catch (e) {
            if (e instanceof EtherscanChainNotSupportedError) {
              writeGroup(g, null); // chain нигде не поддержан → negative-cache
            } else {
              errors.push(`${g.chainCode}|${g.wallet.slice(0, 8)}: ${(e as Error).message}`);
            }
          }
        }),
      );
      if (!cancelled) persistCache();

      if (cancelled) return;
      setState({
        data: result,
        loading: false,
        error: errors.length > 0 ? errors.slice(0, 3).join("; ") : null,
      });
      if (typeof window !== "undefined") {
        console.log(
          `[NonLP opener] resolved ${result.size} dates ` +
            `(${groups.size} wallet-chain fetches)` +
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
