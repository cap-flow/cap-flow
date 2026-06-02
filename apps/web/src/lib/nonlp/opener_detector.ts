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
import {
  isUsdStable,
  startUsdFromPricedOut,
  startUsdFromStableOut,
  type OpenedInToken,
} from "./cost_basis";
import {
  defillamaCoinKey,
  fetchHistoricalPrices,
  priceFromMapNearest,
} from "../defillama";

// NonLpOpener moved to @cap-flow/ucb/non_lp_opener (B4 slice 1); re-exported so
// existing import sites keep working. The fetch logic that PRODUCES it stays here.
import type { NonLpOpener } from "@cap-flow/ucb/non_lp_opener";
export type { NonLpOpener };

/**
 * Доля receipt-токена, оставшаяся в позиции после возможных частичных выводов.
 * `Σ(receipt IN на wallet) − Σ(receipt OUT с wallet)` / `Σ(receipt IN)`.
 * Clamp [0,1]; если IN==0 → 1 (нет данных о receipt → не масштабируем).
 */
function receiptNetFraction(
  transfers: ReadonlyArray<{
    from: string;
    to: string;
    contractAddress: string;
    value: string;
    tokenDecimal: number;
  }>,
  lp: string,
  walletLower: string,
): number {
  let inAmt = 0;
  let outAmt = 0;
  for (const t of transfers) {
    if (t.contractAddress !== lp) continue;
    const amt = Number(t.value) / 10 ** t.tokenDecimal;
    if (!(amt > 0)) continue;
    if (t.to === walletLower) inAmt += amt;
    else if (t.from === walletLower) outAmt += amt;
  }
  if (!(inAmt > 0)) return 1;
  return Math.max(0, Math.min(1, (inAmt - outAmt) / inAmt));
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
    openedInTokens: [],
    startUsd: null,
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
  tokenSymbol: string;
};

/**
 * Stage 2c: deposit-tx = транзакция, в которой позиция ПОПОЛНЯЛАСЬ
 * (receipt пришёл на wallet ИЛИ токен ушёл В контракт). Reward-claim'ы и
 * withdraw'ы (receipt OUT / возврат из контракта) — НЕ депозиты.
 *
 *   deposit:  contract==lp && to==wallet   (receipt заминчен на wallet)
 *          || to==lp && from==wallet       (токен отправлен в контракт)
 *
 * Возвращает Set hash'ей всех deposit-tx для этого lpTokenId.
 */
