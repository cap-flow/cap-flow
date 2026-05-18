/**
 * UCB A2 (Layer 2): server-side cross-chain self-transfer matching.
 *
 * Когда юзер бриджит USDT с eth wallet'а A на arb wallet B (через Across /
 * Stargate / Hop), tx_hashes на двух сторонах РАЗНЫЕ — Layer 1 (exact
 * tx_hash join) их не поймает. Используем heuristic:
 *   - Время совпадения: ±60min
 *   - Семейство токена: USDT ↔ USD₮0, ETH ↔ WETH через `tokenFamily`
 *   - Допуск амаунту: ±5% (volatile) / ±10% (stable — bridge fees бывают
 *     огромными)
 *
 * Логика портирована из `apps/web/src/lib/portfolio/internal_transfers.ts`
 * (Layer 2 client heuristic). Server-side версия:
 *   1. Persistent (не перезапускается на каждый browser refresh)
 *   2. Cross-device — если у юзера сессия на desktop сделала bridge, а
 *      mobile session видит только destination wallet, server уже знает
 *      об out-стороне.
 *   3. Не зависит от того, какие wallets сейчас гидратированы в
 *      `loadedById` (client может видеть только подмножество).
 *
 * Same-wallet bridges (lex 2 eth → lex 2 arb) — НЕ обрабатываются здесь:
 * они уже классифицированы как `bridge_in`/`bridge_out` и cost basis
 * inheritance внутри одного wallet'а делает классификатор. Этот матчер —
 * только для ДВУХ разных wallets.
 */

const TIME_WINDOW_SEC = 60 * 60; // ±60 минут
const AMOUNT_TOL_VOLATILE = 0.05; // ±5%
const AMOUNT_TOL_STABLE = 0.1; // ±10%

const STABLE_SYMBOLS = new Set([
  "USDT",
  "USDC",
  "DAI",
  "PYUSD",
  "FDUSD",
  "USDP",
  "TUSD",
  "LUSD",
  "BUSD",
  "FRAX",
  "CRVUSD",
]);

/**
 * Нормализация символа в "семейство": USDT0 → USDT, WETH → ETH, …
 *
 * **Внимание (UCB D4)**: эта функция держит **более узкий** список
 * чем client `tokenFamily` в `protocols.ts`. Client фолдит LSTs
 * (stETH/rETH/cbETH → ETH) и savings stables (sDAI → DAI) для
 * **display rollup**. Здесь — только true 1:1 wrappers, потому что:
 *
 *   - Internal-transfer matcher сравнивает amount + time для пары
 *     `out → in`. stETH/rETH принципиально другие токены (yield-bearing
 *     claims, premium/discount). Фолдинг привёл бы к false matches.
 *
 * Если user реально bridges stETH → ETH (rare), это будет помечено
 * вручную через A3 annotations.
 */
export function tokenFamily(symbol: string): string {
  if (!symbol) return "";
  let s = symbol.toUpperCase().trim();
  s = s.replace(/₮/g, "T");
  s = s.replace(/\.[A-Z0-9]+$/, "");
  s = s.replace(/(?<=[A-Z])0+$/, "");
  if (s === "WETH") return "ETH";
  if (s === "WBTC" || s === "TBTC" || s === "CBBTC") return "BTC";
  if (s === "WSOL") return "SOL";
  if (s === "WBNB") return "BNB";
  if (s === "WMATIC") return "MATIC";
  if (s === "WAVAX") return "AVAX";
  return s;
}

export interface MovementRow {
  readonly walletId: string;
  readonly chain: string;
  readonly txHash: string;
  readonly opType: string;
  /** Unix seconds. */
  readonly opTimeSec: number;
  readonly direction: "in" | "out";
  readonly symbol: string;
  readonly amount: number;
  readonly usdPerUnit: number | null;
  readonly raw: unknown;
}

export interface MatchedCrossChainPair {
  readonly outTxHash: string;
  readonly inTxHash: string;
  readonly outChain: string;
  readonly inChain: string;
  readonly outWalletId: string;
  readonly inWalletId: string;
  readonly symbol: string;
  readonly outAmount: number;
  readonly inAmount: number;
  readonly feeUsd: number;
  readonly outRaw: unknown;
  readonly inRaw: unknown;
  /** UCB A5: needed для cycle-detection (chronological ordering). */
  readonly outOpTimeSec: number;
  readonly inOpTimeSec: number;
}

