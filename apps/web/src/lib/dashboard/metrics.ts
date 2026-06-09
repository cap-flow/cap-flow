/**
 * Метрики дашборда. Источник позиций — `buildOpenPositions()`, тот же что у
 * страницы «Лист открытых позиций», чтобы цифры были консистентны
 * (включая inferred Solana-позиции из истории).
 *
 * Поверх позиций считаем:
 *  - Стартовый капитал (ручные пометки fiatPurchase)
 *  - Совокупный долг + накопленные проценты по займам (по истории borrow/repay)
 *  - Per-protocol breakdown с total PnL, долей, lending-метриками
 */

import type { Loaded } from "@/components/data/LoadedWalletsProvider";
import {
  buildOpenPositions,
  totalAssetsOf,
  type OpenPosition,
} from "@/lib/portfolio/open_positions";
import { isStableSymbol, isProtocolToken } from "@/lib/portfolio/protocols";
import { buildCostBasisTracker } from "@/lib/portfolio/cost_basis_tracker";
import { isJunkOp } from "@/lib/portfolio/junk_filter";
import type { ClassifiedOp } from "@/lib/portfolio/types";
import {
  annotationKey,
  type FiatCurrency,
  type OpAnnotations,
} from "@/lib/portfolio/manual_annotations";

export interface StartCapitalByCur {
  currency: FiatCurrency;
  totalFiat: number;
  opsCount: number;
}

/**
 * Накопленные % по займу для одной debt-позиции.
 *
 * Считаем так:
 *   net_borrowed_amount = Σ(borrow in_amount) − Σ(repay out_amount) — токенов
 *   accrued_interest_amount = current_debt_amount − net_borrowed_amount
 *   accrued_interest_usd = accrued_interest_amount × current_price
 *   borrow_apr = (accrued_interest / net_borrowed_at_first_borrow)
 *                × (365 / age_days) × 100
 */
export interface BorrowInterest {
  symbol: string;
  /** Дата первого `borrow` op в этом протоколе (unix sec). */
  firstBorrowTime: number | null;
  /** Срок в днях с первого займа. */
  ageDays: number | null;
  /** Σ занято минус погашено в токенах (на сейчас). */
  netBorrowedAmount: number;
  /** Стартовая USD-стоимость займа (по цене на момент первого borrow). */
  originalPrincipalUsd: number;
  /** Текущий долг в токенах. */
  currentDebtAmount: number;
  /** Текущий долг в USD. */
  currentDebtUsd: number;
  /** Накопленные проценты в токенах (current − net_borrowed). */
  accruedInterestAmount: number;
  /** Те же проценты в USD по текущей цене. */
  accruedInterestUsd: number;
  /** Годовая % ставка по займу (annualized). */
  borrowAprPct: number | null;
}

export interface LendingMetrics {
  healthFactor: number | null;
  /** запас до ликв. в %. = (1 − 1/HF) × 100 — на сколько % залог может упасть до HF=1. */
  liquidationBufferPct: number | null;
  /** Текущий LTV = debt / collateral × 100. */
  currentLtvPct: number | null;
  /** Сколько ещё можно занять = collateral × LT − debt = debt × (HF − 1). */
  borrowRoomUsd: number | null;
  /** Накопленный % по займу (одной строкой; если несколько debt-токенов — сумма). */
  accruedInterestUsd: number;
  /** Средневзвешенный borrow APR (по originalPrincipalUsd). */
  borrowAprPct: number | null;
  /** Детально по каждому debt-токену. */
  borrows: BorrowInterest[];
}

export interface ProtocolBreakdown {
  protocolId: string;
  protocolName: string;
  chain: string;
  walletNames: string[];
  /** Брутто стоимость supply (как в Открытых позициях). */
  assetUsd: number;
  /** Σ debt. */
  debtUsd: number;
  /** netUsd = assetUsd − debtUsd. */
  netUsd: number;
  /** Σ startUsd. */
  startUsd: number;
  /** Σ feesClaimed (уже выведенных дивидендов). */
  feesClaimedUsd: number;
  /** Σ feesUsd (pending, внутри позиции). */
  feesPendingUsd: number;
  /** Total PnL = current + claimed − start. */
  totalPnlUsd: number;
  totalPnlPct: number | null;
  /** Доля в активах в работе (от Σ всех protocols.assetUsd). 0..1. */
  shareOfWork: number;
  /** Сами позиции — для разворачивания. */
  positions: OpenPosition[];
  /** Если есть lending-позиции — агрегированные lending-метрики. */
  lending?: LendingMetrics;
}

export interface DashboardMetrics {
  /** Стартовый капитал по валютам. */
  startCapital: StartCapitalByCur[];
  startUsdAll: number; // USD-эквивалент всех фиат-покупок
  startRub: number;

