/**
 * Non-LP opener detector — определяет дату открытия (и receipt-amount) для
 * НЕ-V3-LP позиций (Lending / Yield / Staked / Locked / Deposit / Farming)
 * через первый IN-transfer receipt-токена на кошелёк.
 *
 * Зачем: Krystal индексирует только Uniswap/Pancake V3/V4 LP. Для остальных
 * протоколов дата открытия идёт из UCB `findFirstOpen()` по истории DeBank.
 * DeBank часто НЕ отдаёт open op:
 *   - Gnosis Safe `execTransaction` обёртки (DeBank не парсит) — POS-017 Lombard
 *   - mint receipt'а напрямую (нет «deposit» op'а) — POS-026 IPOR
 *   - позиция за горизонтом истории DeBank — POS-042 Locus (открыт 2023)
 *
 * Etherscan читает СЫРОЙ on-chain ERC20 transfer receipt-токена и отдаёт
 * точную дату + block, независимо от классификации DeBank. Это authoritative
 * источник `openedAt` (аналог Krystal для V3 LP, но через Etherscan для
 * произвольных протоколов).
 *
 * 2026-05-28 (MMaksimuk no-date audit): подтверждено на 3 протоколах —
 * Lombard (Safe), IPOR (mint-from-0), Locus (2023, за горизонтом DeBank).
 * Все 3 дали точную дату через first receipt IN transfer.
 *
 * B4 slice 2b: ЧИСТЫЕ резолверы (`resolveOpenersFromTransfers`,
 * `resolveOpenerBlocksFromAlchemy` + helpers/типы/константы) перенесены в
 * `@cap-flow/ucb/non_lp_opener_resolve`, чтобы сервер применял тот же override.
 * Здесь остаётся ТОЛЬКО fetch (Etherscan/Alchemy/DefiLlama) + re-export.
 */

import {
  EtherscanChainNotSupportedError,
  fetchEtherscanTokenTransfers,
  fetchEtherscanWalletTokenTransfers,
} from "../etherscan_logs";
import {
  fetchAlchemyWalletTransfers,
  fetchBlockTimestamps,
  isAlchemyChainSupported,
} from "./alchemy_transfers";
import { isUsdStable, startUsdFromPricedOut, startUsdFromStableOut } from "./cost_basis";
import {
  defillamaCoinKey,
  fetchHistoricalPrices,
  priceFromMapNearest,
} from "../defillama";

// NonLpOpener + the pure resolvers moved to @cap-flow/ucb (B4 slice 1 + 2b);
// re-exported so existing import sites + the opener_detector.test gate keep
// working. The fetch logic that PRODUCES a NonLpOpener stays here.
import type { NonLpOpener } from "@cap-flow/ucb/non_lp_opener";
import {
  resolveOpenerBlocksFromAlchemy,
  resolveOpenersFromTransfers,
} from "@cap-flow/ucb/non_lp_opener_resolve";
export type { NonLpOpener };
export { resolveOpenerBlocksFromAlchemy, resolveOpenersFromTransfers };

/**
 * Найти дату открытия non-LP позиции через первый IN-transfer receipt-токена.
 *
 * @returns NonLpOpener или null если:
 *   - нет IN transfer'ов (юзер не получал receipt — edge case)
 *   - chain не поддержан Etherscan free tier (BASE/SONIC) — throws
 *     EtherscanChainNotSupportedError, caller делает fallback/skip
 */
export async function detectNonLpOpener(args: {
  chainCode: string;
  receiptToken: string;
  wallet: string;
}): Promise<NonLpOpener | null> {
  const { chainCode, receiptToken, wallet } = args;
  if (!/^0x[0-9a-fA-F]{40}$/.test(receiptToken)) {
    throw new Error(`Invalid receipt token address: ${receiptToken}`);
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(wallet)) {
    throw new Error(`Invalid wallet address: ${wallet}`);
  }

  // fetchEtherscanTokenTransfers возвращает sort=asc (старые first).
  // apikey игнорируется (backend инжектит свой).
  const transfers = await fetchEtherscanTokenTransfers(
    chainCode,
    receiptToken,
    wallet,
    "",
  );
  if (transfers.length === 0) return null;

  const walletLower = wallet.toLowerCase();
  // Первый transfer где receipt пришёл НА кошелёк = момент открытия.
  // (Может быть несколько IN — берём самый ранний = открытие позиции.)
  const firstIn = transfers.find((t) => t.to === walletLower);
  if (!firstIn) return null;

  return {
    openedAt: firstIn.timeStamp,
    openBlock: firstIn.blockNumber,
    txHash: firstIn.hash,
    receiptAmount: Number(firstIn.value) / 10 ** firstIn.tokenDecimal,
    openedInTokens: [],
    startUsd: null,
  };
}