/**
 * Извлечь movements из `chain_operations.raw` JSONB.
 *
 * Каждая ClassifiedOp может содержать несколько movements (swap = OUT
 * один token + IN другой). Для internal-transfer detection нас интересуют
 * **первые** in/out movements нужного направления — это типичная shape
 * `transfer_*` / `bridge_*` / `*_fiat` ops.
 *
 * Возвращает плоский массив, пригодный для матчера.
 */
export function extractMovements(
  rows: ReadonlyArray<{
    readonly walletId: string;
    readonly chain: string;
    readonly txHash: string;
    readonly opType: string;
    readonly opTime: Date;
    readonly raw: unknown;
  }>,
): MovementRow[] {
  const out: MovementRow[] = [];
  for (const r of rows) {
    const opTimeSec = Math.floor(r.opTime.getTime() / 1000);
    const raw = r.raw as { movement?: unknown };
    const movs = Array.isArray(raw?.movement) ? raw.movement : [];
    for (const m of movs) {
      const mov = m as {
        direction?: string;
        symbol?: string;
        amount?: number;
        usd?: number;
      };
      if (mov.direction !== "in" && mov.direction !== "out") continue;
      const amount = Number(mov.amount);
      if (!Number.isFinite(amount) || amount <= 0) continue;
      const symbol = (mov.symbol ?? "").toString();
      if (!symbol) continue;
      const usd = Number(mov.usd);
      const usdPerUnit =
        Number.isFinite(usd) && amount > 0 ? usd / amount : null;
      out.push({
        walletId: r.walletId,
        chain: r.chain,
        txHash: r.txHash,
        opType: r.opType,
        opTimeSec,
        direction: mov.direction,
        symbol,
        amount,
        usdPerUnit,
        raw: r.raw,
      });
    }
  }
  return out;
}

/**
 * Парный детектор: для каждого `in`-movement ищем подходящий `out` из
 * РАЗНОГО wallet'а. Логика — отзеркаленный client `findInternalTransferPairs`
 * с поправкой на server-side data model (movements уже разнесены по
 * direction).
 *
 * Skip-ы:
 *   - `out.walletId === in.walletId` — same-wallet bridges handled
 *     classifier'ом
 *   - tx_hash equality — это уже Layer 1 (`findCrossWalletSameHashPairs`),
 *     не дублируем
 *
 * Возвращает массив пар, отсортированных по времени (newest first).
 */
export function matchCrossChainPairs(
  movements: ReadonlyArray<MovementRow>,
): MatchedCrossChainPair[] {
  const outs = movements.filter((m) => m.direction === "out");
  const ins = movements.filter((m) => m.direction === "in");
  if (outs.length === 0 || ins.length === 0) return [];

  // Skip-set: уже использованные tx_hashes (один out может пэйрнуть с
  // одной in, не больше).
  const usedOutHashes = new Set<string>();
  const usedInHashes = new Set<string>();
  const pairs: MatchedCrossChainPair[] = [];

  // Сортируем in newest-first для детерминированности.
  const inSorted = [...ins].sort((a, b) => b.opTimeSec - a.opTimeSec);

  for (const inMov of inSorted) {
    if (usedInHashes.has(inMov.txHash)) continue;
    const inFamily = tokenFamily(inMov.symbol);
    const isStable = STABLE_SYMBOLS.has(inFamily);
    const tol = isStable ? AMOUNT_TOL_STABLE : AMOUNT_TOL_VOLATILE;

    const candidate = outs.find((o) => {
      if (usedOutHashes.has(o.txHash)) return false;
      if (o.walletId === inMov.walletId) return false;
      if (o.txHash === inMov.txHash) return false; // L1 territory
      if (Math.abs(o.opTimeSec - inMov.opTimeSec) > TIME_WINDOW_SEC) return false;
      if (tokenFamily(o.symbol) !== inFamily) return false;
      const diff = Math.abs(o.amount - inMov.amount) / Math.max(o.amount, 1e-9);
      return diff <= tol;
    });
    if (!candidate) continue;

    usedOutHashes.add(candidate.txHash);
    usedInHashes.add(inMov.txHash);
    const feeUsd =
      candidate.usdPerUnit != null
        ? (candidate.amount - inMov.amount) * candidate.usdPerUnit
        : 0;
    pairs.push({
      outTxHash: candidate.txHash,
      inTxHash: inMov.txHash,
      outChain: candidate.chain,
      inChain: inMov.chain,
      outWalletId: candidate.walletId,
      inWalletId: inMov.walletId,
      symbol: inMov.symbol,
      outAmount: candidate.amount,
      inAmount: inMov.amount,
      feeUsd,
      outRaw: candidate.raw,
      inRaw: inMov.raw,
      outOpTimeSec: candidate.opTimeSec,
      inOpTimeSec: inMov.opTimeSec,
    });
  }

  return pairs;
}

