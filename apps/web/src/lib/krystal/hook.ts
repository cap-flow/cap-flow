/**
 * React hook: загружает V3 LP позиции из Krystal Cloud для всех EVM-кошельков
 * портфеля и строит lookup-карту по `tokenId`.
 *
 * PR-K1 (cross-validation only). PR-K3 (future): станет primary source
 * для V3 current state когда `capflow.feature.krystalV3Primary` ON.
 *
 * Cost: 10 credits per wallet per fetch. Дедупим wallets и кешируем
 * в module scope (refresh при изменении wallet list или ручном refresh).
 */

import { useEffect, useMemo, useState } from "react";

import type { Loaded } from "@/components/data/LoadedWalletsProvider";
import { buildKrystalSummaryMap, type KrystalV3Summary } from "./adapter";
import { readKrystalCache, writeKrystalCache } from "./cache";
import { fetchKrystalUniswapV3Positions } from "./client";
import type { KrystalPosition } from "./types";

export interface KrystalV3State {
  /** key: tokenId (string). Merged across all wallets. */
  data: Map<string, KrystalV3Summary>;
  loading: boolean;
  error: string | null;
  /** Remaining credits после последнего fetch — UI surfacing. */
  creditsLeft: number | null;
}

const EMPTY: KrystalV3State = {
  data: new Map(),
  loading: false,
  error: null,
  creditsLeft: null,
};

/**
 * Backend upstream-proxy инжектит server-side `KRYSTAL_API_KEY`,
 * фронту никаких ключей не нужно. Hook gating: `enabled` flag + wallet list.
 */
