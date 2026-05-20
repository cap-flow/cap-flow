import { getLpMarketKey } from "./async_deposit_linker";
import type {
  BalanceLine,
  ClassifiedOp,
  LendingPositionLine,
  LpPositionLine,
  OpType,
  PortfolioSnapshot,
  StakingPositionLine,
} from "./types";

/**
 * Применяет последовательно все операции (в порядке от старых к новым)
 * и возвращает агрегированный снимок портфеля.
 *
 * Логика:
 *   - deposit_fiat / withdraw_fiat   → стартовый капитал и его вывод (в USD).
 *   - swap                           → обновляет балансы кошелька (cost basis weighted average).
 *   - transfer_in / transfer_out     → влияют только на балансы.
 *   - lend_supply / withdraw         → копят нетто-supplied по протоколу.
 *   - borrow / repay                 → копят нетто-долг по протоколу.
 *   - lp_add / remove                → копят netUsd по протоколу.
 *   - stake / unstake                → копят amount/cost по протоколу.
 *   - все типы попадают в opsByType.
 *
 * Итог: реальная картина «что и где лежит» с приближённой оценкой USD.
 * Цены берутся на момент операции (tokens[id].price из DeBank-страницы).
 */
export function buildSnapshot(
  walletId: string,
  walletAddress: string,
  ops: ClassifiedOp[],
  options?: {
    /**
     * Set хешей операций, которые являются internal-transfers
     * (перемещения между двумя пользовательскими кошельками). Для них
     * cost basis НЕ меняется при transfer_in / transfer_out / bridge_*:
     *   - На отправителе: amount уменьшается, costBasisUsd НЕ списывается
     *     (мы не «продали» — только переместили).
     *   - На получателе: amount увеличивается, costBasisUsd НЕ добавляется
     *     по spot (cost наследуется через aggregate, не через snapshot).
     *
     * При aggregate всех snapshot'ов (через `aggregate.ts`) суммарный
     * costBasis сохраняется правильным — у отправителя он остался, у
     * получателя 0, в сумме = original.
     */
    internalHashes?: Set<string>;
  },
): PortfolioSnapshot {
  const internalHashes = options?.internalHashes;
  const balances = new Map<string, MutableBalance>(); // key = symbol
  const lending = new Map<string, MutableLending>(); // key = `${proto}@${chain}`
  const lp = new Map<string, MutableLp>(); // key = `${proto}@${chain}`
  const staking = new Map<string, MutableStaking>(); // key = `${proto}@${chain}@${symbol}`
  const opsByType = new Map<OpType, { count: number; netUsd: number }>();

  let startingCapitalUsd = 0;
  let withdrawnUsd = 0;
  let totalGasUsd = 0;
  let realizedPnlUsd = 0;
  const realizedPnlBySymbol: Record<string, number> = {};
  const realizedPnlByOpType: Partial<Record<OpType, number>> = {};

  /**
   * Прогон applyMovementsToBalances + аккумуляция realized PnL для
   * этой операции. Вынесено в локальную функцию, чтобы не дублировать
   * код по всем case'ам switch.
   */
  function applyAndCollectRealized(
    op: ClassifiedOp,
    options: Parameters<typeof applyMovementsToBalances>[2] = {},
  ): void {
    const res = applyMovementsToBalances(op, balances, options);
    let opRealized = 0;
    for (const [sym, val] of Object.entries(res.realizedBySymbol)) {
      realizedPnlBySymbol[sym] = (realizedPnlBySymbol[sym] ?? 0) + val;
      opRealized += val;
    }
    if (opRealized !== 0) {
      realizedPnlUsd += opRealized;
      realizedPnlByOpType[op.type] =
        (realizedPnlByOpType[op.type] ?? 0) + opRealized;
    }
  }

  for (const op of ops) {
    if (op.gasUsd) totalGasUsd += op.gasUsd;

    const bucket = opsByType.get(op.type) ?? { count: 0, netUsd: 0 };
    bucket.count += 1;
    bucket.netUsd += op.netUsd;
    opsByType.set(op.type, bucket);

    if (op.status === "failed") continue;

    switch (op.type) {
      case "deposit_fiat": {
        startingCapitalUsd += sumIncomingUsd(op);
        applyAndCollectRealized(op);
        break;
      }
      case "withdraw_fiat": {
        withdrawnUsd += sumOutgoingUsd(op);
        applyAndCollectRealized(op);
        break;
      }
      case "swap":
      case "claim_rewards":
      case "gas_topup":
      case "unknown": {
        applyAndCollectRealized(op);
        break;
      }
      case "transfer_in":
      case "transfer_out":
      case "bridge_in":
      case "bridge_out": {
        // Internal pair (между своими кошельками) — НЕ troga cost basis.
        // Amount меняется, чтобы балансы отражали факт перемещения.
        const isInternal = internalHashes?.has(op.hash) ?? false;
        applyAndCollectRealized(op, { skipCostBasis: isInternal });
        break;
      }
      case "lend_supply": {
        // aToken / cToken НЕ кладём в walletBalances — он уже в lending.supplied
        applyAndCollectRealized(op, { excludeProtocolTokens: true });
        const key = posKey(op);
        const ent = lending.get(key) ?? newLending(op);
        for (const m of op.movement) {
          if (m.isProtocolToken) continue; // aToken не считаем как actual collateral
          if (m.direction === "out") {
            addTo(ent.supplied, m.symbol, m.amount, m.usd ?? 0);
          }
        }
        lending.set(key, ent);
        break;
      }
      case "lend_withdraw": {
        // TODO(P1.6): корректный учёт начисленных процентов. Сейчас:
        //   supply 1 ETH → balance.cost -= avg×1
        //   withdraw 1.05 ETH (через год, ETH дороже) → balance.cost += m.usd
        // В итоге интерес 0.05 ETH «зарывается» в инфляцию cost basis,
        // а не показывается отдельно как realized interest income.
        //
        // Правильный путь:
        //   1. На lend_supply: записать lot { suppliedAmount, avgCostAtSupply }
        //      по ключу `${proto}@${chain}@${symbol}` (новый Map в reducer).
        //   2. На lend_withdraw:
        //      - principal = min(withdrawAmount, lot.suppliedAmount)
        //          → balance += principal с cost = principal × lot.avgCostAtSupply
        //          → lot.suppliedAmount -= principal
        //      - interest = max(0, withdrawAmount − lot.suppliedAmount)
        //          → realized_interest_in += interest × m.unitPriceUsd
        //          → balance += interest с cost = interest × m.unitPriceUsd
        //   3. Аналогичный учёт для borrow / repay (interest_out).
        //
        // Пока: применяем «как есть», cost basis считается приблизительно.
        applyAndCollectRealized(op, { excludeProtocolTokens: true });
        const key = posKey(op);
        const ent = lending.get(key) ?? newLending(op);
        for (const m of op.movement) {
          if (m.isProtocolToken) continue;
          if (m.direction === "in") {
            addTo(ent.supplied, m.symbol, -m.amount, -(m.usd ?? 0));
          }
        }
        lending.set(key, ent);
        break;
      }
      case "borrow": {
        applyAndCollectRealized(op);
        const key = posKey(op);
        const ent = lending.get(key) ?? newLending(op);
        for (const m of op.movement) {
          if (m.direction === "in") {
            addTo(ent.borrowed, m.symbol, m.amount, m.usd ?? 0);
          }
        }
        lending.set(key, ent);
        break;
      }
      case "repay": {
        applyAndCollectRealized(op);
        const key = posKey(op);
        const ent = lending.get(key) ?? newLending(op);
        for (const m of op.movement) {
          if (m.direction === "out") {
            addTo(ent.borrowed, m.symbol, -m.amount, -(m.usd ?? 0));
          }
        }
        lending.set(key, ent);
        break;
      }
      case "lp_add": {
        // LP-receipt НЕ кладём в walletBalances — позиция учтена в lp.netUsd.
        applyAndCollectRealized(op, { excludeProtocolTokens: true });
        const key = posKey(op);
        const ent = lp.get(key) ?? newLp(op);
        ent.netUsd += sumOutgoingUsd(op);
        for (const m of op.movement) {
          if (m.direction === "out" && !m.isProtocolToken) {
            ent.tokens.add(m.symbol);
            addTo(ent.deposited, m.symbol, m.amount, m.usd ?? 0);
          }
        }
        lp.set(key, ent);
        break;
      }
      case "lp_remove": {
        applyAndCollectRealized(op, { excludeProtocolTokens: true });
        const key = posKey(op);
        const ent = lp.get(key) ?? newLp(op);
        ent.netUsd -= sumIncomingUsd(op);
        for (const m of op.movement) {
          if (m.direction === "in" && !m.isProtocolToken) {
            ent.tokens.add(m.symbol);
            addTo(ent.withdrawn, m.symbol, m.amount, m.usd ?? 0);
          }
        }
        lp.set(key, ent);
        break;
      }
      case "stake": {
        // stETH / receipt-токен НЕ кладём в walletBalances — он в staking.
        applyAndCollectRealized(op, { excludeProtocolTokens: true });
        for (const m of op.movement) {
          if (m.direction !== "in" || !m.isProtocolToken) continue;
          if (!op.protocol) continue;
          const key = `${op.protocol.id}@${op.chain}@${m.symbol}`;
          const ent = staking.get(key) ?? {
            protocol: op.protocol,
            chain: op.chain,
            symbol: m.symbol,
            amount: 0,
            costUsd: 0,
          };
          ent.amount += m.amount;
          ent.costUsd += m.usd ?? 0;
          staking.set(key, ent);
        }
        break;
      }
      case "unstake": {
        applyAndCollectRealized(op, { excludeProtocolTokens: true });
        for (const m of op.movement) {
          if (m.direction !== "out" || !m.isProtocolToken) continue;
          if (!op.protocol) continue;
          const key = `${op.protocol.id}@${op.chain}@${m.symbol}`;
          const ent = staking.get(key);
          if (!ent) continue;
          ent.amount -= m.amount;
          ent.costUsd -= m.usd ?? 0;
          staking.set(key, ent);
        }
        break;
      }
      case "perp_open":
      case "perp_close": {
        applyAndCollectRealized(op);
        // Перпами займёмся отдельно (нужен протокол-специфичный API).
        break;
      }
      case "approve":
      case "failed":
      default:
        break;
    }
  }

  return {
    walletId,
    walletAddress,
    startingCapitalUsd,
    withdrawnUsd,
    netInvestedUsd: startingCapitalUsd - withdrawnUsd,
    totalGasUsd,
    walletBalances: dumpBalances(balances),
    lendingPositions: dumpLending(lending),
    lpPositions: dumpLp(lp),
    stakingPositions: dumpStaking(staking),
    opsByType: Array.from(opsByType.entries())
      .map(([type, v]) => ({ type, count: v.count, netUsd: v.netUsd }))
      .sort((a, b) => b.count - a.count),
    realizedPnlUsd,
    realizedPnlBySymbol,
    realizedPnlByOpType,
  };
}