// ─── UCB A5: cycle-detection (A→B→A self-bridge loops) ─────────────────

/** Окно для замыкания цикла: ±7 дней между первой OUT и последней IN. */
const CYCLE_TIME_WINDOW_SEC = 7 * 24 * 60 * 60;

/**
 * UCB A5: цикл «self-bridge loop». Пользователь дёрнул deposit из wallet A,
 * получил на wallet B, потом перевёл обратно A. Net economic effect:
 *   - Cost basis тот же (минус fees)
 *   - Нет реального движения капитала за периметр user'а
 *   - Должно быть «свернуто» в один логический ноп для UCB analytics
 *     (otherwise каждый pair выглядит как fresh transfer без cost basis)
 *
 * v1: только 2-hop cycles A→B→A. Multi-hop (A→B→C→A) — backlog A5.2.
 */
export interface SelfBridgeCycle {
  /** Wallet, который начал и закончил петлю (== legA.outWalletId == legB.inWalletId). */
  readonly originWalletId: string;
  /** Wallet через который шла петля (== legA.inWalletId == legB.outWalletId). */
  readonly hopWalletId: string;
  /** Token family (canonical, через `tokenFamily`). */
  readonly family: string;
  /** Первый leg — отъезд из origin. */
  readonly legA: MatchedCrossChainPair;
  /** Второй leg — возврат в origin. */
  readonly legB: MatchedCrossChainPair;
  /** Σ fee (loss to bridge fees) за весь цикл. */
  readonly totalFeeUsd: number;
  /** Время между первой OUT и последней IN. */
  readonly durationSec: number;
}

/**
 * Найти A→B→A петли среди уже-detected internal transfer pairs.
 *
 * Алгоритм:
 *   1. Группируем pairs по family.
 *   2. В каждой family сортируем по `legA out time`.
 *   3. Для каждой пары P1 ищем последующую P2 с reversed wallets и
 *      timestamp в окне ±7d.
 *   4. Greedy match: P1+P2 формируют cycle, оба marked used.
 *
 * Идемпотент: повторный вызов на тех же pairs даёт ровно те же cycles.
 */
export function detectSelfBridgeCycles(
  pairs: ReadonlyArray<MatchedCrossChainPair>,
): SelfBridgeCycle[] {
  if (pairs.length < 2) return [];

  // Группа по family.
  const byFamily = new Map<string, MatchedCrossChainPair[]>();
  for (const p of pairs) {
    const f = tokenFamily(p.symbol);
    if (!f) continue;
    const arr = byFamily.get(f) ?? [];
    arr.push(p);
    byFamily.set(f, arr);
  }

  const cycles: SelfBridgeCycle[] = [];
  const usedKeys = new Set<string>();
  const pairKey = (p: MatchedCrossChainPair): string =>
    `${p.outTxHash}|${p.inTxHash}`;

  for (const [family, list] of byFamily) {
    // Сортируем по времени отъезда (legA.outOpTimeSec): хронологический порядок.
    const sorted = [...list].sort((a, b) => a.outOpTimeSec - b.outOpTimeSec);
    for (let i = 0; i < sorted.length; i++) {
      const legA = sorted[i]!;
      if (usedKeys.has(pairKey(legA))) continue;

      // Поиск legB: outWallet=legA.in, inWallet=legA.out, после legA.in.
      let legB: MatchedCrossChainPair | null = null;
      for (let j = i + 1; j < sorted.length; j++) {
        const cand = sorted[j]!;
        if (usedKeys.has(pairKey(cand))) continue;
        if (cand.outWalletId !== legA.inWalletId) continue;
        if (cand.inWalletId !== legA.outWalletId) continue;
        // Возврат должен быть ПОСЛЕ in legA (т.е. user успел получить).
        if (cand.outOpTimeSec < legA.inOpTimeSec) continue;
        // Длина петли ограничена окном.
        if (cand.inOpTimeSec - legA.outOpTimeSec > CYCLE_TIME_WINDOW_SEC) {
          break; // sorted by time — дальше всё хуже
        }
        legB = cand;
        break;
      }
      if (!legB) continue;

      usedKeys.add(pairKey(legA));
      usedKeys.add(pairKey(legB));
      cycles.push({
        originWalletId: legA.outWalletId,
        hopWalletId: legA.inWalletId,
        family,
        legA,
        legB,
        totalFeeUsd: legA.feeUsd + legB.feeUsd,
        durationSec: legB.inOpTimeSec - legA.outOpTimeSec,
      });
    }
  }
  return cycles;
}