/**
 * Fetch + resolve openers для всех lpTokenId одного (wallet, chain) одним
 * запросом всей token-transfer истории.
 *
 * Primary: Etherscan (eth/arb/op/matic/bsc — pre-parsed transfers).
 * Fallback (Stage 1b): если Etherscan free не поддерживает chain (BASE/avax)
 * → Alchemy `getAssetTransfers` + `eth_getBlockByNumber` для timestamp.
 */
export async function detectNonLpOpenersForWalletChain(args: {
  chainCode: string;
  wallet: string;
  receiptTokens: readonly string[];
}): Promise<Map<string, NonLpOpener>> {
  const { chainCode, wallet, receiptTokens } = args;
  if (receiptTokens.length === 0) return new Map();
  const openers = await resolveOpenersViaProvider(chainCode, wallet, receiptTokens);
  // Stage 2b: для openers где startUsd null (volatile OUT) — historical price.
  await fillVolatileStartUsd(chainCode, openers);
  return openers;
}

/** Etherscan primary, Alchemy fallback — резолв openers без historical price. */
async function resolveOpenersViaProvider(
  chainCode: string,
  wallet: string,
  receiptTokens: readonly string[],
): Promise<Map<string, NonLpOpener>> {
  try {
    const transfers = await fetchEtherscanWalletTokenTransfers(chainCode, wallet);
    return resolveOpenersFromTransfers(transfers, receiptTokens, wallet);
  } catch (e) {
    if (!(e instanceof EtherscanChainNotSupportedError)) throw e;
    // Stage 1b: Etherscan не поддерживает chain → Alchemy fallback.
    if (!isAlchemyChainSupported(chainCode)) throw e;
    const transfers = await fetchAlchemyWalletTransfers(chainCode, wallet);
    const blocks = resolveOpenerBlocksFromAlchemy(transfers, receiptTokens, wallet);
    if (blocks.size === 0) return new Map();
    const tsByBlock = await fetchBlockTimestamps(
      chainCode,
      Array.from(blocks.values()).map((b) => b.blockNumber),
    );
    const out = new Map<string, NonLpOpener>();
    for (const [lp, b] of blocks) {
      const ts = tsByBlock.get(b.blockNumber);
      if (ts == null) continue;
      const grossStartUsd = startUsdFromStableOut(b.openedInTokens);
      out.set(lp, {
        openedAt: ts,
        openBlock: b.blockNumber,
        txHash: b.hash,
        receiptAmount: 0,
        openedInTokens: b.openedInTokens,
        startUsd:
          grossStartUsd != null ? grossStartUsd * b.receiptNetFraction : null,
        receiptNetFraction: b.receiptNetFraction,
      });
    }
    return out;
  }
}

/**
 * Stage 2b: для openers с `startUsd == null` но непустым OUT-side (значит
 * есть volatile-токены) — достаём историческую цену каждого volatile-токена
 * на момент депозита (`openedAt`) через DefiLlama и пересчитываем startUsd.
 * Мутирует `op.startUsd` in-place (объекты только что созданы → safe).
 * Fail-soft: нет цены → startUsd остаётся null, fallback не трогаем.
 */
async function fillVolatileStartUsd(
  chainCode: string,
  openers: Map<string, NonLpOpener>,
): Promise<void> {
  const pending: NonLpOpener[] = [];
  const requests: { coin: string; timestamp: number }[] = [];
  const seen = new Set<string>();
  for (const op of openers.values()) {
    if (op.startUsd != null) continue;
    if (op.openedInTokens.length === 0) continue;
    pending.push(op);
    for (const t of op.openedInTokens) {
      if (isUsdStable(t.symbol)) continue;
      const coin = defillamaCoinKey(chainCode, t.address, t.symbol);
      if (!coin) continue;
      const key = `${coin}|${op.openedAt}`;
      if (seen.has(key)) continue;
      seen.add(key);
      requests.push({ coin, timestamp: op.openedAt });
    }
  }
  if (requests.length === 0) return;

  const priceMap = await fetchHistoricalPrices(requests);
  for (const op of pending) {
    const priceByAddress = new Map<string, number>();
    let allPriced = true;
    for (const t of op.openedInTokens) {
      if (isUsdStable(t.symbol)) continue;
      const coin = defillamaCoinKey(chainCode, t.address, t.symbol);
      const px = coin
        ? priceFromMapNearest(priceMap, coin, op.openedAt)?.price ?? null
        : null;
      if (px == null) {
        allPriced = false;
        break;
      }
      priceByAddress.set(t.address.toLowerCase(), px);
    }
    if (!allPriced) continue;
    const startUsd = startUsdFromPricedOut(op.openedInTokens, priceByAddress);
    if (startUsd != null) op.startUsd = startUsd * (op.receiptNetFraction ?? 1);
  }
}

export { EtherscanChainNotSupportedError };
