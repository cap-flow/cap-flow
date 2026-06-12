/**
 * Точечная фильтрация dust-фантомов: V3 LP позиции в пулах, где Krystal знает,
 * что NFT уже CLOSED (liquidity=0), а DeBank live snapshot продолжает
 * показывать $0.5–$5 остатков (uncollected fees / pricing residual). Без
 * фильтра такие строки выглядят как «провалившиеся позиции» с −90% PnL.
 *
 * Чистое ядро вынесено из apps/web/src/lib/krystal/closed_pools_hook.ts
 * (порт V3-операций в серверный движок, 2026-06-12) — React-хук остался в
 * web и re-export'ит фильтр отсюда. Сервер получает closedPoolKeys от
 * KrystalV3Source (per-chain CLOSED fetch, fail-soft).
 *
 * Защитные guards (всё одновременно — иначе НЕ фильтруем):
 *   1. `isV3LpProtocol(protocol.name) === true`
 *   2. Нет matchedV3TokenId (наша pipeline нашла активный NFT → живая, не трогаем)
 *   3. `lpTokenId` (pool address) присутствует
 *   4. `currentUsd < $50` — dust threshold (не скрываем реальные позиции при
 *      ложном CLOSED от Krystal)
 *   5. Ключ `${wallet}|${chainCode}|${poolAddress}` есть в closedKeys
 *
 * Если closedKeys пуст (fetch не сработал / нет кредитов) — input без изменений
 * (fail-soft).
 */

export interface ClosedDustFilterResult<P> {
  positions: P[];
  /** Отброшенные dust-фантомы — для логов/trace (раньше console.log в web). */
  dropped: P[];
}

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
  return filterClosedDustPositionsWithDropped(
    positions,
    walletAddressById,
    closedKeys,
    isV3LpProtocol,
    dustThresholdUsd,
  ).positions;
}

/** Вариант с отчётом об отброшенных — для серверного trace. Та же логика. */
export function filterClosedDustPositionsWithDropped<
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
): ClosedDustFilterResult<P> {
  if (closedKeys.size === 0) return { positions: positions.slice(), dropped: [] };
  const out: P[] = [];
  const dropped: P[] = [];
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
      dropped.push(p);
      continue;
    }
    out.push(p);
  }
  return { positions: out, dropped };
}