export function useKrystalV3Positions(
  loaded: Loaded[],
  enabled: boolean,
): KrystalV3State {
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

  const [state, setState] = useState<KrystalV3State>(EMPTY);

  useEffect(() => {
    if (!enabled || wallets.length === 0) {
      setState(EMPTY);
      return;
    }
    const controller = new AbortController();
    let cancelled = false;

    // PR-K28 (2026-05-27): synchronous cache hydration ДО fetch loop.
    // Раньше state populated только после loop completion → если loop
    // aborts посередине (re-render / cleanup), state остаётся EMPTY
    // несмотря на presence cache в localStorage. Это вызывало 0/21
    // matched даже когда cache был полным.
    //
    // Теперь: setState с cached data сразу в начале effect → applyKrystalV3-
    // Override fires с актуальными данными даже если fetch loop не успеет.
    const initialFromCache: KrystalPosition[] = [];
    for (const w of wallets) {
      const cached = readKrystalCache(w);
      if (cached !== null) initialFromCache.push(...cached);
    }
    if (initialFromCache.length > 0) {
      setState({
        data: buildKrystalSummaryMap(initialFromCache),
        loading: true,
        error: null,
        creditsLeft: null,
      });
    } else {
      setState((s) => ({ ...s, loading: true, error: null }));
    }

    (async () => {
      const all: KrystalPosition[] = [];
      const errors: string[] = [];
      let creditsLeft: number | null = null;
      let cacheHits = 0;
      let fetched = 0;
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      for (const w of wallets) {
        if (cancelled) return;
        // PR-K4: try 24h localStorage cache first.
        const cached = readKrystalCache(w);
        if (cached !== null) {
          all.push(...cached);
          cacheHits++;
          continue;
        }
        // PR-K27 (2026-05-27 urgent fix to PR-K26): cache OPEN immediately
        // after success. Previous bug: AbortError / session expiration во
        // время CLOSED fetch ВЫКИДЫВАЛ из async function через `return` —
        // cache write block после CLOSED никогда не достигался → OPEN data
        // также теряются → все positions UNMATCHED.
        //
        // Fix: commit OPEN to cache СРАЗУ после OPEN success. Если CLOSED
        // потом fails/aborts — OPEN cache всё равно persisted, positions
        // будут matched в текущем render'е и в next refresh'e.
        //
        // Cache invariant: запись по wallet всегда содержит ВСЕ позиции этого
        // wallet'а (OPEN + CLOSED merged) — для PR-K26 это было true. Теперь:
        //   • после OPEN success → cache содержит только OPEN
        //   • после CLOSED success → cache rewritten с OPEN+CLOSED merged
        // Если CLOSED fails — cache остается с OPEN only. На следующий
        // refresh (24h позже или manual clear) hook попробует ещё раз.
        let openPositions: KrystalPosition[] = [];
        let walletHadAnyData = false;

        try {
          const openResult = await fetchKrystalUniswapV3Positions(w, "OPEN", {
            signal: controller.signal,
          });
          openPositions = openResult.data;
          walletHadAnyData = true;
          if (openResult.credits?.left != null) creditsLeft = openResult.credits.left;
          // Cache immediately — protects against later CLOSED failure
          if (!cancelled && openPositions.length > 0) {
            writeKrystalCache(w, openPositions);
            all.push(...openPositions);
            // PR-K28: also setState immediately — UI получает данные раньше
            // чем CLOSED завершится (или fails). Без этого CLOSED abort
            // exit'нула функцию до setState → cache есть, state пустой.
            if (!cancelled) {
              setState({
                data: buildKrystalSummaryMap(all),
                loading: true,
                error: null,
                creditsLeft,
              });
            }
          }
        } catch (e) {
          if ((e as Error).name === "AbortError") return;
          errors.push(`${w.slice(0, 6)}… OPEN: ${(e as Error).message}`);
        }
        if (cancelled) return;
        await sleep(400);

        try {
          const closedResult = await fetchKrystalUniswapV3Positions(w, "CLOSED", {
            signal: controller.signal,
          });
          const closedPositions = closedResult.data;
          if (closedResult.credits?.left != null) creditsLeft = closedResult.credits.left;
          // Merge OPEN + CLOSED, rewrite cache
          if (!cancelled && (openPositions.length > 0 || closedPositions.length > 0)) {
            const seen = new Set<string>();
            const merged: KrystalPosition[] = [];
            for (const pos of [...openPositions, ...closedPositions]) {
              const key = `${pos.chain?.id}-${pos.tokenAddress?.toLowerCase()}-${pos.tokenId}`;
              if (seen.has(key)) continue;
              seen.add(key);
              merged.push(pos);
            }
            writeKrystalCache(w, merged);
            // all уже содержит OPEN positions, добавляем CLOSED
            for (const pos of closedPositions) {
              const key = `${pos.chain?.id}-${pos.tokenAddress?.toLowerCase()}-${pos.tokenId}`;
              if (!openPositions.some(o => `${o.chain?.id}-${o.tokenAddress?.toLowerCase()}-${o.tokenId}` === key)) {
                all.push(pos);
              }
            }
            walletHadAnyData = true;
          }
        } catch (e) {
          if ((e as Error).name === "AbortError") {
            // OPEN cache may already be written — это OK, не теряем данные.
            return;
          }
          errors.push(`${w.slice(0, 6)}… CLOSED: ${(e as Error).message}`);
        }

        if (walletHadAnyData) {
          fetched++;
        }
        if (cancelled) return;
        // Throttle между wallets — снижает burst load на Krystal.
        await sleep(300);
      }
      if (cancelled) return;
      setState({
        data: buildKrystalSummaryMap(all),
        loading: false,
        error: errors.length > 0 ? errors.join("; ") : null,
        creditsLeft,
      });
      if (typeof window !== "undefined") {
        const openCount = all.filter(p => p.status !== "CLOSED").length;
        const closedCount = all.filter(p => p.status === "CLOSED").length;
        console.log(
          `[Krystal V3] ${all.length} positions ` +
            `(${openCount} OPEN, ${closedCount} CLOSED; ` +
            `${cacheHits} cache hits, ${fetched} fresh fetches) ` +
            `from ${wallets.length} wallets` +
            (creditsLeft != null ? ` (credits left: ${creditsLeft})` : "") +
            (errors.length > 0 ? ` — errors: ${errors.join("; ")}` : ""),
        );
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [wallets, enabled]);

  return state;
}