  /** Текущая стоимость on-chain балансов кошельков. */
  walletUsd: number;
  /**
   * Σ (amount × WAC) по всем токенам на балансах кошельков (без receipt'ов).
   * Сколько пользователь реально заплатил за то, что лежит сейчас. Используется
   * как fallback для «Стартовый капитал» когда нет ручных фиат-аннотаций.
   */
  walletStartUsd: number;
  /**
   * **Эффективный** стартовый капитал = max(startUsdAll, derived).
   * derived = walletStartUsd + protocolsInvestedUsd.
   * Если ручные fiatPurchase аннотации есть (startUsdAll > 0) — используем их,
   * иначе используем derived из cost basis. Это позволяет считать PnL/APR
   * даже без ручных пометок.
   */
  startUsdEffective: number;
  /** Σ currentUsd по всем live+inferred позициям (брутто). */
  protocolsAssetUsd: number;
  /** Σ currentDebtUsd. */
  protocolsDebtUsd: number;
  /** Нетто = asset − debt. */
  protocolsNetUsd: number;

  /** Total assets = wallet + protocolsAssetUsd. (Совпадает с Открытыми позициями.) */
  totalAssetsUsd: number;
  /** Долг ручной (купил на кредит — фиат). */
  manualCreditUsd: number;
  /** Совокупный долг = протоколы + ручной кредит. */
  totalDebtUsd: number;
  /** Σ накопленных % по протокол-займам (USD). */
  accruedInterestUsd: number;
  /** Σ принципала всех протокол-займов (USD на момент займа). */
  protocolPrincipalUsd: number;
  /** Σ pending дивидендов внутри позиций. */
  dividendsPendingUsd: number;
  /** Σ уже снятых дивидендов (claim_rewards). */
  dividendsClaimedUsd: number;
  /** Lifetime дивидендов = pending + claimed. */
  dividendsTotalUsd: number;
  /** Σ startUsd по всем позициям — «инвестировано» в проекты. */
  protocolsInvestedUsd: number;
  /** Total PnL по всем DeFi-позициям (как в «Лист открытых позиций»):
   *  (Σ currentUsd + Σ feesClaimed) − Σ startUsd. */
  protocolsTotalPnlUsd: number;
  /** Total PnL % = totalPnl / invested × 100. */
  protocolsTotalPnlPct: number | null;
  /** Средневзвешенная годовая ставка по протокол-займам. */
  borrowAprPct: number | null;
  /** Свой капитал = total − total debt. */
  ownCapitalUsd: number;

  /**
   * Суммарная стоимость газа за всю историю (все кошельки).
   * Это «съеденные транзакциями» деньги, не имеющие отношения к PnL по
   * активам — отдельный bucket, чтобы было видно отдельно.
   */
  totalGasUsd: number;

  /**
   * Реализованный PnL — фиксируется в момент out-движения нон-стейбл актива
   * (продажа в стейбл, swap, withdraw_fiat, депег стейбла). Считается через
   * `(out_usd − wac × out_amount)` в reducer'е и aggregate'е.
   */
  realizedPnlUsd: number;

  protocols: ProtocolBreakdown[];

  /** Самая ранняя пометка «куплено за фиат» (для APR). */
  earliestEntryMs: number;
}

export interface ComputeOptions {
  usdRub: number;
  /**
   * Готовый список позиций (с применёнными ручными override'ами currentValue
   * и feesUsd). Если не указан — собирается через buildOpenPositions.
   * Передавать ОБЯЗАТЕЛЬНО, если есть position_overrides — иначе дивиденды
   * и assets разойдутся с «Листом открытых позиций».
   */
  positions?: OpenPosition[];
  /**
   * DefiLlama historical prices для fallback расчёта позиций ВНУТРИ
   * computeDashboardMetrics (если `positions` не передан). Без этого
   * positions считаются по DeBank current spot → startUsd искажён для
   * долгосрочных позиций.
   */
  histPrices?: Map<string, number>;
}

/* ------------------------------ helpers ----------------------------------- */

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^\w]/g, "");
}

/**
 * Находит все borrow/repay ops для (protocol, debt-symbol) в кошельке и считает
 * накопленные проценты по разнице current vs net_borrowed.
 */
