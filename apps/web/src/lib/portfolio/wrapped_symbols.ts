/**
 * Canonical-symbol map for 1:1 wrapped tokens — client side.
 *
 * Зеркало `apps/api/src/modules/cex/wrapped-symbols.ts`. Используется
 * для matching между:
 *   - CEX-withdrawal'ом (server вернул `match.asset` = surface symbol,
 *     может быть `WBTC`/`WETH`/…)
 *   - on-chain `transfer_in`-symbol'ом в кошельке (зависит от сети)
 *
 * Scope: только 1:1 кастоди-обёртки. stETH/rETH сюда не входят (yield-
 * bearing). Pegged stables обрабатываются отдельным механизмом.
 *
 * Не делать общий нормализатор для всех `normalizeSymbol` в портфолио —
 * у lot_tracker / cost_basis_tracker своя семантика (on-chain WETH↔ETH),
 * расширение этой map'ой может изменить группировку lots.
 */
const WRAPPED_TO_BASE: ReadonlyMap<string, string> = new Map([
  ["WBTC", "BTC"],
  ["WETH", "ETH"],
  ["WBNB", "BNB"],
  ["WSOL", "SOL"],
  ["WAVAX", "AVAX"],
  ["WMATIC", "MATIC"],
  ["WPOL", "POL"],
  ["WFTM", "FTM"],
]);

export function canonicalSymbol(asset: string): string {
  const u = (asset ?? "").toUpperCase();
  return WRAPPED_TO_BASE.get(u) ?? u;
}