/* ---------------------------- mutable maps -------------------------------- */

interface MutableBalance {
  symbol: string;
  tokenId: string;
  amount: number;
  costBasisUsd: number;
  isStable: boolean;
  costBasisHasGap?: boolean;
}

interface MutableLending {
  protocol: NonNullable<ClassifiedOp["protocol"]>;
  chain: string;
  supplied: Record<string, { amount: number; usd: number }>;
  borrowed: Record<string, { amount: number; usd: number }>;
}

interface MutableLp {
  protocol: NonNullable<ClassifiedOp["protocol"]>;
  chain: string;
  netUsd: number;
  tokens: Set<string>;
  /** symbol → кумулятивно внесено (для IL расчёта). */
  deposited: Record<string, { amount: number; usd: number }>;
  /** symbol → кумулятивно выведено (для IL расчёта). */
  withdrawn: Record<string, { amount: number; usd: number }>;
}

interface MutableStaking {
  protocol: NonNullable<ClassifiedOp["protocol"]>;
  chain: string;
  symbol: string;
  amount: number;
  costUsd: number;
}

interface ApplyResult {
  /**
   * Реализованный PnL из out-движений (за вычетом WAC × amount). Стейблы
   * и protocol-токены не дают realized. Internal-transfers и in-движения
   * тоже не дают.
   */
  realizedBySymbol: Record<string, number>;
}