function computeBorrowInterestForToken(args: {
  ops: ClassifiedOp[];
  protocolId: string;
  /**
   * Сеть позиции (Polygon / Arbitrum / Mainnet / …). Без неё ops от Aave
   * Polygon И Aave Arbitrum суммируются по одинаковому `protocolId`, и
   * net_borrowed считается дважды.
   */
  chain: string;
  symbol: string;
  currentDebtAmount: number;
  currentDebtUsd: number;
}): BorrowInterest {
  const { ops, protocolId, chain, symbol, currentDebtAmount, currentDebtUsd } = args;
  const targetSym = normalize(symbol);

  let firstBorrowTime: number | null = null;
  let firstBorrowPrice: number | null = null;
  let netBorrowedAmount = 0;
  // Для стейблов принципал считаем по $1 за токен — не зависит от
  // мелких отклонений курса в момент займа (USDT 0.99979 → 1039 × 0.99979
  // ≈ $1038.78, а пользователь хочет видеть ровно $1039).
  const stable = isStableSymbol(symbol);

  for (const op of ops) {
    if (op.status === "failed") continue;
    if (isJunkOp(op)) continue;
    if (!op.protocol || op.protocol.id !== protocolId) continue;
    if (op.chain !== chain) continue; // фильтр по сети — multi-chain protocol
    // Расширяем фильтр: помимо чистых borrow/repay учитываем
    // **combined supply+borrow** и **combined withdraw+repay** ops
    // (Fluid Vault open/close, где обе операции в одной tx).
    const isCombinedBorrow =
      op.type === "lend_supply" &&
      op.notes?.includes("combined-supply-borrow");
    const isCombinedRepay =
      op.type === "lend_withdraw" &&
      op.notes?.includes("combined-withdraw-repay");
    // ИНФЕРЕНС для receipt-less протоколов (Morpho Blue / Drift / Adrena):
    // если op типа `lend_supply` отправляет в out целевую борровую валюту
    // (= targetSym = `symbol` = валюта существующего долга), это de-facto
    // partial repay. Классификатор пометил как `lend_supply` потому что
    // нет других signals (only out, no in), но семантически — repay.
    // Решает кейс Aleaxander 2 / Morpho POS-004:
    //   23.04 borrow 815 AUSD, далее out 115 + 100 AUSD (классиф как
    //   lend_supply) → реально это репаи (current debt 601 = 815-115-100).
    const isInferredRepay =
      op.type === "lend_supply" &&
      op.movement.some(
        (m) =>
          m.direction === "out" &&
          normalize(m.symbol) === targetSym &&
          m.amount > 0,
      ) &&
      !op.movement.some((m) => m.direction === "in" && m.amount > 0);
    if (
      op.type !== "borrow" &&
      op.type !== "repay" &&
      !isCombinedBorrow &&
      !isCombinedRepay &&
      !isInferredRepay
    ) {
      continue;
    }
    // Для combined ops borrow-движение = IN не-collateral underlying;
    // collateral отличается от target debt symbol. Repay-движение = OUT
    // не-collateral underlying.
    const isBorrowOp = op.type === "borrow" || isCombinedBorrow;
    const isRepayOp = op.type === "repay" || isCombinedRepay || isInferredRepay;
    for (const m of op.movement) {
      if (normalize(m.symbol) !== targetSym) continue;
      if (isBorrowOp && m.direction === "in" && m.amount > 0) {
        netBorrowedAmount += m.amount;
        if (firstBorrowTime == null || op.time < firstBorrowTime) {
          firstBorrowTime = op.time;
          if (m.usd != null && m.amount > 0) {
            firstBorrowPrice = m.usd / m.amount;
          }
        }
      } else if (isRepayOp && m.direction === "out" && m.amount > 0) {
        netBorrowedAmount -= m.amount;
      }
    }
  }

  // Может быть отрицательно из-за частичных репеев → защищаемся.
  netBorrowedAmount = Math.max(0, netBorrowedAmount);

  // Для стейблов цена = $1 (исключаем шум от deviation peg).
  const currentPrice = stable
    ? 1
    : currentDebtAmount > 0
      ? currentDebtUsd / currentDebtAmount
      : 0;
  const accruedAmount = Math.max(0, currentDebtAmount - netBorrowedAmount);
  const accruedUsd = accruedAmount * currentPrice;

  const ageDays =
    firstBorrowTime != null
      ? Math.max(
          0.5 / 24,
          (Date.now() / 1000 - firstBorrowTime) / 86_400,
        )
      : null;

  const originalPrincipalUsd =
    netBorrowedAmount * (stable ? 1 : (firstBorrowPrice ?? currentPrice));

  const borrowAprPct =
    originalPrincipalUsd > 0 && ageDays != null && ageDays > 0
      ? (accruedUsd / originalPrincipalUsd) * (365 / ageDays) * 100
      : null;

  return {
    symbol,
    firstBorrowTime,
    ageDays,
    netBorrowedAmount,
    originalPrincipalUsd,
    currentDebtAmount,
    currentDebtUsd,
    accruedInterestAmount: accruedAmount,
    accruedInterestUsd: accruedUsd,
    borrowAprPct,
  };
}

/**
 * Агрегаты по займам всего протокола: для каждого debt-symbol собираем
 * total_current_debt (по всем lending-позициям) и net_borrowed
 * (Σ borrow − Σ repay в истории кошелька для этого протокола+символа).
 *
 * Используется для proportional-split накопленных процентов между
 * позициями с одинаковым debt-токеном (DeBank не привязывает borrow к
 * конкретной позиции — точную атрибуцию делаем пропорционально).
 */
