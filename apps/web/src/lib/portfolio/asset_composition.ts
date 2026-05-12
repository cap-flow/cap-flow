/**
 * Ручной состав «обёрточных» токенов / индексов.
 *
 * Зачем:
 *   У ряда токенов вся стоимость лежит в **корзине внутри**:
 *     - JLP (Jupiter Perps LP) ≈ SOL/ETH/WBTC/USDC в долях
 *     - GLP (GMX) ≈ ETH/WBTC/USDC/...
 *     - LST вроде stETH/wstETH/jitoSOL — фактически ETH или SOL
 *   В аналитике портфеля их нужно «развернуть» по underlying — иначе
 *   Структура портфеля и Стратегия (Stables/Волатильные) посчитаются
 *   неверно (всё уйдёт в одну строку JLP вместо 4 групп).
 *
 * Хранение — `localStorage`. Запись может быть:
 *   - **глобальной** (ключ = SYMBOL) — применяется ко всем вхождениям токена
 *     (например, JLP в кошельке + JLP в супплае позиции). Из Cap Wallet
 *     задаётся именно она.
 *   - **per-position** (ключ = `${scope}::${SYMBOL}`) — переопределяет
 *     состав именно для одной позиции (`scope` = positionOverrideKey).
 *     Из Активов в проектах / Открытых позиций сохраняется именно так,
 *     чтобы две позиции с одним символом не делили состав.
 *
 *   `expandByComposition(symbol, usd, compositions, scope?)` ищет сначала
 *   per-position ключ, потом глобальный.
 */

import { useCallback } from "react";
import { useLocalStorage } from "@/lib/useLocalStorage";

export interface AssetCompositionItem {
  /** Символ underlying-токена (SOL, ETH, WBTC, USDC, …). */
  symbol: string;
  /** Доля 0..1 (сумма по всем item'ам = 1). */
  share: number;
}

export type AssetComposition = AssetCompositionItem[];

/**
 * Map: ключ — wrapper-символ uppercase ИЛИ `${scope}::${SYMBOL}` для
 * per-position переопределения; значение — состав.
 */
export type AssetCompositions = Record<string, AssetComposition>;

const KEY = "capflow.asset_composition";

/** Нормализация символа для ключа (uppercase, ASCII T для юникодного ₮). */
export function normalizeCompositionKey(symbol: string): string {
  return symbol.toUpperCase().replace(/₮/g, "T").trim();
}

/** Финальный ключ хранения — с учётом scope (если задан). */
export function compositionStorageKey(symbol: string, scope?: string): string {
  const sym = normalizeCompositionKey(symbol);
  return scope ? `${scope}::${sym}` : sym;
}

export function useAssetCompositions(): [
  AssetCompositions,
  (symbol: string, composition: AssetComposition, scope?: string) => void,
  (symbol: string, scope?: string) => void,
] {
  const [compositions, setCompositions] = useLocalStorage<AssetCompositions>(
    KEY,
    {},
  );

  const setComposition = useCallback(
    (symbol: string, composition: AssetComposition, scope?: string) => {
      const key = compositionStorageKey(symbol, scope);
      setCompositions((prev) => {
        const next = { ...prev };
        // Сохраняем нормализованные шары (на случай если пользователь ввёл проценты).
        const sum = composition.reduce((s, x) => s + x.share, 0);
        const items =
          sum > 0
            ? composition.map((c) => ({
                symbol: normalizeCompositionKey(c.symbol),
                share: c.share / sum,
              }))
            : composition;
        next[key] = items;
        return next;
      });
    },
    [setCompositions],
  );

  const clearComposition = useCallback(
    (symbol: string, scope?: string) => {
      const key = compositionStorageKey(symbol, scope);
      setCompositions((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
    },
    [setCompositions],
  );

  return [compositions, setComposition, clearComposition];
}

/**
 * Развернуть USD-сумму wrapper-токена по underlying согласно составу.
 *
 * Поведение:
 *   - Если scope задан И есть scoped composition → раскладываем по нему
 *     (per-position состав, например USDC в Flash Trade = SOL+ETH+...).
 *   - Если scope задан, но scoped нет → возвращаем токен как есть (без
 *     fallback на global). Раньше fallback на global приводил к тому,
 *     что состав одной позиции применялся ко всем токенам с тем же
 *     символом по всему портфелю.
 *   - Если scope НЕ задан И есть global composition → разворачиваем по
 *     нему (legacy-совместимость для тех кто намеренно задал global).
 *   - Иначе → токен как есть.
 */
export function expandByComposition(
  symbol: string,
  usd: number,
  compositions: AssetCompositions,
  scope?: string,
): { symbol: string; usd: number }[] {
  const sym = normalizeCompositionKey(symbol);
  let comp: AssetComposition | undefined;
  if (scope) {
    // Per-position: ТОЛЬКО scoped, без fallback на global.
    comp = compositions[`${scope}::${sym}`];
  } else {
    // Без scope: используем global если есть.
    comp = compositions[sym];
  }
  if (!comp || comp.length === 0) {
    return [{ symbol, usd }];
  }
  return comp.map((c) => ({ symbol: c.symbol, usd: usd * c.share }));
}

/** Есть ли у этого (symbol, scope?) сохранённый состав. */
export function hasComposition(
  symbol: string,
  compositions: AssetCompositions,
  scope?: string,
): boolean {
  const sym = normalizeCompositionKey(symbol);
  if (scope && compositions[`${scope}::${sym}`]) return true;
  return Boolean(compositions[sym]);
}