function applyMovementsToBalances(
  op: ClassifiedOp,
  balances: Map<string, MutableBalance>,
  options: {
    excludeProtocolTokens?: boolean;
    /**
     * Internal-transfer между своими кошельками — НЕ менять cost basis.
     * Только amount двигаем, чтобы текущие балансы отражали реальность.
     * Cost basis сохраняется на отправителе, на получателе остаётся 0.
     * При aggregate (cross-wallet суммирование) cost остаётся корректным.
     */
    skipCostBasis?: boolean;
  } = {},
): ApplyResult {
  const realizedBySymbol: Record<string, number> = {};

  for (const m of op.movement) {
    // Для lend_supply / stake / unstake / lend_withdraw protocol-токены
    // (aToken / cToken / stETH / LP-receipt) не должны попадать в
    // walletBalances — они уже учтены в lending.supplied / staking.amount.
    if (options.excludeProtocolTokens && m.isProtocolToken) continue;

    const key = `${m.symbol}@${m.tokenId}`;
    const cur = balances.get(key) ?? {
      symbol: m.symbol,
      tokenId: m.tokenId,
      amount: 0,
      costBasisUsd: 0,
      isStable: m.isStable,
    };
    if (m.direction === "in") {
      cur.amount += m.amount;
      if (!options.skipCostBasis) {
        if (typeof m.usd === "number") {
          cur.costBasisUsd += m.usd;
        } else if (!m.isStable && m.amount > 0) {
          // Входящее нон-стейбл движение без оракула цены — типичный случай
          // airdrop / claim_rewards / bridge с непрайсованным mint'ом. Не
          // тихо добавляем 0 (это ломает PnL при продаже), а помечаем gap.
          // realized PnL по последующим out'ам будет приблизителен.
          cur.costBasisHasGap = true;
        }
      }
    } else {
      // Safety: cur.amount > 0 недостаточно — после длинной цепочки
      // float-arithmetic операций он может стать 1e-50 при cost basis
      // в $миллионах, давая avg = $1e60 → realized PnL = $1e99 (overflow
      // viewable как «+1.9 × 10⁹⁹ $»). Минимальный порог 1e-9 покрывает
      // legit микро-движения (gas, sat-level dust) и блокирует numerical
      // blow-ups.
      if (!options.skipCostBasis && cur.amount > 1e-9) {
        // Снимаем cost basis пропорционально (weighted average).
        const avg = cur.costBasisUsd / cur.amount;
        const portionCost = avg * m.amount;
        cur.costBasisUsd -= portionCost;

        // Realized PnL = (USD-стоимость движения) − (списанный cost basis).
        // Считаем для всех активов, включая стейблы — чтобы поймать депег:
        // если USDC swap'ом по 0.87, m.usd=870 vs portionCost=1000, realized=-130.
        // Без учёта стейблов депег-потери теряются.
        // Protocol-токены отфильтрованы выше через excludeProtocolTokens.
        if (typeof m.usd === "number") {
          const realized = m.usd - portionCost;
          // Маленькие шумы (rounding) на стейблах подавляем — ниже $0.01 не важно.
          // Sanity bound: realized > $1B на одной op — это почти точно
          // numerical blow-up или scam-token с inflated price. Дроп с warn.
          if (!Number.isFinite(realized)) {
            if (typeof window !== "undefined") {
              console.warn(
                `[reducer] non-finite realized PnL for ${m.symbol} in ${op.hash}: ` +
                  `avg=${avg}, amount=${m.amount}, m.usd=${m.usd}`,
              );
            }
          } else if (Math.abs(realized) > 1_000_000_000) {
            if (typeof window !== "undefined") {
              console.warn(
                `[reducer] suspicious realized PnL ${realized.toExponential(2)} ` +
                  `for ${m.symbol} (${op.hash}) — likely scam token or numerical issue, skipping`,
              );
            }
          } else if (Math.abs(realized) > 0.01) {
            realizedBySymbol[m.symbol] =
              (realizedBySymbol[m.symbol] ?? 0) + realized;
          }
        }
      }
      cur.amount -= m.amount;
      // Дополнительная защита: после вычитания amount может стать
      // sub-dust ε из-за float-arithmetic. Округляем к 0 чтобы будущий
      // `cur.amount > 1e-9` check работал предсказуемо.
      if (Math.abs(cur.amount) < 1e-9) {
        cur.amount = 0;
        // costBasis тоже сбрасываем чтобы не оставлять "висящий" cost для 0 amount
        cur.costBasisUsd = 0;
      }
    }
    balances.set(key, cur);
  }

  return { realizedBySymbol };
}

