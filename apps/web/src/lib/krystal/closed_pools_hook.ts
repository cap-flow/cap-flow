/**
 * React hook: загружает CLOSED Uniswap V3/V4 LP позиции из Krystal Cloud
 * чтобы знать pool address'а в которых пользователь полностью вышел из
 * ликвидности.
 *
 * Используется для **точечной фильтрации dust-фантомов** в `buildOpenPositions`:
 * DeBank live snapshot часто продолжает показывать $0.50-$5 остатков
 * в пулах закрытых NFT (uncollected fee'и / pricing residual). Без знания
 * статуса CLOSED эти dust строки появляются в /performance с -90%+ PnL
 * (выглядят как «провалившиеся позиции»), хотя на самом деле user'у
 * не о чем беспокоиться — позиция закрыта, остался pricing noise.
 *
 * Пример (MMaksimuk POS-046 BASE Uni V3 NFT #3360180 pool 0xd0b53d92...):
 *   - Krystal CLOSED: liquidity="0", providedAmounts.balance="0"
 *   - DeBank live: currentUsd=$4.57 (residual WETH+USDC dust)
 *   - UI без фильтра: показывает позицию с PnL -98%, путает пользователя.
 *
 * 2026-05-28 (Option B' MMaksimuk audit): отделили от OPEN fetch path
 * (PR #89-92 показали что объединение через Promise.all создавало
 * критическую регрессию). Этот хук **полностью fail-soft**:
 *   - Promise.allSettled → ошибка одного wallet'а не валит остальные
 *   - При любом catch → пустой результат, фильтр просто не применяется
 *   - Cache 24h localStorage (как у /positions OPEN)
 *
 * Cost: 10 credits per wallet per fetch. Дёргаем 1 раз per wallet на mount,
 * результат кешируется.
 */

import { useEffect, useMemo, useState } from "react";

import type { Loaded } from "@/components/data/LoadedWalletsProvider";
import { fetchKrystalClosedV3Positions } from "./client";
import type { KrystalPosition } from "./types";

const CACHE_PREFIX = "capflow.cache.krystal.closed.v1:";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

interface CacheEntry {
  pools: ClosedPool[];
  fetchedAt: number;
}

interface ClosedPool {
  chainCode: string;
  poolAddress: string; // lowercase
  tokenId: string;
}

function cacheKeyFor(wallet: string): string {
  return `${CACHE_PREFIX}${wallet.toLowerCase()}`;
}

function readCache(wallet: string): ClosedPool[] | null {
  try {
    const raw = localStorage.getItem(cacheKeyFor(wallet));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CacheEntry>;
    if (typeof parsed.fetchedAt !== "number" || !Array.isArray(parsed.pools)) {
      return null;
    }
    if (Date.now() - parsed.fetchedAt > CACHE_TTL_MS) return null;
    return parsed.pools as ClosedPool[];
  } catch {
    return null;
  }
}

function writeCache(wallet: string, pools: ClosedPool[]): void {
  try {
    const entry: CacheEntry = { pools, fetchedAt: Date.now() };
    localStorage.setItem(cacheKeyFor(wallet), JSON.stringify(entry));
  } catch {
    /* quota — ignore */
  }
}

const CHAIN_ID_TO_CODE: Record<number, string> = {
  1: "eth",
  10: "op",
  56: "bsc",
  137: "matic",
  8453: "base",
  42161: "arb",
  2020: "ron",
  43114: "avax",
};

/**
 * Chains которые мы запрашиваем для CLOSED status. ETH/ARB занимают
 * подавляющее большинство, но BASE/OP/Polygon/BSC/Avax тоже нужны для
 * dust-фильтрации (POS-046 был именно на BASE).
 *
 * Krystal CLOSED endpoint без явного `chainIds` возвращает только одну
 * самую активную chain'у для wallet'а — поэтому ОБЯЗАТЕЛЬНО iterate
 * per chain (см. client.ts).
 */
const SUPPORTED_CHAINS_FOR_CLOSED: { chainId: number; code: string }[] = [
  { chainId: 1, code: "eth" },
  { chainId: 42161, code: "arb" },
  { chainId: 8453, code: "base" },
  { chainId: 10, code: "op" },
  { chainId: 137, code: "matic" },
  { chainId: 56, code: "bsc" },
  { chainId: 43114, code: "avax" },
];

function positionsToPools(positions: readonly KrystalPosition[]): ClosedPool[] {
  const out: ClosedPool[] = [];
  for (const p of positions) {
    const chainCode = CHAIN_ID_TO_CODE[p.chain?.id ?? -1];
    const pool = p.pool?.poolAddress;
    if (!chainCode || !pool || !p.tokenId) continue;
    out.push({
      chainCode,
      poolAddress: pool.toLowerCase(),
      tokenId: p.tokenId,
    });
  }
  return out;
}

export interface KrystalClosedPoolsState {
  /**
   * Key format: `${walletAddress.toLowerCase()}|${chainCode}|${poolAddress.toLowerCase()}`.
   * Если ключ присутствует — на этом wallet+chain в этом pool у Krystal
   * есть NFT с status=CLOSED (liquidity=0).
   */
  closedKeys: Set<string>;
  loading: boolean;
  error: string | null;
}

const EMPTY: KrystalClosedPoolsState = {
  closedKeys: new Set(),
  loading: false,
  error: null,
};

