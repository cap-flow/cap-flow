/**
 * Pure non-LP opener resolvers — UCB engine (B4 slice 2b).
 *
 * Moved verbatim from web `lib/nonlp/opener_detector.ts` (the FETCH that produces
 * the transfer arrays stays in the client hook / the B4 server fetch service).
 * These functions take already-fetched on-chain ERC20 transfers and resolve, for
 * each receipt token (`lpTokenId`), the opener: openedAt + block + OUT-side
 * `openedInTokens` + `startUsd` (stable Σ × $1) + `receiptNetFraction` (partial
 * withdrawal share). Both the client (`opener_detector.ts` re-exports these) and
 * the server (`non-lp-opener.source.ts`) share ONE implementation.
 *
 * The two entry points differ only by the ordering key available on the source:
 *   - resolveOpenersFromTransfers      → Etherscan transfers (have `timeStamp`)
 *   - resolveOpenerBlocksFromAlchemy   → Alchemy transfers (only `blockNumber`,
 *     timestamp resolved separately by the caller via eth_getBlockByNumber)
 */
import { isUsdStable, startUsdFromStableOut } from "./non_lp_cost_basis.js";
import type { NonLpOpener, OpenedInToken } from "./non_lp_opener.js";

/**
 * Etherscan-shaped wallet token transfer (pre-parsed, decimals known). The
 * server fetch service and the client both produce this shape.
 */
export interface WalletTransfer {
  timeStamp: number;
  blockNumber: number;
  hash: string;
  from: string;
  to: string;
  contractAddress: string;
  value: string;
  tokenDecimal: number;
  tokenSymbol: string;
}

/**
 * Alchemy-shaped transfer (no timestamp — only blockNumber + human-units amount).
 * Used on chains Etherscan free tier does not support (BASE/Avalanche).
 */
