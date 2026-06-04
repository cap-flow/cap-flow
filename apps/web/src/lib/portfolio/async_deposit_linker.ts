/**
 * Re-export shim — async-deposit linker переехал в `@cap-flow/ucb` (A0),
 * чтобы серверный порт (ucb.service.computePositions) запускал ту же связку
 * Tx A (underlying out) ↔ Tx B (receipt mint), что и клиент. Клиентские
 * импорты (`@/lib/portfolio/async_deposit_linker`) не меняются.
 */
export {
  linkAsyncDeposits,
  getLpMarketKey,
} from "@cap-flow/ucb/async_deposit_linker";