function sumIncomingUsd(op: ClassifiedOp): number {
  return op.movement.filter((m) => m.direction === "in").reduce((s, m) => s + (m.usd ?? 0), 0);
}
function sumOutgoingUsd(op: ClassifiedOp): number {
  return op.movement.filter((m) => m.direction === "out").reduce((s, m) => s + (m.usd ?? 0), 0);
}

function posKey(op: ClassifiedOp): string {
  const base = `${op.protocol?.id ?? "?"}@${op.chain}`;
  // Для yield/perp протоколов с множественными маркетами (GMX V2 на Arbitrum:
  // GM[BTC]/GM[ETH]/GLV[WETH-USDC]; GMSOL на Solana: тот же паттерн) ОДИН
  // protocol+chain = МНОГО позиций. Чтобы не сливать их в reducer'е, добавляем
  // в ключ mint LP-receipt'а. Берём через `getLpMarketKey` — он смотрит
  // на movement (для классических lp_add) или на `linkedLpTokenId`
  // (для async-deposit пар через `link_async_deposits.ts`).
  if (op.protocol?.category === "yield" || op.protocol?.category === "perp") {
    const market = getLpMarketKey(op);
    if (market) return `${base}@${market.tokenId}`;
  }
  return base;
}

function newLending(op: ClassifiedOp): MutableLending {
  return {
    protocol: op.protocol!,
    chain: op.chain,
    supplied: {},
    borrowed: {},
  };
}
function newLp(op: ClassifiedOp): MutableLp {
  return {
    protocol: op.protocol!,
    chain: op.chain,
    netUsd: 0,
    tokens: new Set(),
    deposited: {},
    withdrawn: {},
  };
}
function addTo(
  rec: Record<string, { amount: number; usd: number }>,
  symbol: string,
  amount: number,
  usd: number,
) {
  const cur = rec[symbol] ?? { amount: 0, usd: 0 };
  cur.amount += amount;
  cur.usd += usd;
  rec[symbol] = cur;
}