export interface AlchemyTransfer {
  blockNumber: number;
  hash: string;
  from: string; // lowercase
  to: string; // lowercase
  contractAddress: string; // lowercase
  /** Human-units amount (rawContract.value decoded). 0 if absent. */
  amount: number;
  /** Token symbol (asset field). */
  symbol: string;
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * Async-deposit request↔fill pairing window in SECONDS (Etherscan path). GMX V2
 * GLV/GM execute in TWO txs: request (wallet sends underlying to the deposit
 * vault) and fill (keeper mints the receipt). Mirrors `async_deposit_linker.ts`
 * (±30s by DeBank ops) but wider (10 min) — slack for keeper lag + block-time
 * jitter, still bounded. Sends-only + nearest-preceding makes false pairing
 * very unlikely.
 */
const ASYNC_DEPOSIT_WINDOW_SEC = 600;
/** Same window for the Alchemy path (no timestamp → blocks): ~10 min any chain. */
const ASYNC_DEPOSIT_WINDOW_BLOCKS = 300;

/** Minimal shape for async request↔fill pairing (shared Etherscan/Alchemy). */
interface AsyncPairLeg {
  hash: string;
  from: string;
  to: string;
  contractAddress: string;
  /** Ordering key: timeStamp (Etherscan) or blockNumber (Alchemy). */
  order: number;
}

/**
 * Owner-методика 2026-06-10 — ПОСЛЕДОВАТЕЛЬНАЯ WAC по конкретному
 * receipt-токену (testakk Artur GMX rebalance):
 *   - покупка: цена = уплаченный стейбл (номинал) / полученный receipt;
 *     WAC пересчитывается после каждой покупки;
 *   - продажа: списание по WAC, действующей НА МОМЕНТ продажи;
 *   - startUsd = остаток basis после всей истории.
 *
 * Это НЕ эквивалентно «gross × netFraction»: gross-вариант смешивает лоты
 * задним числом и нарушает сохранение денег (вложено ≠ списано + остаток),
 * на testakk 0x70d9 даёт +$166.80.
 *
 * Возвращает null если хоть одна покупка неоценима в стейблах (нестейбловая
 * оплата → Stage 2b исторические цены, как и раньше).
 */
export interface ReceiptFlowEvent {
  /** Ordering key: timeStamp (Etherscan) или blockNumber (Alchemy). */
  order: number;
  /** Receipt-токен пришёл на кошелёк в этой tx (mint/возврат). */
  receiptIn: number;
  /** Receipt-токен ушёл с кошелька (запрос на вывод/сжигание). */
  receiptOut: number;
  /** Σ стейблов, уплаченных в этой tx + её async-request паре (номинал). */
  stablePaid: number;
  /** В оплате есть нестейбл (ETH/WBTC/…) → последовательная оценка невозможна. */
  hasUnpriceablePayment: boolean;
}

export function sequentialReceiptStartUsd(
  events: readonly ReceiptFlowEvent[],
): number | null {
  const sorted = [...events].sort((a, b) => a.order - b.order);
  let qty = 0;
  let basis = 0;
  let sawBuy = false;
  for (const e of sorted) {
    // Сначала расход (для tx где есть и in и out — консервативно).
    if (e.receiptOut > 0 && qty > 0) {
      const take = Math.min(e.receiptOut, qty);
      const wac = basis / qty;
      qty -= take;
      basis -= take * wac;
    }
    if (e.receiptIn > 0) {
      if (e.hasUnpriceablePayment || !(e.stablePaid > 0)) return null;
      qty += e.receiptIn;
      basis += e.stablePaid;
      sawBuy = true;
    }
  }
  if (!sawBuy) return null;
  return basis > 0 ? basis : 0;
}

/**
 * Receipt-token share remaining in the position after possible partial
 * withdrawals: `Σ(receipt IN to wallet) − Σ(receipt OUT from wallet)) / Σ(IN)`.
 * Clamp [0,1]; if IN==0 → 1 (no receipt data → do not scale).
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
 * Deposit-tx = a tx where the position was FUNDED (receipt arrived to wallet OR a
 * token went INTO the contract). Reward-claims / withdraws (receipt OUT / return
 * from contract) are NOT deposits.
 *
 *   deposit:  contract==lp && to==wallet   (receipt minted to wallet)
 *          || to==lp && from==wallet       (token sent into the contract)
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

/**
 * Async request/fill: for receipt tokens that arrive in a SEPARATE fill-tx from
 * the underlying spend (GMX V2 GLV/GM — POS-005), find the request-tx hashes so
 * their OUT-side enters the cost basis.
 *
 * Async-fill signature (NOT a same-tx deposit like IPOR):
 *   - receipt minted `from 0x0` to wallet (fresh mint), AND
 *   - in that same tx the wallet did NOT spend underlying (receives-only fill).
 * For each such fill take the NEAREST PRECEDING sends-only (wallet spent ≥1
 * non-receipt token, received nothing — request signature, excludes swaps) tx
 * within the window. Its hash → deposit-hashes.
 */
function collectAsyncRequestPairs(
  legs: readonly AsyncPairLeg[],
  lp: string,
  walletLower: string,
  windowSpan: number,
): Map<string, string> {
  const hashesWithWalletIn = new Set<string>();
  const hashesWithWalletOut = new Set<string>();
  for (const t of legs) {
    if (t.to === walletLower) hashesWithWalletIn.add(t.hash);
    if (t.from === walletLower && t.contractAddress !== lp) {
      hashesWithWalletOut.add(t.hash);
    }
  }

  /** mint(fill)-tx hash → request-tx hash. */
  const pairs = new Map<string, string>();
  for (const mint of legs) {
    const isFreshMint =
      mint.contractAddress === lp &&
      mint.to === walletLower &&
      mint.from === ZERO_ADDRESS;
    if (!isFreshMint) continue;
    // same-tx deposit (OUT in the same tx) → classic path already covered it.
    if (hashesWithWalletOut.has(mint.hash)) continue;

    let bestHash: string | undefined;
    let bestΔ = Infinity;
    for (const t of legs) {
      if (t.hash === mint.hash) continue;
      if (t.from !== walletLower || t.contractAddress === lp) continue; // wallet OUT
      const Δ = mint.order - t.order; // request precedes the fill
      if (Δ < 0 || Δ > windowSpan) continue;
      if (hashesWithWalletIn.has(t.hash)) continue; // sends-only (not a swap)
      if (Δ < bestΔ) {
        bestΔ = Δ;
        bestHash = t.hash;
      }
    }
    if (bestHash) pairs.set(mint.hash, bestHash);
  }
  return pairs;
}

function collectAsyncRequestHashes(
  legs: readonly AsyncPairLeg[],
  lp: string,
  walletLower: string,
  windowSpan: number,
): Set<string> {
  const out = new Set(
    collectAsyncRequestPairs(legs, lp, walletLower, windowSpan).values(),
  );
  return out;
}

/**
 * OUT-side over ALL deposit-tx (multi-deposit) — every transfer where from==wallet
 * in a deposit-tx (the user SPENT underlying). Aggregate by contract+symbol. The
 * receipt token (contract==lp) is excluded — it is not "spent". If OUT is not in
 * a deposit-tx (Safe-internal) → empty. Multiple deposits into one vault sum →
 * startUsd = everything contributed.
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
    if (t.contractAddress === lp) continue; // receipt token not "spent"
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
 * Pure: from a wallet's full transfer list, find the opener for each receipt
 * token (`lpTokenId`). Testable without the network. `wallet` is needed for
 * OUT-side extraction.
 */
export function resolveOpenersFromTransfers(
  transfers: readonly WalletTransfer[],
  receiptTokens: readonly string[],
  wallet: string,
): Map<string, NonLpOpener> {
  const out = new Map<string, NonLpOpener>();
  const walletLower = wallet.toLowerCase();
  // sort asc by time (defensive — API is already asc, but do not trust it)
  const sorted = [...transfers].sort((a, b) => a.timeStamp - b.timeStamp);
  for (const raw of receiptTokens) {
    const lp = raw.toLowerCase();
    const hit = sorted.find(
      (t) => t.to === lp || t.from === lp || t.contractAddress === lp,
    );
    if (!hit) continue;
    const depositHashes = collectDepositHashes(sorted, lp, walletLower);
    // async request/fill (GMX V2 GLV/GM): request-tx hashes + per-mint пары,
    // чтобы стоимость каждой покупки легла на СВОЙ mint (sequential WAC).
    const requestPairs = collectAsyncRequestPairs(
      sorted.map((t) => ({ ...t, order: t.timeStamp })),
      lp,
      walletLower,
      ASYNC_DEPOSIT_WINDOW_SEC,
    );
    for (const h of requestPairs.values()) {
      depositHashes.add(h);
    }
    const openedInTokens = extractOpenedInTokens(
      sorted,
      depositHashes,
      walletLower,
      lp,
    );
    const frac = receiptNetFraction(sorted, lp, walletLower);

    // Owner-методика 2026-06-10: последовательная per-token WAC вместо
    // «gross × netFraction» (gross смешивает лоты задним числом; testakk
    // 0x70d9: $6 075.55 вместо корректных $5 908.92).
    const byTx = new Map<string, ReceiptFlowEvent>();
    const txOf = (h: string, order: number): ReceiptFlowEvent => {
      let e = byTx.get(h);
      if (!e) {
        e = { order, receiptIn: 0, receiptOut: 0, stablePaid: 0, hasUnpriceablePayment: false };
        byTx.set(h, e);
      }
      return e;
    };
    const paymentOf = (hash: string): { stable: number; unpriceable: boolean } => {
      let stable = 0;
      let unpriceable = false;
      for (const t of sorted) {
        if (t.hash !== hash || t.from !== walletLower) continue;
        if (t.contractAddress === lp) continue; // receipt не «расход»
        const amt = Number(t.value) / 10 ** t.tokenDecimal;
        if (!(amt > 0)) continue;
        if (isUsdStable(t.tokenSymbol)) stable += amt;
        else unpriceable = true; // нестейбл-оплата → Stage 2b
      }
      return { stable, unpriceable };
    };
    for (const t of sorted) {
      if (t.contractAddress !== lp) continue;
      const amt = Number(t.value) / 10 ** t.tokenDecimal;
      if (!(amt > 0)) continue;
      if (t.to === walletLower) {
        const e = txOf(t.hash, t.timeStamp);
        e.receiptIn += amt;
        const own = paymentOf(t.hash);
        const req = requestPairs.has(t.hash)
          ? paymentOf(requestPairs.get(t.hash)!)
          : { stable: 0, unpriceable: false };
        e.stablePaid = own.stable + req.stable;
        e.hasUnpriceablePayment = own.unpriceable || req.unpriceable;
      } else if (t.from === walletLower) {
        txOf(t.hash, t.timeStamp).receiptOut += amt;
      }
    }
    const seqStartUsd = sequentialReceiptStartUsd([...byTx.values()]);

    out.set(lp, {
      openedAt: hit.timeStamp,
      openBlock: hit.blockNumber,
      txHash: hit.hash,
      receiptAmount: Number(hit.value) / 10 ** hit.tokenDecimal,
      openedInTokens,
      startUsd: seqStartUsd,
      receiptNetFraction: frac,
    });
  }
  return out;
}

/**
 * Pure: from Alchemy transfers (no timestamp — only blockNumber) find the earliest
 * matched block for each receipt token. Timestamp is resolved separately by the
 * caller. Returns Map<lpTokenId(lower), {blockNumber, ...}>.
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
    // OUT-side over ALL deposit-tx (multi-deposit), not just the opener.
    const depositHashes = new Set<string>();
    for (const t of sorted) {
      const isDeposit =
        (t.contractAddress === lp && t.to === walletLower) ||
        (t.to === lp && t.from === walletLower);
      if (isDeposit) depositHashes.add(t.hash);
    }
    // async request/fill (GMX V2 GLV/GM): add request-tx by blockNumber.
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
      if (t.contractAddress === lp) continue; // receipt token not "spent"
      if (!(t.amount > 0)) continue;
      const prev = bySym.get(t.contractAddress);
      if (prev) prev.amount += t.amount;
      else
        bySym.set(t.contractAddress, {
          address: t.contractAddress,
          symbol: t.symbol,
          amount: t.amount,
        });
    }
    // partial-withdrawal netting (Alchemy amounts).
    let inAmt = 0;
    let outAmt = 0;
    for (const t of sorted) {
      if (t.contractAddress !== lp || !(t.amount > 0)) continue;
      if (t.to === walletLower) inAmt += t.amount;
      else if (t.from === walletLower) outAmt += t.amount;
    }
    const frac =
      inAmt > 0 ? Math.max(0, Math.min(1, (inAmt - outAmt) / inAmt)) : 1;
    out.set(lp, {
      blockNumber: hit.blockNumber,
      hash: hit.hash,
      openedInTokens: Array.from(bySym.values()),
      receiptNetFraction: frac,
    });
  }
  return out;
}
