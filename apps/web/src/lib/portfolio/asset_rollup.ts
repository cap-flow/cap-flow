/**
 * UCB E1: Unified asset view — sum WBTC/ETH/USDT/etc. across all wallets
 * (on-chain). Foundation для /assets page.
 *
 * Берёт `loadedById` (LiveSnapshot + LotTracker per wallet) и сворачивает
 * по `tokenFamily` — нормализованному имени актива (WETH≡ETH, USDT0≡USDT,
 * WBTC≡BTC и т.д.). Для каждого family получаем:
 *
 *   - Total amount, USD value, cost basis (sum lots) → unrealized PnL
 *   - Per-source breakdown (per wallet × chain)
 *
 * Сейчас CEX-side НЕ включён (нужно server-side CEX balance + cost basis
 * с D2/D3 wiring). Backlog в комментарии ниже.
 */

import { tokenFamily } from "./protocols";
import type { LotTracker } from "./lots/lot_tracker";
import type { LiveSnapshot, LiveTokenBalance } from "./live";

export interface AssetRollupSource {
  readonly kind: "wallet" | "cex";
  readonly sourceId: string;
  readonly sourceName: string;
  readonly chain: string;
  readonly amount: number;
  readonly usd: number;
  readonly costBasisUsd: number;
}

export interface AssetRollup {
  /** Normalized symbol (WETH→ETH, USDT0→USDT, WBTC→BTC, ...). */
  readonly family: string;
  readonly totalAmount: number;
  readonly totalUsd: number;
  readonly totalCostBasisUsd: number;
  /** unrealized PnL = totalUsd − totalCostBasisUsd. */
  readonly unrealizedPnlUsd: number;
  readonly unrealizedPnlPct: number;
  /** Per-wallet/CEX breakdown. */
  readonly sources: readonly AssetRollupSource[];
  /** WAC = totalCostBasisUsd / totalAmount. */
  readonly wac: number;
}

export interface LoadedInput {
  readonly walletId: string;
  readonly walletName: string;
  readonly live?: LiveSnapshot | undefined;
}

export interface BuildAssetRollupOptions {
  /**
   * Per-wallet cost basis lookup. Map<walletId, LotTracker>. Если null/
   * undefined для wallet, его cost basis считается 0 (display unknown).
   */
  readonly lotsByWallet?: Map<string, LotTracker>;
  /**
   * Минимальный USD value токена в одном источнике (фильтр dust). Default
   * $1 — мелочи спрячем, чтобы не засорять view.
   */
  readonly minSourceUsd?: number;
}

/**
 * Hide tokens which look like protocol receipts (aUSDC, GLV, etc.) — они
 * не имеют осмысленного "unified view" поскольку их amount привязан к
 * lending/LP позициям. Heuristic совпадает с `isLendingReceipt` +
 * `isProtocolToken`, но мы не имеем тех модулей под рукой — простой
 * symbol-pattern.
 */
function looksLikeReceipt(symbol: string): boolean {
  if (!symbol) return false;
  // Check on original (case-sensitive) — Aave receipts begin lowercase 'a':
  // "aUSDC", "aWETH", "aArbWETH". Compound: "cUSDC", "cDAI".
  if (/^[ac][A-Z]/.test(symbol)) return true;
  const u = symbol.toUpperCase();
  // GMX/GMSOL receipt patterns
  if (u.startsWith("GLV") || u.startsWith("GM")) return true;
  return false;
}

/**
 * Build the asset-rollup view. Pure function — input is loaded wallets +
 * lot trackers, output is sorted rollup array (newest-USD first).
 */
export function buildAssetRollup(
  inputs: readonly LoadedInput[],
  options: BuildAssetRollupOptions = {},
): AssetRollup[] {
  const minSourceUsd = options.minSourceUsd ?? 1;
  const byFamily = new Map<string, AssetRollupSource[]>();

  for (const input of inputs) {
    const tokens: LiveTokenBalance[] = input.live?.tokens ?? [];
    for (const t of tokens) {
      if (t.amount <= 0) continue;
      // Skip protocol receipts; they belong to position views.
      if (looksLikeReceipt(t.symbol)) continue;
      // Skip dust below threshold.
      if (t.usd < minSourceUsd) continue;

      const family = tokenFamily(t.symbol);
      if (!family) continue;

      // Cost basis: query lot tracker for this wallet + family.
      let costBasis = 0;
      const tracker = options.lotsByWallet?.get(input.walletId);
      if (tracker) {
        const wac = tracker.currentWac(input.walletId, t.symbol);
        if (wac != null && wac > 0) {
          costBasis = t.amount * wac;
        } else {
          // Falls back to current price если lot тракер не знает — это
          // означает "не покупал" (e.g. live-only из CoinStats).
          costBasis = 0;
        }
      }

      const source: AssetRollupSource = {
        kind: "wallet",
        sourceId: input.walletId,
        sourceName: input.walletName,
        chain: t.chain,
        amount: t.amount,
        usd: t.usd,
        costBasisUsd: costBasis,
      };
      const arr = byFamily.get(family) ?? [];
      arr.push(source);
      byFamily.set(family, arr);
    }
  }

  const rollups: AssetRollup[] = [];
  for (const [family, sources] of byFamily) {
    let totalAmount = 0;
    let totalUsd = 0;
    let totalCostBasisUsd = 0;
    for (const s of sources) {
      totalAmount += s.amount;
      totalUsd += s.usd;
      totalCostBasisUsd += s.costBasisUsd;
    }
    const unrealizedPnlUsd = totalUsd - totalCostBasisUsd;
    const unrealizedPnlPct =
      totalCostBasisUsd > 0 ? (unrealizedPnlUsd / totalCostBasisUsd) * 100 : 0;
    const wac = totalAmount > 0 ? totalCostBasisUsd / totalAmount : 0;
    rollups.push({
      family,
      totalAmount,
      totalUsd,
      totalCostBasisUsd,
      unrealizedPnlUsd,
      unrealizedPnlPct,
      sources: sources.sort((a, b) => b.usd - a.usd),
      wac,
    });
  }

  // Sort by total USD desc.
  rollups.sort((a, b) => b.totalUsd - a.totalUsd);
  return rollups;
}