function dumpBalances(map: Map<string, MutableBalance>): BalanceLine[] {
  return Array.from(map.values())
    // Скрываем «пыль» — менее $1 и < 0.000001 amount. Активы с gap'ом
    // cost basis оставляем даже если cost < $1, потому что для них реальная
    // стоимость может быть не нулевой (просто оракул не дал цены).
    .filter((b) =>
      Math.abs(b.amount) > 1e-6 &&
      (Math.abs(b.costBasisUsd) >= 1 || b.costBasisHasGap === true),
    )
    .sort((a, b) => Math.abs(b.costBasisUsd) - Math.abs(a.costBasisUsd))
    .map((b) => ({
      symbol: b.symbol,
      tokenId: b.tokenId,
      amount: b.amount,
      costBasisUsd: b.costBasisUsd,
      isStable: b.isStable,
      ...(b.costBasisHasGap && { costBasisHasGap: true }),
    }));
}
function dumpLending(map: Map<string, MutableLending>): LendingPositionLine[] {
  const arr: LendingPositionLine[] = [];
  for (const v of map.values()) {
    // Чистим нулевые строки.
    for (const k of Object.keys(v.supplied)) {
      const x = v.supplied[k]!;
      if (Math.abs(x.amount) < 1e-6 && Math.abs(x.usd) < 1) delete v.supplied[k];
    }
    for (const k of Object.keys(v.borrowed)) {
      const x = v.borrowed[k]!;
      if (Math.abs(x.amount) < 1e-6 && Math.abs(x.usd) < 1) delete v.borrowed[k];
    }
    if (Object.keys(v.supplied).length || Object.keys(v.borrowed).length) {
      arr.push(v);
    }
  }
  return arr.sort((a, b) => a.protocol.name.localeCompare(b.protocol.name));
}
function dumpLp(map: Map<string, MutableLp>): LpPositionLine[] {
  return Array.from(map.values())
    .filter((v) => Math.abs(v.netUsd) > 1)
    .map((v) => ({
      protocol: v.protocol,
      chain: v.chain,
      netUsd: v.netUsd,
      tokens: Array.from(v.tokens),
      ...(Object.keys(v.deposited).length > 0 && { deposited: v.deposited }),
      ...(Object.keys(v.withdrawn).length > 0 && { withdrawn: v.withdrawn }),
    }))
    .sort((a, b) => Math.abs(b.netUsd) - Math.abs(a.netUsd));
}
function dumpStaking(map: Map<string, MutableStaking>): StakingPositionLine[] {
  return Array.from(map.values())
    .filter((v) => Math.abs(v.amount) > 1e-6)
    .sort((a, b) => Math.abs(b.costUsd) - Math.abs(a.costUsd));
}