/**
 * Возвращает Set ключей wallet+chain+pool для всех Uniswap V3/V4 NFT'ов
 * пользователя со статусом CLOSED. Fail-soft: при ошибках fetch'а
 * возвращает то что уже есть (партlial result) — фильтр downstream
 * безопасно деградирует.
 */
export function useKrystalV3ClosedPools(
  loaded: Loaded[],
  enabled: boolean,
): KrystalClosedPoolsState {
  const wallets = useMemo<string[]>(() => {
    if (!enabled) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const l of loaded) {
      if (l.wallet.chain !== "evm") continue;
      const a = l.wallet.address.toLowerCase();
      if (seen.has(a)) continue;
      seen.add(a);
      out.push(l.wallet.address);
    }
    return out;
  }, [loaded, enabled]);

  const [state, setState] = useState<KrystalClosedPoolsState>(EMPTY);

  useEffect(() => {
    if (!enabled || wallets.length === 0) {
      setState(EMPTY);
      return;
    }
    const controller = new AbortController();
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: null }));

    (async () => {
      const closedKeys = new Set<string>();
      const errors: string[] = [];

      // 2026-05-28 (MMaksimuk POS-046 follow-up): Krystal CLOSED endpoint
      // отдаёт только одну chain без явного chainIds. Iterate per chain.
      // Promise.allSettled — одна ошибка (chain) не валит остальные.
      const tasks = wallets.map(async (w) => {
        const walletLower = w.toLowerCase();
        // Cache first — содержит pools со всех chains
        const cached = readCache(w);
        if (cached !== null) {
          for (const p of cached) {
            closedKeys.add(`${walletLower}|${p.chainCode}|${p.poolAddress}`);
          }
          return { wallet: w, fromCache: true };
        }
        // Fresh: parallel fetch per chain
        const allPools: ClosedPool[] = [];
        const chainResults = await Promise.allSettled(
          SUPPORTED_CHAINS_FOR_CLOSED.map(async ({ chainId }) => {
            const { data } = await fetchKrystalClosedV3Positions(w, {
              signal: controller.signal,
              chainId,
            });
            return positionsToPools(data);
          }),
        );
        for (const r of chainResults) {
          if (r.status === "fulfilled") {
            allPools.push(...r.value);
          } else if ((r.reason as Error)?.name !== "AbortError") {
            errors.push(
              `${w.slice(0, 6)}…: ${(r.reason as Error).message}`,
            );
          }
        }
        if (cancelled) return null;
        writeCache(w, allPools);
        for (const p of allPools) {
          closedKeys.add(`${walletLower}|${p.chainCode}|${p.poolAddress}`);
        }
        return { wallet: w, fromCache: false };
      });
      await Promise.allSettled(tasks);

      if (cancelled) return;
      setState({
        closedKeys,
        loading: false,
        error: errors.length > 0 ? errors.join("; ") : null,
      });
      if (typeof window !== "undefined") {
        console.log(
          `[Krystal CLOSED] ${closedKeys.size} closed pool entries ` +
            `from ${wallets.length} wallets` +
            (errors.length > 0 ? ` — errors: ${errors.length}` : ""),
        );
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallets.join("|"), enabled]);

  return state;
}

/**
 * Filter helper: применяется к computed open positions. Удаляет dust-фантомы
 * (V3 LP позиции в пулах где Krystal знает что NFT уже закрыт).
 *
 * Защитные guards (всё одновременно — иначе НЕ фильтруем):
 *   1. position попадает только если `isV3LpProtocol(protocol.name) === true`
 *   2. У position нет matchedV3TokenId (= наша pipeline нашла активный NFT —
 *      значит позиция точно живая, не трогаем)
 *   3. `lpTokenId` (pool address) присутствует на position
 *   4. `currentUsd < $50` — dust threshold (защита от случайного скрытия
 *      реальных позиций если Krystal вернул ложный CLOSED)
 *   5. Ключ `${wallet}|${chainCode}|${poolAddress}` есть в closedKeys
 *
 * Если closedKeys пустой (fetch не сработал) — функция возвращает input
 * без изменений (fail-soft).
 */
export function filterClosedDustPositions<
  P extends {
    walletId: string;
    chain: string;
    protocol: { name: string };
    matchedV3TokenId?: string;
    lpTokenId?: string;
    currentUsd: number;
  },
>(
  positions: readonly P[],
  walletAddressById: ReadonlyMap<string, string>,
  closedKeys: ReadonlySet<string>,
  isV3LpProtocol: (name: string) => boolean,
  dustThresholdUsd = 50,
): P[] {
  if (closedKeys.size === 0) return positions.slice();
  const out: P[] = [];
  for (const p of positions) {
    if (!isV3LpProtocol(p.protocol.name) || p.matchedV3TokenId || !p.lpTokenId) {
      out.push(p);
      continue;
    }
    if (p.currentUsd >= dustThresholdUsd) {
      out.push(p);
      continue;
    }
    const wallet = walletAddressById.get(p.walletId);
    if (!wallet) {
      out.push(p);
      continue;
    }
    const key = `${wallet.toLowerCase()}|${p.chain.toLowerCase()}|${p.lpTokenId.toLowerCase()}`;
    if (closedKeys.has(key)) {
      if (typeof window !== "undefined") {
        console.log(
          `[Krystal CLOSED filter] dropping dust phantom: ` +
            `${p.protocol.name} ${p.chain} pool ${p.lpTokenId} ($${p.currentUsd.toFixed(2)})`,
        );
      }
      continue;
    }
    out.push(p);
  }
  return out;
}