export interface ProtocolBorrowAggregate {
  bySymbol: Map<
    string,
    {
      totalCurrentAmount: number;
      totalCurrentUsd: number;
      netBorrowedAmount: number;
      firstBorrowTime: number | null;
      firstBorrowPrice: number | null;
    }
  >;
}

export function computeProtocolBorrowAggregates(
  lendingPositions: OpenPosition[],
  ops: ClassifiedOp[],
): ProtocolBorrowAggregate {
  const bySymbol = new Map<
    string,
    {
      totalCurrentAmount: number;
      totalCurrentUsd: number;
      netBorrowedAmount: number;
      firstBorrowTime: number | null;
      firstBorrowPrice: number | null;
    }
  >();
  if (lendingPositions.length === 0) return { bySymbol };
  const protocolId = lendingPositions[0]!.protocol.id;
  // Все lending-позиции в `lendingPositions` должны быть с одной сети
  // (предполагаем что вызывающий код их группирует). Если есть смешение
  // сетей — берём множество и фильтруем ops по нему.
  const chains = new Set(lendingPositions.map((p) => p.chain));

  // 1) Собираем total current debt по символам (по всем lending-позициям).
  for (const pos of lendingPositions) {
    for (const d of pos.debtTokens) {
      if (d.amount <= 0) continue;
      const ex = bySymbol.get(d.symbol) ?? {
        totalCurrentAmount: 0,
        totalCurrentUsd: 0,
        netBorrowedAmount: 0,
        firstBorrowTime: null,
        firstBorrowPrice: null,
      };
      ex.totalCurrentAmount += d.amount;
      ex.totalCurrentUsd += d.usd;
      bySymbol.set(d.symbol, ex);
    }
  }

  // 2) Walk ops для каждого symbol → считаем net_borrowed и first_borrow.
  for (const [symbol, agg] of bySymbol) {
    const targetSym = normalize(symbol);
    for (const op of ops) {
      if (op.status === "failed") continue;
    if (isJunkOp(op)) continue;
      if (!op.protocol || op.protocol.id !== protocolId) continue;
      if (!chains.has(op.chain)) continue; // multi-chain protocol — фильтр по сети
      if (op.type !== "borrow" && op.type !== "repay") continue;
      for (const m of op.movement) {
        if (normalize(m.symbol) !== targetSym) continue;
        if (op.type === "borrow" && m.direction === "in" && m.amount > 0) {
          agg.netBorrowedAmount += m.amount;
          if (agg.firstBorrowTime == null || op.time < agg.firstBorrowTime) {
            agg.firstBorrowTime = op.time;
            if (m.usd != null && m.amount > 0) {
              agg.firstBorrowPrice = m.usd / m.amount;
            }
          }
        } else if (op.type === "repay" && m.direction === "out" && m.amount > 0) {
          agg.netBorrowedAmount -= m.amount;
        }
      }
    }
    agg.netBorrowedAmount = Math.max(0, agg.netBorrowedAmount);
  }

  return { bySymbol };
}

/**
 * Lending-метрики для ОДНОЙ позиции с pro-rata разделением накопленных
 * процентов между sibling-позициями (если у нескольких позиций один debt-token).
 *
 * `protocolAgg` строится через `computeProtocolBorrowAggregates(allLendingPositions, ops)`.
 */
