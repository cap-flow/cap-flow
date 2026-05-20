/**
 * Canonical-symbol map for 1:1 wrapped tokens on CEX side.
 *
 * Why
 * ───
 * Биржи торгуют unwrapped (`BTC/USDT`, `ETH/USDT`, …), а при выводе на
 * EVM-сеть сами заворачивают в `WBTC` / `WETH`. Cost-basis-service ведёт
 * WAC-pool строго по asset name → withdrawal `WBTC` уходит из пустого
 * пула (`unknown` source) даже когда на бирже куплен `BTC` за USDT.
 *
 * Решение: внутри пайплайна всегда читать/писать пул по каноническому
 * символу (unwrapped). Withdrawal-row на выходе сервиса сохраняет
 * исходный asset (`WBTC`) — это видит UI, on-chain matching, etc.
 *
 * Scope
 * ─────
 * Только "1:1 кастоди-обёртки" (биржа гарантирует курс 1:1 при wrap/
 * unwrap). Liquid-staking derivatives (stETH, rETH, cbETH) сюда НЕ
 * входят: они накапливают yield → разный cost basis. Pegged stables
 * (USDT/USDC) уже обрабатываются через `isStableSymbol`.
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

/**
 * Returns canonical (unwrapped) symbol for cost-basis pool routing.
 * Idempotent: `canonicalSymbol("BTC")` → `"BTC"`.
 */
export function canonicalSymbol(asset: string): string {
  const u = asset.toUpperCase();
  return WRAPPED_TO_BASE.get(u) ?? u;
}
