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
 * Stage 1 (этот файл): только openedAt + receiptAmount + openBlock.
 * Stage 2 (отдельно): OUT-side cost basis через deposit tx + historical price.
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
  type AlchemyTransfer,
} from "./alchemy_transfers";

export interface NonLpOpener {
  /** Unix seconds — block time первого receipt IN transfer. */
  openedAt: number;
  /** Block number deposit-tx (для Stage 2 on-chain price lookup). */
  openBlock: number;
  /** Tx hash открывающей транзакции. */
  txHash: string;
  /** Human-units кол-во receipt-токена в первом IN transfer. */
  receiptAmount: number;
}

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
  };
}

// ───────────────────────────────────────────────────────────────────────
//  Stage 1c — wallet-level resolver для staking/locked/lending позиций
//
//  Для них `lpTokenId` = адрес КОНТРАКТА (стейк/локер/маркет), а НЕ
//  transferable receipt-токен. Per-token fetch (Strategy A) возвращает
//  пусто. Здесь берём ВСЮ историю token-transfer'ов кошелька (1 запрос на
//  wallet+chain) и для каждого lpTokenId ищем самый ранний transfer,
//  который ТРОГАЕТ этот контракт:
//    - to == lpTokenId           → депозит токена в контракт (stake-in)
//    - from == lpTokenId         → receipt/reward пришёл из контракта
//    - contractAddress == lpTokenId → сам lpTokenId это ERC20 receipt (vault)
//  Берём earliest из всех matched transfers = момент открытия позиции.
// ───────────────────────────────────────────────────────────────────────

type WalletTransfer = {
  timeStamp: number;
  blockNumber: number;
  hash: string;
  from: string;
  to: string;
  contractAddress: string;
  value: string;
  tokenDecimal: number;
};

/**
 * Pure: из списка всех transfer'ов кошелька найти opener для каждого
 * lpTokenId. Тестируемо без сети.
 */
export function resolveOpenersFromTransfers(
  transfers: readonly WalletTransfer[],
  receiptTokens: readonly string[],
): Map<string, NonLpOpener> {
  const out = new Map<string, NonLpOpener>();
  // sort asc by time (defensive — API уже asc, но не доверяем)
  const sorted = [...transfers].sort((a, b) => a.timeStamp - b.timeStamp);
  for (const raw of receiptTokens) {
    const lp = raw.toLowerCase();
    const hit = sorted.find(
      (t) => t.to === lp || t.from === lp || t.contractAddress === lp,
    );
    if (!hit) continue;
    out.set(lp, {
      openedAt: hit.timeStamp,
      openBlock: hit.blockNumber,
      txHash: hit.hash,
      receiptAmount: Number(hit.value) / 10 ** hit.tokenDecimal,
    });
  }
  return out;
}

/**
 * Pure: из Alchemy transfers (без timestamp — только blockNumber) найти
 * для каждого lpTokenId earliest matched блок. Timestamp резолвится отдельно.
 * Возвращает Map<lpTokenId(lower), {blockNumber, ...}>.
 */
export function resolveOpenerBlocksFromAlchemy(
  transfers: readonly AlchemyTransfer[],
  receiptTokens: readonly string[],
): Map<string, { blockNumber: number; hash: string }> {
  const out = new Map<string, { blockNumber: number; hash: string }>();
  const sorted = [...transfers].sort((a, b) => a.blockNumber - b.blockNumber);
  for (const raw of receiptTokens) {
    const lp = raw.toLowerCase();
    const hit = sorted.find(
      (t) => t.to === lp || t.from === lp || t.contractAddress === lp,
    );
    if (!hit) continue;
    out.set(lp, { blockNumber: hit.blockNumber, hash: hit.hash });
  }
  return out;
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
  try {
    const transfers = await fetchEtherscanWalletTokenTransfers(chainCode, wallet);
    return resolveOpenersFromTransfers(transfers, receiptTokens);
  } catch (e) {
    if (!(e instanceof EtherscanChainNotSupportedError)) throw e;
    // Stage 1b: Etherscan не поддерживает chain → Alchemy fallback.
    if (!isAlchemyChainSupported(chainCode)) throw e;
    const transfers = await fetchAlchemyWalletTransfers(chainCode, wallet);
    const blocks = resolveOpenerBlocksFromAlchemy(transfers, receiptTokens);
    if (blocks.size === 0) return new Map();
    const tsByBlock = await fetchBlockTimestamps(
      chainCode,
      Array.from(blocks.values()).map((b) => b.blockNumber),
    );
    const out = new Map<string, NonLpOpener>();
    for (const [lp, b] of blocks) {
      const ts = tsByBlock.get(b.blockNumber);
      if (ts == null) continue;
      out.set(lp, {
        openedAt: ts,
        openBlock: b.blockNumber,
        txHash: b.hash,
        receiptAmount: 0,
      });
    }
    return out;
  }
}

export { EtherscanChainNotSupportedError };