export function computePositionLendingMetrics(
  position: OpenPosition,
  protocolAgg: ProtocolBorrowAggregate,
): LendingMetrics {
  const collateral = position.currentUsd;
  const debt = position.currentDebtUsd;
  const hf = position.healthRate ?? null;

  const currentLtvPct = collateral > 0 ? (debt / collateral) * 100 : null;
  const liquidationBufferPct =
    hf != null && hf > 0 ? Math.max(0, (1 - 1 / hf) * 100) : null;
  const borrowRoomUsd =
    hf != null && hf > 0 && debt > 0 ? debt * (hf - 1) : null;

  // Накопленные % per debt-token: pro-rata по доле этой позиции в общем
  // current_debt протокола для данного символа.
  const borrows: BorrowInterest[] = [];
  for (const d of position.debtTokens) {
    if (d.amount <= 0) continue;
    const agg = protocolAgg.bySymbol.get(d.symbol);
    if (!agg) continue;
    const stable = isStableSymbol(d.symbol);
    const share =
      agg.totalCurrentAmount > 0 ? d.amount / agg.totalCurrentAmount : 0;
    const positionNetBorrowedAmount = agg.netBorrowedAmount * share;
    const positionAccruedAmount = Math.max(
      0,
      d.amount - positionNetBorrowedAmount,
    );
    const currentPrice = stable
      ? 1
      : d.amount > 0
        ? d.usd / d.amount
        : 0;
    const accruedUsd = positionAccruedAmount * currentPrice;
    const ageDays =
      agg.firstBorrowTime != null
        ? Math.max(
            0.5 / 24,
            (Date.now() / 1000 - agg.firstBorrowTime) / 86_400,
          )
        : null;
    const originalPrincipalUsd =
      positionNetBorrowedAmount *
      (stable ? 1 : (agg.firstBorrowPrice ?? currentPrice));
    const borrowAprPct =
      originalPrincipalUsd > 0 && ageDays != null && ageDays > 0
        ? (accruedUsd / originalPrincipalUsd) * (365 / ageDays) * 100
        : null;
    borrows.push({
      symbol: d.symbol,
      firstBorrowTime: agg.firstBorrowTime,
      ageDays,
      netBorrowedAmount: positionNetBorrowedAmount,
      originalPrincipalUsd,
      currentDebtAmount: d.amount,
      currentDebtUsd: d.usd,
      accruedInterestAmount: positionAccruedAmount,
      accruedInterestUsd: accruedUsd,
      borrowAprPct,
    });
  }

  const accruedInterestUsd = borrows.reduce(
    (s, b) => s + b.accruedInterestUsd,
    0,
  );
  let aprWSum = 0;
  let denom = 0;
  for (const b of borrows) {
    if (b.borrowAprPct == null) continue;
    aprWSum += b.borrowAprPct * b.originalPrincipalUsd;
    denom += b.originalPrincipalUsd;
  }
  const borrowAprPct = denom > 0 ? aprWSum / denom : null;

  return {
    healthFactor: hf,
    liquidationBufferPct,
    currentLtvPct,
    borrowRoomUsd,
    accruedInterestUsd,
    borrowAprPct,
    borrows,
  };
}

/* ------------------------------ main -------------------------------------- */