function collectDepositHashes(
  transfers: readonly WalletTransfer[],
  lp: string,
  walletLower: string,
): Set<string> {
  const hashes = new Set<string>();
  for (const t of transfers) {
    const isDeposit =
      (t.contractAddress === lp && t.to === walletLower) ||
      (t.to === lp && t.from === walletLower);
    if (isDeposit) hashes.add(t.hash);
  }
  return hashes;
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * Окно поиска request-tx для async-deposit (GMX V2 GLV/GM, GMSOL, …) в секундах.
 * Эти протоколы исполняются в ДВУХ транзакциях: request (wallet отдаёт underlying
 * в deposit-vault) и fill (keeper минтит receipt). Mirror логики
 * `async_deposit_linker.ts` (там ±30с по DeBank-ops); здесь шире (10 мин) —
 * запас на лаг keeper'а + jitter block-time, при этом ограничено. Поиск
 * sends-only + nearest-preceding делает ложный пэйринг крайне маловероятным.
 */
const ASYNC_DEPOSIT_WINDOW_SEC = 600;
/** То же окно для Alchemy-пути (нет timestamp → блоки): ~10 мин на любой chain. */
const ASYNC_DEPOSIT_WINDOW_BLOCKS = 300;

/** Минимальный shape для async request↔fill пэйринга (общий для ETH-scan/Alchemy). */
interface AsyncPairLeg {
  hash: string;
  from: string;
  to: string;
  contractAddress: string;
  /** Упорядочивающий ключ: timeStamp (Etherscan) или blockNumber (Alchemy). */
  order: number;
}

/**
 * Stage 2c (async request/fill): для receipt-токенов, которые приходят в
 * ОТДЕЛЬНОЙ fill-tx от трат underlying (GMX V2 GLV/GM — POS-005), найти
 * hash'и request-tx, чтобы их OUT-сторона попала в cost basis.
 *
 * Сигнатура async-fill (а НЕ same-tx депозита типа IPOR):
 *   - receipt сминчен `from 0x0` на wallet (свежий mint), И
 *   - в той же tx wallet НЕ отдавал underlying (receives-only fill).
 * Для каждого такого fill'а берём БЛИЖАЙШИЙ предшествующий sends-only
 * (wallet отдал ≥1 не-receipt токен, ничего не получил — подпись request'а,
 * исключает swap'ы) tx в пределах окна. Его hash → deposit-hashes.
 *
 * Чисто: same-tx депозиты (OUT в fill-tx) сюда не попадают (guard sameTxHasOut),
 * mint не from-zero (Safe-internal) — тоже (не async-fill).
 */
function collectAsyncRequestHashes(
  legs: readonly AsyncPairLeg[],
  lp: string,
  walletLower: string,
  windowSpan: number,
): Set<string> {
  const hashesWithWalletIn = new Set<string>();
  const hashesWithWalletOut = new Set<string>();
  for (const t of legs) {
    if (t.to === walletLower) hashesWithWalletIn.add(t.hash);
    if (t.from === walletLower && t.contractAddress !== lp) {
      hashesWithWalletOut.add(t.hash);
    }
  }

  const out = new Set<string>();
  for (const mint of legs) {
    const isFreshMint =
      mint.contractAddress === lp &&
      mint.to === walletLower &&
      mint.from === ZERO_ADDRESS;
    if (!isFreshMint) continue;
    // same-tx депозит (OUT в той же tx) → классический путь уже покрыл.
    if (hashesWithWalletOut.has(mint.hash)) continue;

    let bestHash: string | undefined;
    let bestΔ = Infinity;
    for (const t of legs) {
      if (t.hash === mint.hash) continue;
      if (t.from !== walletLower || t.contractAddress === lp) continue; // wallet OUT
      const Δ = mint.order - t.order; // request предшествует fill'у
      if (Δ < 0 || Δ > windowSpan) continue;
      if (hashesWithWalletIn.has(t.hash)) continue; // sends-only (не swap)
      if (Δ < bestΔ) {
        bestΔ = Δ;
        bestHash = t.hash;
      }
    }
    if (bestHash) out.add(bestHash);
  }
  return out;
}

/**
 * Stage 2c: OUT-side по ВСЕМ deposit-tx (multi-deposit) — все transfers где
 * from==wallet в любой deposit-tx (юзер ОТДАЛ underlying). Aggregate по
 * contract+symbol. Receipt-токен (contract==lp) исключаем — он не «потрачен».
 * Если OUT не в deposit-tx (Safe-internal) — пусто.
 *
 * Многократные депозиты в один vault суммируются → startUsd = всё внесённое.
 */
function extractOpenedInTokens(
  transfers: readonly WalletTransfer[],
  depositHashes: ReadonlySet<string>,
  walletLower: string,
  lp: string,
): OpenedInToken[] {
  const bySym = new Map<string, OpenedInToken>();
  for (const t of transfers) {
    if (!depositHashes.has(t.hash)) continue;
    if (t.from !== walletLower) continue; // OUT only
    if (t.contractAddress === lp) continue; // receipt-токен не «потрачен»
    const amount = Number(t.value) / 10 ** t.tokenDecimal;
    if (!(amount > 0)) continue;
    const key = t.contractAddress;
    const prev = bySym.get(key);
    if (prev) prev.amount += amount;
    else bySym.set(key, { address: key, symbol: t.tokenSymbol, amount });
  }
  return Array.from(bySym.values());
}

/**
 * Pure: из списка всех transfer'ов кошелька найти opener для каждого
 * lpTokenId. Тестируемо без сети. `wallet` — для OUT-side extraction.
 */
export function resolveOpenersFromTransfers(
  transfers: readonly WalletTransfer[],
  receiptTokens: readonly string[],
  wallet: string,
): Map<string, NonLpOpener> {
  const out = new Map<string, NonLpOpener>();
  const walletLower = wallet.toLowerCase();
  // sort asc by time (defensive — API уже asc, но не доверяем)
  const sorted = [...transfers].sort((a, b) => a.timeStamp - b.timeStamp);
  for (const raw of receiptTokens) {
    const lp = raw.toLowerCase();
    const hit = sorted.find(
      (t) => t.to === lp || t.from === lp || t.contractAddress === lp,
    );
    if (!hit) continue;
    const depositHashes = collectDepositHashes(sorted, lp, walletLower);
    // async request/fill (GMX V2 GLV/GM): добираем hash'и request-tx, где
    // underlying ушёл в deposit-vault в отдельной tx от mint'а receipt'а.
    for (const h of collectAsyncRequestHashes(
      sorted.map((t) => ({ ...t, order: t.timeStamp })),
      lp,
      walletLower,
      ASYNC_DEPOSIT_WINDOW_SEC,
    )) {
      depositHashes.add(h);
    }
    const openedInTokens = extractOpenedInTokens(
      sorted,
      depositHashes,
      walletLower,
      lp,
    );
    const frac = receiptNetFraction(sorted, lp, walletLower);
    const grossStartUsd = startUsdFromStableOut(openedInTokens);
    out.set(lp, {
      openedAt: hit.timeStamp,
      openBlock: hit.blockNumber,
      txHash: hit.hash,
      receiptAmount: Number(hit.value) / 10 ** hit.tokenDecimal,
      openedInTokens,
      startUsd: grossStartUsd != null ? grossStartUsd * frac : null,
      receiptNetFraction: frac,
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
  wallet: string,
): Map<
  string,
  {
    blockNumber: number;
    hash: string;
    openedInTokens: OpenedInToken[];
    receiptNetFraction: number;
  }
> {
  const out = new Map<
    string,
    {
      blockNumber: number;
      hash: string;
      openedInTokens: OpenedInToken[];
      receiptNetFraction: number;
    }
  >();
  const walletLower = wallet.toLowerCase();
  const sorted = [...transfers].sort((a, b) => a.blockNumber - b.blockNumber);
  for (const raw of receiptTokens) {
    const lp = raw.toLowerCase();
    const hit = sorted.find(
      (t) => t.to === lp || t.from === lp || t.contractAddress === lp,
    );
    if (!hit) continue;
    // Stage 2c: OUT-side по ВСЕМ deposit-tx (multi-deposit), не только opener.
    const depositHashes = new Set<string>();
    for (const t of sorted) {
      const isDeposit =
        (t.contractAddress === lp && t.to === walletLower) ||
        (t.to === lp && t.from === walletLower);
      if (isDeposit) depositHashes.add(t.hash);
    }
    // async request/fill (GMX V2 GLV/GM): добираем request-tx по blockNumber.
    for (const h of collectAsyncRequestHashes(
      sorted.map((t) => ({
        hash: t.hash,
        from: t.from,
        to: t.to,
        contractAddress: t.contractAddress,
        order: t.blockNumber,
      })),
      lp,
      walletLower,
      ASYNC_DEPOSIT_WINDOW_BLOCKS,
    )) {
      depositHashes.add(h);
    }
    const bySym = new Map<string, OpenedInToken>();
    for (const t of sorted) {
      if (!depositHashes.has(t.hash) || t.from !== walletLower) continue;
      if (t.contractAddress === lp) continue; // receipt-токен не «потрачен»
      if (!(t.amount > 0)) continue;
      const prev = bySym.get(t.contractAddress);
      if (prev) prev.amount += t.amount;
      else bySym.set(t.contractAddress, { address: t.contractAddress, symbol: t.symbol, amount: t.amount });
    }
    // Stage 2d: partial-withdrawal netting (Alchemy amounts).
    let inAmt = 0;
    let outAmt = 0;
    for (const t of sorted) {
      if (t.contractAddress !== lp || !(t.amount > 0)) continue;
      if (t.to === walletLower) inAmt += t.amount;
      else if (t.from === walletLower) outAmt += t.amount;
    }
    const frac = inAmt > 0 ? Math.max(0, Math.min(1, (inAmt - outAmt) / inAmt)) : 1;
    out.set(lp, {
      blockNumber: hit.blockNumber,
      hash: hit.hash,
      openedInTokens: Array.from(bySym.values()),
      receiptNetFraction: frac,
    });
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