export function computeDashboardMetrics(
  loaded: Loaded[],
  annotations: OpAnnotations,
  opts: ComputeOptions,
): DashboardMetrics {
  // ----- Стартовый капитал -----
  const startMap = new Map<FiatCurrency, StartCapitalByCur>();
  let earliestEntryMs = 0;
  let manualCreditUsd = 0;
  // Зафиксированный стартовый капитал в долларах — Σ по пометкам.
  // Это НЕ пересчитывается по текущему курсу: для каждой пометки берём
  // её зафиксированный `usdAmount` (доллары, реально купленные за фиат
  // на момент входа). Только legacy-пометки без usdAmount конвертируются
  // по текущему курсу как fallback.
  let startUsdFixed = 0;

  for (const l of loaded) {
    for (const op of l.ops) {
      const k = annotationKey({
        walletId: l.wallet.id,
        chain: op.chain,
        hash: op.hash,
      });
      const ann = annotations[k];
      if (!ann) continue;
      if (ann.fiatPurchase) {
        const fp = ann.fiatPurchase;
        const cur = startMap.get(fp.fiatCurrency) ?? {
          currency: fp.fiatCurrency,
          totalFiat: 0,
          opsCount: 0,
        };
        cur.totalFiat += fp.fiatAmount;
        cur.opsCount += 1;
        startMap.set(fp.fiatCurrency, cur);
        // Стартовый капитал в $ — фиксированный.
        //   1) usdAmount задан → берём как есть (не трогаем курсом);
        //   2) валюта USD → fiatAmount уже в долларах;
        //   3) иначе (legacy без usdAmount) → конвертация по текущему курсу.
        if (
          typeof fp.usdAmount === "number" &&
          Number.isFinite(fp.usdAmount) &&
          fp.usdAmount >= 0
        ) {
          startUsdFixed += fp.usdAmount;
        } else if (fp.fiatCurrency === "USD") {
          startUsdFixed += fp.fiatAmount;
        } else if (opts.usdRub > 0) {
          startUsdFixed += fp.fiatAmount / opts.usdRub;
        }
        const tMs = op.time * 1000;
        if (earliestEntryMs === 0 || tMs < earliestEntryMs) earliestEntryMs = tMs;
      }
      if (ann.credit) {
        const inMv = op.movement.find(
          (mv) => mv.direction === "in" && mv.amount > 0,
        );
        if (inMv?.usd != null) manualCreditUsd += inMv.usd;
      }
    }
  }
  const startCapital = [...startMap.values()].sort(
    (a, b) => b.totalFiat - a.totalFiat,
  );
  // Стартовый капитал в $ = Σ зафиксированных usdAmount по пометкам.
  // Фиксированная величина: не «дышит» от текущего курса рубля. Курсовая
  // переоценка отражается только в ТЕКУЩЕМ капитале и PnL, а не в стартовом.
  const startUsdAll = startUsdFixed;
  // Стартовый капитал в ₽ — фиксированная Σ рублёвых пометок (тоже не
  // пересчитывается обратно из долларов).
  const startRub = startMap.get("RUB")?.totalFiat ?? 0;

  // ----- Wallet balances -----
  // КРИТИЧНО: исключаем receipt-токены (aTokens, cTokens, GM/GLV, vBNT,
  // variableDebt, и т.д.) — это расписки на активы, которые УЖЕ учтены
  // в `protocolsAssetUsd` (через DeFi-позиции). Если их оставить — общий
  // капитал задвоится: Aave V3 supply $34k + aEthWETH $34k = $68k.
  //
  // Receipt-токены остаются ВИДИМЫМИ в списке балансов кошелька (их можно
  // увидеть открыв виджет), но НЕ суммируются в total portfolio.
  //
  // Параллельно считаем `walletStartUsd` = Σ (amount × WAC) — сколько
  // пользователь реально заплатил за то, что сейчас лежит на кошельке.
  // Используется как fallback для «Стартовый капитал» когда нет ручных
  // фиат-аннотаций.
  let walletUsd = 0;
  let walletStartUsd = 0;
  // Cross-wallet WAC: токены могут быть на нескольких кошельках, и WAC
  // считается per-wallet. Если на одном кошельке нет cost basis (получили
  // через transfer_in), берём avg по всем своим кошелькам как fallback.
  const trackerByWallet = new Map<string, ReturnType<typeof buildCostBasisTracker>>();
  for (const l of loaded) {
    trackerByWallet.set(
      l.wallet.id,
      buildCostBasisTracker(l.ops, new Map<string, number>()),
    );
  }
  function crossWalletAvg(symbol: string): number | null {
    let totalCost = 0;
    let totalAmount = 0;
    for (const [, tr] of trackerByWallet) {
      const avg = tr.currentAvg(symbol);
      const amt = tr.currentAmount(symbol);
      if (avg != null && avg > 0 && amt > 0) {
        totalCost += avg * amt;
        totalAmount += amt;
      }
    }
    return totalAmount > 0 ? totalCost / totalAmount : null;
  }
  for (const l of loaded) {
    if (!l.live) continue;
    const tracker = trackerByWallet.get(l.wallet.id);
    for (const t of l.live.tokens) {
      if (t.amount <= 0) continue;
      if (isProtocolToken(t.symbol)) continue;
      walletUsd += t.usd;
      // Cost basis: сначала per-wallet WAC, иначе cross-wallet avg.
      // Стейблы — $1 (WAC покупки = $1 для USDC/USDT/DAI, не считаем).
      if (isStableSymbol(t.symbol)) {
        walletStartUsd += t.amount; // 1 USDC = $1 на момент покупки
        continue;
      }
      const wac = tracker?.currentAvg(t.symbol);
      if (wac != null && wac > 0) {
        walletStartUsd += t.amount * wac;
      } else {
        const cwAvg = crossWalletAvg(t.symbol);
        if (cwAvg != null && cwAvg > 0) {
          walletStartUsd += t.amount * cwAvg;
        } else {
          // Нет данных о покупке (transfer_in без истории) — берём текущую
          // цену как proxy. PnL по этому токену = 0.
          walletStartUsd += t.usd;
        }
      }
    }
  }

  // ----- Open positions (тот же источник, что Лист открытых позиций) -----
  // КРИТИЧНО: histPrices обязательно для long-term позиций — без него
  // startUsd считается по сегодняшней цене вместо цены на момент tx.
  const positions =
    opts.positions ??
    buildOpenPositions(
      loaded.map((l) => ({
        wallet: l.wallet,
        ops: l.ops,
        ...(l.live !== undefined && { live: l.live }),
      })),
      opts.histPrices ? { histPrices: opts.histPrices } : undefined,
    );
  // Map walletId → ops для borrow-interest расчёта.
  const opsByWallet = new Map<string, ClassifiedOp[]>();
  for (const l of loaded) opsByWallet.set(l.wallet.id, l.ops);

  // ----- Группировка по протоколам -----
  const protoMap = new Map<
    string,
    {
      protocolId: string;
      protocolName: string;
      chain: string;
      wallets: Set<string>;
      assetUsd: number;
      debtUsd: number;
      startUsd: number;
      feesClaimedUsd: number;
      feesPendingUsd: number;
      positions: OpenPosition[];
      lendingPositions: OpenPosition[];
      walletIds: Set<string>;
    }
  >();
  for (const p of positions) {
    // Ключ по (protocolId, chain) — иначе Aave V3 на Polygon и Arbitrum
    // слипаются в одну запись, debt из обеих сетей суммируется через ops
    // одного кошелька, и в UI чейн показывается рандомный.
    const key = `${p.protocol.id}::${p.chain}`;
    const ex = protoMap.get(key) ?? {
      protocolId: p.protocol.id,
      protocolName: p.protocol.name,
      chain: p.chain,
      wallets: new Set<string>(),
      assetUsd: 0,
      debtUsd: 0,
      startUsd: 0,
      feesClaimedUsd: 0,
      feesPendingUsd: 0,
      positions: [] as OpenPosition[],
      lendingPositions: [] as OpenPosition[],
      walletIds: new Set<string>(),
    };
    ex.wallets.add(p.walletName);
    ex.walletIds.add(p.walletId);
    ex.assetUsd += p.currentUsd;
    ex.debtUsd += p.currentDebtUsd;
    ex.startUsd += p.startUsd;
    ex.feesClaimedUsd += p.feesClaimedUsd;
    ex.feesPendingUsd += p.feesUsd ?? 0;
    ex.positions.push(p);
    if (p.kind === "lending") ex.lendingPositions.push(p);
    protoMap.set(key, ex);
  }

  const protocolsAssetUsd = positions.reduce((s, p) => s + p.currentUsd, 0);
  const protocolsDebtUsd = positions.reduce(
    (s, p) => s + p.currentDebtUsd,
    0,
  );
  // Точная копия формулы из Лист открытых позиций (computeAnalytics):
  //   investedUsd = Σ startUsd
  //   totalAssetsUsd = Σ currentUsd + Σ feesLifetime (pending + claimed)
  //   totalPnlUsd = totalAssetsUsd − investedUsd
  // Эту цифру показываем в шапке «Активы в проектах», чтобы всегда совпадала.
  const protocolsInvestedUsd = positions.reduce(
    (s, p) => s + p.startUsd,
    0,
  );
  const protocolsPendingUsd = positions.reduce(
    (s, p) => s + (p.feesUsd ?? 0),
    0,
  );
  const protocolsClaimedUsd = positions.reduce(
    (s, p) => s + p.feesClaimedUsd,
    0,
  );
  // Total assets = sum of `totalAssetsOf(p)` — protect against double-count
  // для supply_yield positions (Aave aTokens, etc.) где currentUsd УЖЕ
  // включает накопленный yield (rebase). Складывать pending feesUsd c
  // currentUsd для них = double count (POS-006 Aave WETH: $35,604 current
  // уже содержит 0.648 WETH yield, не плюсуем ещё $1,508 feesUsd).
  const protocolsTotalAssetsUsd = positions.reduce(
    (s, p) => s + totalAssetsOf(p),
    0,
  );
  const protocolsTotalPnlUsd =
    protocolsTotalAssetsUsd - protocolsInvestedUsd;
  const protocolsTotalPnlPct =
    protocolsInvestedUsd > 0
      ? (protocolsTotalPnlUsd / protocolsInvestedUsd) * 100
      : null;
  const protocolsNetUsd = protocolsAssetUsd - protocolsDebtUsd;
  const totalAssetsUsd = walletUsd + protocolsAssetUsd; // как в Открытых позициях
  const totalDebtUsd = protocolsDebtUsd + manualCreditUsd;
  const ownCapitalUsd = totalAssetsUsd - totalDebtUsd;

  // ----- Per-protocol breakdown + lending -----
  const denomAsset = Math.max(0.01, protocolsAssetUsd);
  const protocols: ProtocolBreakdown[] = [...protoMap.values()]
    .map((p) => {
      // Total PnL = current + lifetime fees (pending+claimed) − start
      // (как в OpenPositionsPage). Pending входит в полную стоимость позиции.
      const totalPnlUsd =
        p.assetUsd + p.feesPendingUsd + p.feesClaimedUsd - p.startUsd;
      const totalPnlPct =
        p.startUsd > 0 ? (totalPnlUsd / p.startUsd) * 100 : null;

      let lending: LendingMetrics | undefined;
      if (p.lendingPositions.length > 0) {
        // Aggregate по всем lending-позициям протокола.
        let totalCollateral = 0;
        let totalDebt = 0;
        let hfWSum = 0;
        let hfDenom = 0;
        // Аггрегируем долг по (wallet, debt_symbol), а не per-position.
        // Иначе один и тот же borrow op'ы из истории привязывались к двум
        // позициям с одинаковым debt-токеном и net_borrowed считался дважды.
        const debtByKey = new Map<
          string,
          {
            walletId: string;
            chain: string;
            symbol: string;
            amount: number;
            usd: number;
          }
        >();
        for (const pos of p.lendingPositions) {
          totalCollateral += pos.currentUsd;
          totalDebt += pos.currentDebtUsd;
          if (pos.healthRate != null) {
            hfWSum += pos.healthRate * pos.currentDebtUsd;
            hfDenom += pos.currentDebtUsd;
          }
          for (const d of pos.debtTokens) {
            if (d.amount <= 0) continue;
            // Ключ включает chain — иначе Aave Polygon и Aave Arbitrum
            // в одном кошельке слипаются по одному debt-символу.
            const k = `${pos.walletId}|${pos.chain}|${d.symbol}`;
            const ex = debtByKey.get(k) ?? {
              walletId: pos.walletId,
              chain: pos.chain,
              symbol: d.symbol,
              amount: 0,
              usd: 0,
            };
            ex.amount += d.amount;
            ex.usd += d.usd;
            debtByKey.set(k, ex);
          }
        }
        const allBorrows: BorrowInterest[] = [];
        for (const d of debtByKey.values()) {
          const ops = opsByWallet.get(d.walletId) ?? [];
          allBorrows.push(
            computeBorrowInterestForToken({
              ops,
              protocolId: p.protocolId,
              chain: d.chain,
              symbol: d.symbol,
              currentDebtAmount: d.amount,
              currentDebtUsd: d.usd,
            }),
          );
        }
        const aggHF = hfDenom > 0 ? hfWSum / hfDenom : null;
        const aggLtv =
          totalCollateral > 0 ? (totalDebt / totalCollateral) * 100 : null;
        const aggBuffer =
          aggHF != null && aggHF > 0
            ? Math.max(0, (1 - 1 / aggHF) * 100)
            : null;
        const aggRoom =
          aggHF != null && aggHF > 0 && totalDebt > 0
            ? totalDebt * (aggHF - 1)
            : null;
        const aggAccrued = allBorrows.reduce(
          (s, b) => s + b.accruedInterestUsd,
          0,
        );
        let aprWSum = 0;
        let aprDenom = 0;
        for (const b of allBorrows) {
          if (b.borrowAprPct == null) continue;
          aprWSum += b.borrowAprPct * b.originalPrincipalUsd;
          aprDenom += b.originalPrincipalUsd;
        }
        const aggApr = aprDenom > 0 ? aprWSum / aprDenom : null;
        lending = {
          healthFactor: aggHF,
          currentLtvPct: aggLtv,
          liquidationBufferPct: aggBuffer,
          borrowRoomUsd: aggRoom,
          accruedInterestUsd: aggAccrued,
          borrowAprPct: aggApr,
          borrows: allBorrows,
        };
      }

      return {
        protocolId: p.protocolId,
        protocolName: p.protocolName,
        chain: p.chain,
        walletNames: [...p.wallets],
        assetUsd: p.assetUsd,
        debtUsd: p.debtUsd,
        netUsd: p.assetUsd - p.debtUsd,
        startUsd: p.startUsd,
        feesClaimedUsd: p.feesClaimedUsd,
        feesPendingUsd: p.feesPendingUsd,
        totalPnlUsd,
        totalPnlPct,
        shareOfWork: Math.max(0, p.assetUsd) / denomAsset,
        positions: p.positions,
        ...(lending && { lending }),
      };
    })
    .sort((a, b) => b.assetUsd - a.assetUsd);

  // ----- Сводная борроу-аналитика -----
  let accruedInterestUsd = 0;
  let protocolPrincipalUsd = 0;
  let aprWSum = 0;
  let aprDenom = 0;
  for (const p of protocols) {
    if (!p.lending) continue;
    accruedInterestUsd += p.lending.accruedInterestUsd;
    for (const b of p.lending.borrows) {
      protocolPrincipalUsd += b.originalPrincipalUsd;
      if (b.borrowAprPct == null) continue;
      aprWSum += b.borrowAprPct * b.originalPrincipalUsd;
      aprDenom += b.originalPrincipalUsd;
    }
  }
  const borrowAprPct = aprDenom > 0 ? aprWSum / aprDenom : null;

  // Effective start = ручной startUsdAll, иначе derived (wallet + protocols).
  const startUsdDerived = walletStartUsd + protocolsInvestedUsd;
  const startUsdEffective = startUsdAll > 0 ? startUsdAll : startUsdDerived;

  return {
    startCapital,
    startUsdAll,
    walletStartUsd,
    startUsdEffective,
    startRub,
    walletUsd,
    protocolsAssetUsd,
    protocolsDebtUsd,
    protocolsNetUsd,
    totalAssetsUsd,
    manualCreditUsd,
    totalDebtUsd,
    accruedInterestUsd,
    protocolPrincipalUsd,
    dividendsPendingUsd: protocols.reduce(
      (s, p) => s + p.feesPendingUsd,
      0,
    ),
    dividendsClaimedUsd: protocols.reduce(
      (s, p) => s + p.feesClaimedUsd,
      0,
    ),
    dividendsTotalUsd: protocols.reduce(
      (s, p) => s + p.feesPendingUsd + p.feesClaimedUsd,
      0,
    ),
    protocolsInvestedUsd,
    protocolsTotalPnlUsd,
    protocolsTotalPnlPct,
    borrowAprPct,
    ownCapitalUsd,
    totalGasUsd: loaded.reduce((s, l) => s + (l.snapshot.totalGasUsd ?? 0), 0),
    realizedPnlUsd: loaded.reduce(
      (s, l) => s + (l.snapshot.realizedPnlUsd ?? 0),
      0,
    ),
    protocols,
    earliestEntryMs,
  };
}
