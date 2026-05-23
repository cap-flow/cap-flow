/**
 * Открытые позиции в DeFi-протоколах.
 *
 * **Источник правды — live-state протокола** (DeBank для EVM, Helius/Vybe/
 * Sonar для Solana). Каждая `LiveProtocolPosition` = одна запись в листе.
 *  - Fluid с двумя сабпозициями (ETH-залог и WBTC-залог) даст два ряда.
 *  - GMX V2 LP WETH/USDC и WBTC/USDC — два ряда.
 *  - Закрытые on-chain позиции просто не появятся (как и должно быть).
 *
 * **Стартовая стоимость** считается так:
 *  - Для каждого supply-токена позиции — currentAmount × runningAvg.
 *  - runningAvg = Σ всех заплаченных стейблов за этот токен / Σ всех
 *    купленных amount, кумулятивно за всю историю кошелька. Это и есть
 *    «средневзвешенная цена покупки актива» по методике пользователя.
 *  - Если по токену не было swap-покупок за стейблы — fallback на
 *    `m.usd` из открывающего lp_add/lend_supply (DeBank current price).
 *
 * **Дата открытия** — самая ранняя `lp_add`/`lend_supply`/`stake`/
 * `perp_open` в истории кошелька, у которой
 *   `op.protocol.id === position.protocolId`
 *   и `op.movement` содержит OUT с символом из `position.supply`.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * ⚠️  COST BASIS МЕТОДОЛОГИЯ — ОБЯЗАТЕЛЬНЫЙ ЧЕК-ЛИСТ
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 * Прежде чем менять что-то связанное со startUsd / cost basis — прочти
 * `notes/decisions/receipt-token-cost-basis.md`. Этот баг рецидивировал
 * 3 раза (2026-05-08, 2026-05-09 утро, 2026-05-09 вечер).
 *
 * КРАТКО:
 *   1. Cost basis = OUT-side USD (что пользователь потратил из кошелька)
 *   2. DeBank `m.usd` для входящих **receipt-токенов** (GM/GLV/aToken/
 *      fVLT/BPT/PT/YT) = current_spot × amount, **НЕ** historical.
 *      НИКОГДА не использовать для cost basis.
 *   3. `supplyTokens` от DeBank это live-redemption decomposition, для
 *      single-aggregated-receipt позиций (GMX V2 GM, GLV, Balancer BPT,
 *      Fluid Vault) per-asset cost basis синтетический → нельзя суммировать
 *   4. Различай single-receipt vs multi-receipt через `distinctReceipts.size`
 *      (см. строки ~1497-1517 ниже).
 *
 * Иерархия источников USD для cost basis:
 *   1. LotTracker WAC at op.time × out-amount         ← наиболее точный
 *   2. DefiLlama hist price × out-amount              ← swap-style ops
 *   3. Stable check (USDC/USDT/DAI/...) → $1
 *   4. DeBank `m.usd` для NON-protocol token         ← fallback
 *   5. DeBank `m.usd` для PROTOCOL token              ← НИКОГДА
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 */

import { defillamaCoinKey, priceFromMap } from "@/lib/defillama";
import { isJunkOp } from "./junk_filter";
import { isStableSymbol } from "./protocols";
import { isReceiptLessProtocol, isReceiptOfProtocol } from "./token_roles";
import { supplyAmountsHash } from "./position_overrides";
import { buildCostBasisTracker, CostBasisTracker } from "./cost_basis_tracker";
import { buildLotTrackerFromOps } from "./lots/build";
import { PerWalletLotTrackerView } from "./lots/compat";
import type { LotTracker } from "./lots/lot_tracker";

/**
 * UCB C5: union type для tracker'ов — legacy `CostBasisTracker` (cumulative
 * WAC без CEX/manual/bridge overrides) или `PerWalletLotTrackerView`
 * (legacy 2-arg API над новым `LotTracker` с full UCB-обогащением).
 * Оба имеют одинаковый shape для `avgAt`/`currentAvg`/`currentAmount`,
 * downstream-функции работают с любым.
 */
type LotTrackerLike = CostBasisTracker | PerWalletLotTrackerView;
import { readPipelineSettings } from "./pipeline_settings";
import type { LiveSnapshot, LiveProtocolPosition } from "./live";
import type { ClassifiedOp, ProtocolInfo, TokenMovement } from "./types";
import type { SavedWallet } from "@/lib/wallets";

const OPEN_TYPES = new Set<ClassifiedOp["type"]>([
  "lend_supply",
  "lp_add",
  "stake",
  "perp_open",
]);

const CLOSE_TYPES = new Set<ClassifiedOp["type"]>([
  "lend_withdraw",
  "lp_remove",
  "unstake",
  "perp_close",
]);

export type PositionKind = "lending" | "lp" | "staking" | "perp" | "other";

function kindFromCategory(cat: string): PositionKind {
  const c = cat.toLowerCase();
  if (c.includes("lend") || c.includes("cdp") || c.includes("borrow"))
    return "lending";
  if (
    c.includes("lp") ||
    c.includes("liquidity") ||
    c.includes("yield") ||
    c.includes("vault") ||
    c.includes("farm") ||
    c.includes("deposit") // Pendle V2 itemName="Deposit"
  )
    return "lp";
  if (c.includes("stak") || c.includes("restak")) return "staking";
  if (c.includes("perp")) return "perp";
  return "other";
}

function normalizeSymbol(s: string): string {
  const u = s.toUpperCase();
  if (u === "WETH") return "ETH";
  return u;
}

export interface OpenPositionToken {
  symbol: string;
  /** Кол-во в позиции сейчас (live). */
  amount: number;
  /**
   * Начальное кол-во токена, реально внесённое в позицию (сумма по
   * lend_supply / lp_add tx за текущий открытый цикл, минус частичные
   * выводы). Источник данных тот же, что у `startUsd`:
   *   - LotTracker `consumed.amount` (приоритет) — replays ops через
   *     UCB-пайплайн, даёт точное «сколько токенов user внёс».
   *   - `cycleDeposit.amount` — fallback, агрегат out-movements по
   *     протоколу/chain в текущем цикле.
   *   - `amount` (live) — last-resort если ни один tracker не нашёл
   *     deposit ops (нишевой протокол / неполная история).
   */
  startAmount: number;
  /** Текущая стоимость в $ (live: amount × current_price). */
  currentUsd: number;
  /** Средневзвешенная покупочная цена ($ за единицу) или null. */
  avgBuyPrice: number | null;
  /** Стоимость по cost basis: amount × avgBuyPrice (или fallback m.usd). */
  startUsd: number;
  /** Откуда взяли цену: 'cost_basis' (running avg) или 'fallback'. */
  priceSource: "cost_basis" | "fallback";
  /**
   * UCB C5 Phase F (Task #19): сколько из `startUsd` пришло из silent
   * m.usd fallback (DeBank current spot вместо реальных трат). > 0
   * означает что LotTracker не имел данных для этого символа в момент
   * supply, и hist-цена тоже была недоступна → cost basis имеет
   * unknown provenance.
   *
   * UI может surface это badge'м "⚠ cost basis derived from spot price"
   * для предупреждения пользователя что startUsd может быть искажён.
   *
   * Anti-recurrence pattern #1 (silent fallbacks): этот флаг — explicit
   * signal вместо тихого fallback'а.
   */
  fallbackUsd?: number;
  /**
   * Адрес underlying токена (без chain prefix). Нужен для on-chain
   * lookup'ов: Aave LT/LTV per asset, oracle price, и т.д.
   */
  tokenId?: string;
}

/**
 * Детали для V3-style concentrated liquidity позиций (Uniswap V3/V4,
 * PancakeSwap V3, Algebra, SushiSwap V3, Maverick, …).
 *
 * В V3 LP пользователь указывает диапазон [P_lower, P_upper] и вносит
 * пару токенов в пропорции, требуемой формулой пула. По мере движения
 * цены токены ребалансируются: при росте цены пул продаёт token0 (волатильный)
 * за token1, при падении — наоборот. Отсюда **impermanent loss** относительно
 * стратегии HODL (просто держать токены при себе).
 *
 *   IL = HODL_value − Current_LP_value
 *   где HODL_value = Σ deposit_amount_i × current_price_i
 *
 * Если `IL > 0` — пул отстаёт от HODL (плохо). Если `IL < 0` — пул обогнал
 * HODL (редко, но бывает на nicely-priced ranges с большим объёмом fees).
 */
export interface V3Details {
  /** Что и сколько было внесено в позицию (Σ по lp_add). */
  depositTokens: { symbol: string; amount: number; usdAtDeposit: number }[];
  /** Σ usdAtDeposit — реальная USD-стоимость на момент депозита. */
  depositUsd: number;
  /** Σ deposit_amount × current_price — стоимость, если бы держал HODL. */
  hodlUsd: number;
  /** HODL − Current = impermanent loss (>0 = LP проиграл HODL). */
  impermanentLossUsd: number;
  /** Текущая стоимость LP-позиции (live.assetUsd). */
  currentLpUsd: number;
  /** PnL = currentLp − depositUsd. */
  pnlUsd: number;
  /** PnL% от depositUsd. */
  pnlPct: number;
  /** Откуда брали цены при депозите: 'historical' (DefiLlama) | 'fallback' (m.usd). */
  pricesSource: "historical" | "fallback" | "mixed";
}

export interface OpenPosition {
  /** Сквозной id POS-NNN. */
  id: string;
  walletId: string;
  walletName: string;
  walletChain: SavedWallet["chain"];
  chain: string;
  protocol: ProtocolInfo;
  kind: PositionKind;
  /** Имя сабпозиции (Lending / Liquidity Pool / Smart Vault / …). */
  itemName: string;
  /** unix sec — первое открытие в истории, либо null если открытия не нашли. */
  openedAt: number | null;
  /** Хэш tx, открывшей позицию (если найдена). */
  openHash: string | null;
  /** Срок в днях (now − openedAt), или null. */
  ageDays: number | null;

  /** Токены в supply-стороне позиции. */
  supplyTokens: OpenPositionToken[];
  /** Токены в borrow (для lending). */
  debtTokens: { symbol: string; amount: number; usd: number }[];

  /**
   * Реально внесённые в позицию активы — то, что user signed в
   * deposit-tx'ах (как они называются в блокчейне). Отличается от
   * `supplyTokens` тем, что `supplyTokens` приходит из `live.supply` =
   * декомпозиция receipt-токена (для GMX V2 GM / Morpho-GLV / Fluid
   * fVLT API раскладывает 1 GM на условные 0.5 ETH + 1500 USDC).
   *
   * Правила выбора per supply/lp_add op:
   *   1. OUT-side movement с `isProtocolToken=true` (collateral-receipt
   *      переложен в другой протокол, e.g. GLV → Morpho).
   *   2. Иначе IN-side movement с `isProtocolToken=true` (минт receipt'а
   *      из underlying, e.g. USDC → GM в GMX V2 deposit).
   *   3. Иначе OUT-side обычное движение (Aave/Fluid/Compound: ETH/WBTC/USDC).
   *
   * Aggregation: amounts суммируются по symbol через multiple deposit
   * tx'ы; partial withdraw'ы не вычитаются (это semantics «начально
   * вложено», не «сейчас в позиции»).
   */
  openedInTokens: { symbol: string; amount: number; tokenId?: string }[];

  /** Σ usd по supplyTokens.startUsd — сумма входа (gross collateral cost). */
  startUsd: number;
  /**
   * UCB D7: NET cash, который user реально вложил в позицию = startUsd −
   * borrow proceeds at origin + repay outlay at origin. Для leveraged
   * lending: supply $10k WETH + borrow $5k USDC → netStartUsd ≈ $5k
   * (user'у было $5k извлечено через borrow). Для no-borrow позиций
   * netStartUsd === startUsd.
   *
   * Источник: сумма borrow.inTokens.usd − repay.outTokens.usd по всем
   * position events. USD считается по hist-price на момент события.
   *
   * Display layer показывает обе цифры: "Gross $10k · Net $5k (2× leverage)".
   * APR/ROI calc'и могут опционально использовать netStartUsd для отражения
   * leverage'а.
   */
  netStartUsd: number;
  /** Σ usd по supplyTokens.currentUsd — текущая стоимость залога. */
  currentUsd: number;
  /** Σ usd по debtTokens — текущий долг. */
  currentDebtUsd: number;
  /** Health rate (для lending). */
  healthRate: number | null;
  /** V3-style concentrated-liquidity детали (Uniswap V3, PancakeSwap V3, ...). */
  v3?: V3Details;

  /**
   * Накопленные **в данный момент** fees / yield внутри позиции (pending).
   *  - Для V3 LP — Σ uncollected fees из `lp.rewards` (DeBank).
   *  - Для lending — `(current_supply_amount − Σ deposited) × current_price`,
   *    т.е. начисленные процентные доходы от supply (не зависит от движения цены).
   *  - Для прочих — null.
   */
  feesUsd: number | null;
  /** Источник fees — "v3_rewards" или "supply_yield". */
  feesSource: "v3_rewards" | "supply_yield" | null;
  /**
   * Уже **снятые** fees: Σ всех `claim_rewards` ops по этому
   * (protocolId × chain × wallet). USD считается по hist-ценам в момент claim
   * с fallback на m.usd.
   */
  feesClaimedUsd: number;
  /**
   * Σ `feesUsd` (pending) + `feesClaimedUsd` (claimed) — полная история
   * fee-генерации за всё время жизни позиции.
   */
  feesLifetimeUsd: number;
  /**
   * Annualized доходность fees: только pending (как раньше).
   *   feeApr = (feesUsd / startUsd) × (365 / ageDays) × 100
   */
  feeApr: number | null;
  /**
   * Annualized доходность fees по lifetime (pending + claimed).
   *   feeAprLifetime = (feesLifetimeUsd / startUsd) × (365 / ageDays) × 100
   */
  feeAprLifetime: number | null;
  /**
   * История снятий fee'ев по этой позиции: каждый `claim_rewards` op в
   * (protocolId × chain × pair). Для V3 используется per-pair фильтр и
   * pro-rata по `currentUsd` группы (с учётом нескольких NFT в одном пуле).
   *
   * Для popup'а — позволяет показать таблицу: дата | токены | USD | APR
   * за период (от предыдущего claim до текущего).
   *
   * Each event:
   *  - `time` — unix seconds
   *  - `usd` — USD value of received tokens at hist-prices (× pro-rata share)
   *  - `tokensReceived` — символы и amount'ы (× pro-rata share для multi-NFT)
   *  - `positionUsdAtClaim` — текущая стоимость позиции **на момент claim**
   *    (приближённо: `liveAssetUsd × usd_прирост_за_период / total_pnl_period`,
   *    или просто текущая live, если нет данных)
   *  - `aprPeriod` — annualized APR за период от предыдущего claim (или
   *    open) до этого: `(usd / positionUsdAtClaim) × (365 / period_days) × 100`
   *  - `pnlSincePrev` — изменение currentUsd от предыдущего claim (или open).
   */
  feesClaimedHistory: {
    time: number;
    hash: string;
    usd: number;
    tokensReceived: { symbol: string; amount: number; usd: number }[];
    positionUsdAtClaim: number | null;
    aprPeriod: number | null;
    daysSincePrev: number | null;
    pnlSincePrev: number | null;
    pnlSincePrevPct: number | null;
  }[];
  /**
   * Накопленный yield в самих токенах + native APR.
   * Для лендинга: `current_supply − Σ deposited` (для каждого supply-токена).
   * Для V3: каждый rewards-токен с amount.
   */
  feesByToken: {
    symbol: string;
    amount: number;
    usd: number;
    /** Native APR = (amount / deposited) × (365 / age_days) × 100 — только если deposited > 0 и age > 0. */
    nativeApr: number | null;
  }[];
  /**
   * Сколько USD текущей стоимости позиции профинансировано из кредитных
   * средств. По умолчанию `0` (свои); выставляется в `currentUsd` через
   * ручную метку в UI (см. `credit_overrides.ts`).
   */
  creditFundedUsd: number;
  /**
   * Позиция реконструирована из истории ops (нет live-источника). У такой
   * позиции `currentUsd` = сумма депозитов из истории, fees неизвестны;
   * пользователь обычно проставляет их вручную через `position_overrides`.
   * Применяется к Solana-протоколам, не покрытым Vybe / Jupiter Portfolio
   * (Flash Trade и т.п.).
   */
  inferred?: boolean;
  /**
   * Стабильный дискриминатор позиции — используется в `positionOverrideKey`
   * для уникальной идентификации этой строки. Без него позиции в одном пуле
   * с одинаковым `(walletId, chain, protocolId, symbols)` шарят override
   * (например, пометил POS-001 как credit → POS-002 тоже стал credit).
   *
   * Источник:
   *   - Inferred-позиции: openHash (стабилен между перезагрузками).
   *   - Live-позиции с одним маркетом: undefined (один на ключ).
   *   - **V3 LP NFT'ы / multi-position pools**: `supplyAmountsHash(supplyTokens)` —
   *     hash округлённых amount'ов уникален per-NFT даже если pool совпадает.
   */
  instanceId?: string;
  /**
   * NFT tokenId ИМЕННО этой OpenPosition, заматченной в
   * `applyV3CostBasisOverride` через openHash или amount-proximity.
   * Если задан — UI показывает `#{matchedV3TokenId}` в столбце TokenId
   * вместо "N NFTs" (group fallback). Не задан если override не нашёл match.
   */
  matchedV3TokenId?: string;
  /**
   * V3 LP: эта NFT — orphan (mint event не нашёлся в реестре). Возможные
   * причины:
   *   1. Mint произошёл ДО sync horizon (старый кошелёк, > 2 лет назад).
   *   2. NFT перенесена transfer'ом из другого адреса (мы видим её live,
   *      но историю по адресу не строим).
   *   3. **Multi-pool same-pair edge case**: 2 NFT в разных fee-tier'ах
   *      одного pair. matchV3LiveToMints матчит по amounts, разделяет
   *      mints между ними. Один из лайвов всё равно остаётся orphan, если
   *      mint его специфического pool'а отсутствует.
   *
   * Для orphan'ов мы НЕ применяем pair-only fallback (он подбирает
   * lp_add ops sibling-NFT'а и приписывает им чужой cost basis →
   * POS-007/008 bug). Вместо этого `startUsd = currentUsd` (честный
   * «не знаем историю — текущее значение»), `openedAt = null`,
   * UI показывает «⚠ Cost basis incomplete» badge.
   */
  coverageIncomplete?: boolean;
}

/**
 * Total assets позиции — currentUsd + lifetime fees, с **корректным учётом
 * по типу fees**:
 *
 * - **`feesSource === "supply_yield"`** (Aave aTokens, Compound cTokens,
 *   Fluid fTokens, etc.): rebase-style — supply amount растёт со временем,
 *   `currentUsd` УЖЕ включает накопленный yield. Pending fees здесь
 *   informational/derived view (`(current - Σdeposited) × price`),
 *   НЕ добавляем — иначе double-count (POS-006 Aave WETH: $35,604 current
 *   уже содержит 0.648 WETH yield, не складываем ещё $1,508).
 * - **`feesSource === "v3_rewards"`** (Uniswap V3 / PancakeSwap V3 /
 *   Aerodrome V3 etc.): fees — отдельный balance `tokensOwed0/1` ВНЕ
 *   ликвидности пула. `currentUsd` их НЕ включает. Складываем pending.
 * - **Прочие (`null`)**: feesUsd обычно null, ничего не складываем.
 *
 * `feesClaimedUsd` (уже снятые fee'и) ВСЕГДА добавляются — они переместились
 * на кошелёк и больше не входят в `currentUsd` позиции.
 */
export function totalAssetsOf(p: OpenPosition): number {
  const pendingFees = p.feesSource === "supply_yield" ? 0 : (p.feesUsd ?? 0);
  return p.currentUsd + pendingFees + p.feesClaimedUsd;
}

/** PnL = totalAssets - startUsd. Учитывает supply_yield rebase-style. */
export function totalPnlOf(p: OpenPosition): number {
  return totalAssetsOf(p) - p.startUsd;
}

/** Это пул concentrated-liquidity с диапазонами (V3-style)? */
export function isV3LpProtocol(name: string): boolean {
  // Исключаем lending-протоколы где "v3" не означает concentrated liquidity
  // (Aave V3, Compound V3 — это lending markets, не DEX'и).
  if (/\b(aave|compound|comet|morpho|fluid|spark|radiant|euler)\b/i.test(name)) {
    return false;
  }
  return /\b(v3|v4)\b|concentrat|maverick|trader\s*joe|liquidity\s*book|algebra|kim/i.test(
    name,
  );
}

interface BuildInput {
  wallet: SavedWallet;
  ops: ClassifiedOp[];
  live?: LiveSnapshot;
}

interface BuildOptions {
  /** Карта исторических цен от DefiLlama: ключ "{coin}|{tsHour}" → цена. */
  histPrices?: Map<string, number>;
  /**
   * Точные V3 pool prices на mint-блоке (через slot0). Приоритетный источник
   * USD-цен для V3 LP startUsd: совпадает с Revert Finance / Uniswap UI.
   * Ключ: `${chain}|${txHash}`.
   */
  v3MintPoolPrices?: Map<
    string,
    {
      price1Per0: number;
      token0: string;
      token1: string;
      decimals0: number;
      decimals1: number;
      anchorTokenAddress?: string;
      anchorTokenUsd?: number;
      exactAmount0?: string;
      exactAmount1?: string;
    }
  >;
  /**
   * CoinGecko USD цены на timestamp mint'а — **наивысший** приоритет для
   * V3 startUsd. Совпадает с методологией Revert Finance (CoinGecko
   * aggregator multi-venue, USDC ≠ exactly $1, byte-precise match).
   * Ключ: `${chain}|${txHash}`.
   */
  v3MintCgPrices?: Map<
    string,
    {
      byAddress: Map<string, number>;
      timestamp: number;
    }
  >;
  /**
   * UCB single-source-of-truth: per-wallet `LotTracker` from `lots/build.ts`.
   * Когда передан — `buildSupplyToken` использует консумированные лоты для
   * `startUsd`. Это устраняет расхождение между Lot-by-lot display и
   * position summary.
   */
  lotsByWallet?: Map<string, import("./lots").LotTracker>;
  /**
   * Cost basis overrides keyed by tx hash (shared across wallets).
   * Источник:
   *   - UCB D3 (CEX inheritance cost basis from server)
   *   - UCB A4 (manual `manualCostBasisUsd` annotations)
   * Передаётся в fresh LotTracker replay внутри
   * `computePositionConsumedCostFromLots` чтобы получить те же cost-per-unit
   * как и в `newTrackers.lotsByWallet` (single source of truth).
   */
  costBasisOverrideByHash?: ReadonlyMap<string, number>;
  /**
   * Universal on-chain audit для всех lending positions (Aave V3, Spark,
   * Compound V3, …). Когда задан, `computeFees` для supply_yield использует
   * `netDeposited` из этой map'ы вместо `depositAmountSum(ops, ...)` —
   * это устраняет ложный yield от пропущенных DeBank supply tx (см. POS-008:
   * 0.069 WBTC ghost yield = $5 282).
   *
   * Ключ: `${chain}|${walletAddress.toLowerCase()}|${underlyingTokenId.toLowerCase()}`
   * (как `lendingAuditKey` из `lib/lending/use_lending_audit.ts`).
   * Value содержит netDeposited (= Σ mint − Σ burn receipt-token'а) напрямую
   * с цепи через Etherscan tokentx.
   *
   * Поддержка протоколов определяется через `lib/lending/receipt_registry.ts`
   * (резолв receipt-token address). Unsupported protocols → entry отсутствует,
   * `computeFees` fallback на ops-derived sum.
   */
  lendingAuditByKey?: ReadonlyMap<
    string,
    {
      netDeposited: number;
      totalMinted: number;
      totalBurned: number;
      mintTxHashes: readonly string[];
      earliestMintTime: number | null;
    }
  >;
  /**
   * P1 V3 pool-address resolver: ключ `${chain}|${txHash.toLowerCase()}`,
   * значение = pool address (lowercase) или null если не найдено.
   * Заполняется в `useComputedPositions` через
   * `lib/v3/pool_lookup.ts::getV3PoolsForMintBatch` — парсит receipt'ы
   * V3 lp_add tx'ов, ищет `Mint(...)` event log пула.
   *
   * Используется в `matchV3LiveToMints`: точный матч live→mint по
   * pool address (DeBank даёт `lp.lpTokenId` = pool address). Это
   * убирает orphan-NFT баги для пользователей с несколькими NFT в
   * разных fee tiers того же pair'а (POS-007/008 PAXG/USDC bug).
   *
   * Fallback: если map'а пустая ИЛИ для конкретной tx pool unknown
   * (RPC fail, не V3 mint, etc.) — матчер использует старую
   * symbols+amounts heuristic.
   */
  v3PoolByTxHash?: ReadonlyMap<string, string | null>;
}

/**
 * Текущие spot-цены токенов из live-state (для расчёта HODL value в V3).
 * Берём `usd / amount` для всех токенов на балансах и в позициях.
 */
function buildCurrentPriceMap(loaded: BuildInput[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const l of loaded) {
    if (!l.live) continue;
    for (const t of l.live.tokens) {
      if (t.amount > 0 && t.usd > 0) {
        m.set(normalizeSymbol(t.symbol), t.usd / t.amount);
      }
    }
    for (const p of l.live.positions) {
      for (const s of p.supply) {
        if (s.amount > 0 && s.usd > 0) {
          m.set(normalizeSymbol(s.symbol), s.usd / s.amount);
        }
      }
    }
  }
  return m;
}

/**
 * Найти момент открытия ТЕКУЩЕЙ позиции (учитывает re-open после полного
 * закрытия).
 *
 * Раньше функция возвращала **самый ранний** open в истории — но если
 * пользователь открывал позицию N раз с полным закрытием между, срок
 * показывался от первого открытия 2 года назад вместо последнего вчера.
 *
 * Алгоритм: trail running balance per-symbol. Когда после close все
 * балансы ≤ 0 → это cycle reset. Текущая позиция = первый OPEN-event
 * ПОСЛЕ последнего cycle reset.
 */
function findFirstOpen(
  ops: ClassifiedOp[],
  protocolId: string,
  chain: string,
  targetSyms: Set<string>,
  /**
   * mint LP-receipt'а конкретного маркета (GMX V2: GM[BTC] vs GM[ETH] vs
   * GLV[WETH-USDC]). Если задан — фильтруем ops по `linkedLpTokenId` и/или
   * прямому protocol-token в movement, чтобы НЕ смешивать историю разных
   * маркетов одного протокола. Без этого все депозиты в GMX V2 (USDC →
   * любой GM market) сливаются в один цикл, и findFirstOpen возвращает
   * самую раннюю дату вместо открытия конкретно этого маркета.
   */
  lpTokenId?: string,
  /**
   * Расслабленный режим для receipt-less протоколов (Morpho Blue) и
   * случаев, когда live supply symbols != historical collateral symbols
   * (Morpho: live показывает WETH+USDC через unwrap GLV-vault, но в истории
   * был GLV out). При relax=true игнорируется фильтр `targetSyms.has(sym)`
   * — берётся любое meaningful out-движение (USD > $1, не газ).
   */
  relax: boolean = false,
): { time: number; hash: string } | null {
  // Сортируем хронологически.
  // Delegation-mint bypass: op.notes['delegation-mint'] выставляется
  // классификатором для smart-account / EIP-7702 mint-ов, где DeBank
  // не отдал project_id и наш fallback rule 11 создал synthetic op.
  // Для них:
  //   - op.type может быть 'lp_add' (если notes уже применён к op_type)
  //     ИЛИ 'unknown' (если server сихнул со старым classifier'ом и
  //     notes-only остался на jsonb-уровне).
  //   - opMatchesLpMarket strict-фейлится: movement.tokenId = NFT-instance-id,
  //     а lpTokenId = адрес NFT-manager-контракта.
  // Поэтому для таких ops пропускаем оба ограничения.
  const sorted = ops
    .filter(
      (op) => {
        if (op.status === "failed") return false;
        if (op.protocol?.id !== protocolId) return false;
        if (op.chain !== chain) return false;
        const isDelegation = op.notes?.includes("delegation-mint");
        if (isDelegation) return true;
        if (!(OPEN_TYPES.has(op.type) || CLOSE_TYPES.has(op.type))) return false;
        if (!opMatchesLpMarket(op, lpTokenId)) return false;
        return true;
      },
    )
    .sort((a, b) => a.time - b.time);

  if (sorted.length === 0) return null;

  // Helper: значимое out-движение для текущего режима.
  function isRelevantOut(m: TokenMovement): boolean {
    if (m.direction !== "out" || m.amount <= 0) return false;
    if (relax) {
      // Газ ETH (микро-amounts) исключаем.
      if (
        (m.symbol === "ETH" || m.symbol === "WETH") &&
        m.amount < 0.01 &&
        (m.usd ?? 0) < 100
      )
        return false;
      return (m.usd ?? 0) > 1; // > $1 = не trivial
    }
    return targetSyms.has(normalizeSymbol(m.symbol));
  }
  function isRelevantIn(m: TokenMovement): boolean {
    if (m.direction !== "in" || m.amount <= 0) return false;
    if (relax) return (m.usd ?? 0) > 1;
    return targetSyms.has(normalizeSymbol(m.symbol));
  }

  // Per-symbol running balance.
  const balanceBySym = new Map<string, number>();
  let lastCycleResetTime = 0;
  for (const op of sorted) {
    if (OPEN_TYPES.has(op.type)) {
      for (const m of op.movement) {
        if (!isRelevantOut(m)) continue;
        const sym = normalizeSymbol(m.symbol);
        balanceBySym.set(sym, (balanceBySym.get(sym) ?? 0) + m.amount);
      }
    } else if (CLOSE_TYPES.has(op.type)) {
      for (const m of op.movement) {
        if (!isRelevantIn(m)) continue;
        const sym = normalizeSymbol(m.symbol);
        balanceBySym.set(sym, (balanceBySym.get(sym) ?? 0) - m.amount);
      }
      // Cycle reset: после CLOSE все символы ушли в ≤ 0 → позиция была
      // полностью закрыта в этот момент. Запоминаем время сброса; следующий
      // OPEN запишется как «новое открытие».
      if (balanceBySym.size > 0) {
        let allClosed = true;
        for (const v of balanceBySym.values()) {
          if (v > 1e-6) {
            allClosed = false;
            break;
          }
        }
        if (allClosed) {
          lastCycleResetTime = op.time;
          balanceBySym.clear();
        }
      }
    }
  }

  // Первый OPEN-event ПОСЛЕ последнего cycle reset с релевантным OUT.
  for (const op of sorted) {
    if (op.time <= lastCycleResetTime) continue;
    if (!OPEN_TYPES.has(op.type)) continue;
    const hasOut = op.movement.some(isRelevantOut);
    if (!hasOut) continue;
    return { time: op.time, hash: op.hash };
  }
  return null;
}

/**
 * Σ deposit USD в текущем (открытом) цикле для конкретного supply-токена.
 *
 * Учитывает **любые** out-движения этого символа в ops с этим protocolId
 * и chain — даже если classifier не пометил их как `lp_add`/`lend_supply`/
 * `stake`. Это критично для нестандартных протоколов (Jupiter Perps,
 * нишевые SPL stakers), где Helius не возвращает чёткий type, и
 * classifier помечает депозит как `swap`/`unknown` — но out-движение
 * с правильным protocolId всё равно есть.
 *
 * `openedAt` — время первого OPEN события (от findFirstOpen). Если null,
 * берём всю историю. Withdraw-ы (in-движения) НЕ вычитаются — мы хотим
 * полную сумму инвестированного, не нетто.
 */
/**
 * Возвращает **cost basis по weighted-average на текущий момент** для
 * позиции в ребалансирующем пуле (GMX V2, GMSOL, Pendle, …). Это
 * семантически верное «Стартовая $»: «сколько USD реально вложено в то,
 * что СЕЙЧАС осталось в позиции», с учётом partial withdraw'ов.
 *
 * Алгоритм (WAC по receipt-токену):
 *   - Идём по ops хронологически, отфильтрованным по `lpTokenId`.
 *   - Для каждой op считаем: receiptIn (incoming GM/GLV match), receiptOut
 *     (outgoing того же mint'а), depositUsd (outgoing non-protocol non-gas
 *     USD — это что пользователь реально оплатил в этой tx).
 *   - Если op = «fill» (receiptIn > 0):
 *       costForFill = own depositUsd (для одно-tx-вход-Uni-V3) ИЛИ
 *                     depositUsd из связанной Tx A через `linkedHash`
 *                     (для async-deposit GMX V2 / GMSOL).
 *       state.amount += receiptIn; state.cost += costForFill.
 *   - Если op = «withdraw start» (receiptOut > 0):
 *       avg = state.cost / state.amount;
 *       state.cost -= receiptOut × avg;
 *       state.amount -= receiptOut.
 *   - Op'ы Tx A («deposit creator», только sends USD, no protocol-token movement)
 *     не обрабатываются здесь — их вклад подбирается через linkedHash от Tx B.
 *
 * В итоге `state.cost` = current cost basis оставшейся receipt-amount.
 * Если позиция полностью закрыта — вернётся 0.
 */
function currentCostBasisForPosition(
  ops: ClassifiedOp[],
  protocolId: string,
  chain: string,
  openedAt: number | null,
  lpTokenId?: string,
  /**
   * LotTracker (cost basis WAC по символам) — если передан, USD-стоимость
   * каждого outgoing depositа вычисляется как `amount × tracker.avgAt(sym, time)`,
   * а не `m.usd` (которое = `amount × current_spot_price`, искажает старые
   * операции где цена сильно изменилась). Это **универсальная asset-centric
   * методика**: каждый депозит атрибутируется к WAC актива на момент депозита.
   */
  lotTracker?: LotTrackerLike,
  /**
   * Исторические цены DefiLlama — для случаев когда у tracker нет WAC
   * по конкретному символу (transfer_in без предыдущей покупки). Использует
   * historical price на момент tx вместо `m.usd` (current spot).
   */
  histPrices?: Map<string, number>,
): { costUsd: number; receiptAmount: number } {
  // Индекс ops по hash для O(1) lookup linkedHash → linked op.
  const opByHash = new Map<string, ClassifiedOp>();
  for (const o of ops) opByHash.set(o.hash, o);

  // Receipt-less детект: только для протоколов из явного whitelist'а
  // (Morpho Blue, Drift Spot, Adrena). Для них пропускаем
  // opMatchesLpMarket-фильтр и считаем cost basis по out-движениям
  // underlying'ов через depositUsdFromOp.
  //
  // ВАЖНО: НЕ авто-детектить receipt-less по отсутствию matching receipt'а
  // в ops — Fluid использует fVLT NFT (per-position уникальный), но DeBank
  // отдаёт `pool.id` proxy-vault'а как `lpTokenId`. Без явного whitelist'а
  // авто-детект ошибочно классифицирует Fluid как receipt-less и складывает
  // все depositы из ВСЕХ Fluid-позиций в одну.
  const receiptLessMode = isReceiptLessProtocol(protocolId);

  const allProtoOps = ops.filter(
    (op) =>
      op.status !== "failed" &&
      op.protocol?.id === protocolId &&
      op.chain === chain &&
      (openedAt == null || op.time >= openedAt) &&
      op.type !== "claim_rewards",
  );

  // Сортируем ops по времени. Для receipt-less пропускаем opMatchesLpMarket.
  const sorted = allProtoOps
    .filter((op) => receiptLessMode || opMatchesLpMarket(op, lpTokenId))
    .sort((a, b) => a.time - b.time);

  const target = lpTokenId
    ? stripChainPrefix(lpTokenId).toLowerCase()
    : null;

  function isMatchingReceipt(m: { isProtocolToken: boolean; tokenId: string }): boolean {
    if (!m.isProtocolToken) return false;
    if (!target) return true; // если фильтра нет — любой protocol-token
    return stripChainPrefix(m.tokenId).toLowerCase() === target;
  }

  /**
   * USD-стоимость outgoing-движений op'а (что пользователь "вложил" в этот шаг).
   *
   * Приоритет источников:
   *   1. **Стейблы (USDC/USDT/DAI/...) → $1 ВСЕГДА**. lotTracker.avgAt может
   *      вернуть искажённое значение для стейблов из-за lp_remove attribution
   *      (когда LP закрылся в убыток, returned USDC получает inflated WAC > $1).
   *      Это создавало баг 2026-05-09 v4: POS-001 GMX V2 показывал startUsd
   *      $10,768 при депозите 9000 USDC потому что USDC WAC = $1.196.
   *   2. **LotTracker WAC at op.time × amount** — историчски точная стоимость
   *      для **non-stable** активов (ETH, WBTC, ARB).
   *   3. **DefiLlama hist price × amount** — fallback для non-stable если
   *      tracker не имеет WAC.
   *   4. m.usd (DeBank) — last-resort. Может искажать старые ops (current spot).
   *
   * Газ ETH (micro-amounts < 0.01 ETH) исключаем — это transaction fees, не вклад.
   * Protocol-receipt (GM/GLV/aTokens) исключаем — отдача receipt'а ≠ депозит.
   */
  function depositUsdFromOp(op: ClassifiedOp): number {
    let usd = 0;
    const opProtoId = op.protocol?.id ?? protocolId;
    for (const m of op.movement) {
      if (m.direction !== "out" || m.amount <= 0) continue;
      // Контекстная проверка: токен — receipt ДАННОГО протокола?
      // GLV в Morpho — НЕ receipt (это collateral). GM в GMX V2 — receipt.
      // Без этого 22.11 GLV-supply в Morpho терялся (GLV.isProtocolToken=true
      // глобально).
      if (isReceiptOfProtocol(m.symbol, opProtoId, m.tokenId)) continue;
      if (
        (m.symbol === "ETH" || m.symbol === "WETH") &&
        m.amount < 0.01 &&
        (m.usd ?? 0) < 100
      )
        continue;
      // Приоритет 1: Стейблы → $1 ВСЕГДА (обходим LotTracker).
      if (isStableSymbol(m.symbol)) {
        usd += m.amount * 1;
        continue;
      }
      // Приоритет 2: WAC из LotTracker (для non-stable).
      if (lotTracker) {
        const wac = lotTracker.avgAt(m.symbol, op.time);
        if (wac != null && wac > 0) {
          usd += m.amount * wac;
          continue;
        }
      }
      // Приоритет 2: historical price из DefiLlama (если передан).
      // Стейблы → $1.
      if (histPrices && histPrices.size > 0) {
        if (isStableSymbol(m.symbol)) {
          usd += m.amount * 1;
          continue;
        }
        const coin = defillamaCoinKey(op.chain, m.tokenId, m.symbol);
        if (coin) {
          const hp = priceFromMap(histPrices, coin, op.time);
          if (hp != null && hp > 0) {
            usd += m.amount * hp;
            continue;
          }
        }
      }
      // Приоритет 3: m.usd (DeBank current spot) как last-resort fallback.
      if (m.usd != null && m.usd > 0) usd += m.usd;
    }
    return usd;
  }

  let amount = 0;
  let cost = 0;
  // Для receipt-less протоколов (Morpho Blue) трекаем accumulated cost
  // через out-движения collateral asset'а с его LotTracker WAC.
  let receiptlessCost = 0;
  let sawAnyReceipt = false;

  // Receipt-less collateral detection: первый op с out-движением non-stable
  // non-receipt non-gas underlying = «collateral asset» этой позиции.
  // Все последующие ops с out этого ЖЕ символа = collateral supply (даже
  // если классификатор ошибочно пометил их как `repay`/`borrow`).
  // Ops с out ДРУГИХ символов игнорируем — это либо репай (если стейбл/
  // borrow-currency) либо отдельная позиция (другой Morpho-market).
  let collateralSymbol: string | null = null;
  if (receiptLessMode) {
    for (const op of sorted) {
      for (const m of op.movement) {
        if (m.direction !== "out" || m.amount <= 0) continue;
        if (isReceiptOfProtocol(m.symbol, op.protocol?.id ?? protocolId, m.tokenId)) continue;
        if (isStableSymbol(m.symbol)) continue; // стейблы скорее всего repay
        if (
          (m.symbol === "ETH" || m.symbol === "WETH") &&
          m.amount < 0.01 &&
          (m.usd ?? 0) < 100
        )
          continue; // gas
        collateralSymbol = normalizeSymbol(m.symbol);
        break;
      }
      if (collateralSymbol) break;
    }
  }

  for (const op of sorted) {
    let receiptIn = 0;
    let receiptOut = 0;
    for (const m of op.movement) {
      if (!isMatchingReceipt(m)) continue;
      if (m.direction === "in") receiptIn += m.amount;
      else if (m.direction === "out") receiptOut += m.amount;
    }
    if (receiptIn > 0 || receiptOut > 0) sawAnyReceipt = true;

    // Receipt пришёл — fill / depositTx с одно-tx-входом (Uni V3).
    if (receiptIn > 0) {
      let costForFill = depositUsdFromOp(op);
      if (costForFill === 0 && op.linkedHash) {
        const linked = opByHash.get(op.linkedHash);
        if (linked) costForFill = depositUsdFromOp(linked);
      }
      amount += receiptIn;
      cost += costForFill;
    }

    // Receipt ушёл — withdraw, списываем proportional cost.
    if (receiptOut > 0 && amount > 0) {
      const avg = cost / amount;
      const portionToRemove = Math.min(receiptOut, amount);
      cost -= portionToRemove * avg;
      amount -= portionToRemove;
      if (amount < 1e-9) {
        amount = 0;
        cost = 0;
      }
    }

    // Receipt-less учёт: для каждой op'и считаем USD-стоимость out-движений
    // именно `collateralSymbol`, а не всех out-токенов. Это игнорирует:
    //  - стейбл-репаи (USDC out для Morpho repay)
    //  - WBTC/другие коллатерали других Morpho-маркетов того же протокола
    // Подход устойчив к мис-классификации `repay` vs `lend_supply`.
    if (receiptLessMode && collateralSymbol) {
      for (const m of op.movement) {
        if (m.direction !== "out" || m.amount <= 0) continue;
        if (normalizeSymbol(m.symbol) !== collateralSymbol) continue;
        if (isReceiptOfProtocol(m.symbol, op.protocol?.id ?? protocolId, m.tokenId))
          continue;
        // Стоимость через LotTracker WAC (приоритет 1 в depositUsdFromOp).
        const wac = lotTracker?.avgAt(m.symbol, op.time) ?? null;
        if (wac != null && wac > 0) {
          receiptlessCost += m.amount * wac;
        } else if (m.usd != null && m.usd > 0) {
          receiptlessCost += m.usd;
        }
      }
    }
  }

  // Receipt-less mode (Morpho Blue): возвращаем cost basis из out-side
  // underlying'ов (через depositUsdFromOp с LotTracker WAC).
  if (receiptLessMode) {
    return { costUsd: receiptlessCost, receiptAmount: 0 };
  }
  // Sanity: если фильтр был по lpTokenId но за весь цикл receipt не появился
  // (linker дефолт не сработал) — fallback на receiptless-учёт.
  if (!sawAnyReceipt && receiptlessCost > 0) {
    return { costUsd: receiptlessCost, receiptAmount: 0 };
  }

  return { costUsd: cost, receiptAmount: amount };
}

function currentCycleDepositForSymbol(
  ops: ClassifiedOp[],
  protocolId: string,
  chain: string,
  openedAt: number | null,
  symbol: string,
  /** См. комментарий у findFirstOpen — фильтр по конкретному LP-маркету. */
  lpTokenId?: string,
  /**
   * Исторические цены DefiLlama (часовой bucket). Fallback когда tracker не
   * имеет WAC для (symbol, time).
   */
  histPrices?: Map<string, number>,
  /**
   * UCB cost-basis tracker (cumulative WAC из swap-from-stable истории).
   * ПРИОРИТЕТ при подсчёте USD per supply event. Это закрывает баг
   * "swap overpay" (Vladimir POS-002): user заплатил $7000 за 2.2286 ETH
   * (WAC $3141), market price был $2114 — старая логика брала $4713
   * (market), теперь берёт $7000 (real cost). См. cost_basis_tracker.ts.
   */
  tracker?: LotTrackerLike,
): { amount: number; usd: number } {
  const target = normalizeSymbol(symbol);
  let amount = 0;
  let usd = 0;
  for (const op of ops) {
    if (op.status === "failed") continue;
    if (isJunkOp(op)) continue;
    if (!op.protocol || op.protocol.id !== protocolId) continue;
    if (op.chain !== chain) continue;
    if (openedAt != null && op.time < openedAt) continue;
    if (op.type === "claim_rewards") continue;
    if (!opMatchesLpMarket(op, lpTokenId)) continue;
    for (const m of op.movement) {
      if (m.direction !== "out" || m.amount <= 0) continue;
      if (normalizeSymbol(m.symbol) !== target) continue;
      amount += m.amount;

      // ─── price priority ────────────────────────────────────────────
      // 1. **UCB cost basis** — tracker.avgAt(symbol, op.time): что user
      //    реально заплатил за эти токены через swap-from-stable.
      //    Это TRUE cost basis по UCB-инварианту.
      // 2. Historical price (DefiLlama hourly): market price на момент
      //    op — fallback когда tracker пуст (e.g. tokens получены
      //    transfer_in / deposit_fiat без swap trail).
      // 3. m.usd: DeBank's current spot (worst, often misleading
      //    для старых ops).
      let priceAtTx: number | null = null;
      if (isStableSymbol(m.symbol)) {
        priceAtTx = 1;
      } else if (tracker) {
        const wac = tracker.avgAt(m.symbol, op.time);
        if (wac != null && wac > 0) priceAtTx = wac;
      }
      if (priceAtTx == null && histPrices && histPrices.size > 0) {
        const coin = defillamaCoinKey(op.chain, m.tokenId, m.symbol);
        if (coin) {
          const hp = priceFromMap(histPrices, coin, op.time);
          if (hp != null && hp > 0) priceAtTx = hp;
        }
      }
      if (priceAtTx != null) {
        usd += m.amount * priceAtTx;
      } else if (m.usd != null && m.usd > 0) {
        if (typeof window !== "undefined") {
          const ageDays = Math.floor((Date.now() / 1000 - op.time) / 86400);
          if (ageDays > 7) {
            console.warn(
              `[startUsd fallback] using DeBank current price for ${m.symbol} ` +
                `on ${op.chain} (op ${ageDays} days ago). ` +
                `historical price not available — startUsd likely inflated.`,
            );
          }
        }
        usd += m.usd;
      }
    }
  }
  return { amount, usd };
}

/**
 * UCB single-source-of-truth: считает cost basis позиции через **fresh
 * LotTracker replay**. Подходит для ВСЕХ типов позиций где underlying
 * актив отдаётся в протокол:
 *   - Lending (Aave / Fluid / Compound / Morpho / Spark)
 *   - LP (Uniswap V3, Sushi, Curve, GMX V2 / GLV)
 *   - Staking / Restaking (Lido, EigenLayer, Pendle)
 *   - Vaults / Yearn-style
 *
 * Принцип: для каждой `lend_supply`, `lp_add`, `stake` op в этой позиции —
 * выполняется `tracker.consume(symbol, amount, time)` на FRESH lot tracker,
 * который accumulates ВСЕ acquisitions (swap-from-stable, transfer_in,
 * deposit_fiat, claim_rewards, bridge_in) с правильным cost basis через
 * D3 / A4 / D5 / D6 overrides из `costBasisOverrideByHash`.
 *
 * Возвращает суммарный consumed cost из всех lend_supply ops по этому
 * (protocolId, chain, symbol) ИЛИ marketKey (lpTokenId если задан).
 *
 * Это даёт **точное соответствие** lot-by-lot display'ю в UI: сумма
 * Σ (consumed.amount × consumed.costPerUnitUsd) = position.startUsd.
 *
 * Используется как preferred path в `buildSupplyToken`, fallback на
 * legacy `currentCycleDepositForSymbol` если lot tracker не доступен.
 */
function computePositionConsumedCostFromLots(
  ops: ClassifiedOp[],
  walletId: string,
  protocolId: string,
  chain: string,
  symbol: string,
  openedAt: number | null,
  lpTokenId: string | undefined,
  histPrices: Map<string, number>,
  costBasisOverrideByHash?: ReadonlyMap<string, number>,
  /**
   * UCB C5 Phase C: shared LotTracker от ucb_pipeline (single source of
   * truth). Когда передан — `wacAt(walletId, symbol, op.time)` читается
   * напрямую без локального ребилда. Это O(target_supplies) вместо
   * O(target_supplies × all_ops) — perf win, plus полная консистентность
   * с lot-by-lot popup display (тот тоже читает из shared tracker).
   *
   * **UCB C5 Phase D (2026-05-23, Task #18)**: Все production callers
   * `buildOpenPositions` обязаны передавать `lotsByWallet` (через
   * `useLoadedWallets().newTrackers.lotsByWallet`):
   *   - `use_computed_positions.ts:227` ✓
   *   - `HomePage.tsx:314` ✓
   *   - `WalletDetailPage.tsx:254` ✓ (исправлено в Phase 1)
   *   - `PortfolioPage.tsx:186` ✓ (исправлено в Phase 1)
   *
   * Fallback на inline rebuild `buildLotTrackerFromOps` сохранён ТОЛЬКО для
   * test-fixtures (`open_positions.swap-overpay.test.ts`), где production
   * pipeline ucb_pipeline.ts слишком тяжёл для setup'а. В production коде
   * этот код dead. Phase 2 (Task #18 cont.) — миграция тестов на
   * `buildLotsAndPositions` и удаление build.ts полностью.
   */
  sharedLotTracker?: LotTracker,
): { amount: number; usd: number; fallbackUsd: number } {
  // Step-by-step walker: для каждого supply op в эту позицию ловим WAC
  // в момент supply (BEFORE consume removes lots). Это даёт TRUE historical
  // cost basis — устойчиво к full consume / pre-existing balance.
  //
  // UCB C5 Phase F (2026-05-23, Task #19): отслеживаем `fallbackUsd` —
  // часть `usd`, которая пришла из silent m.usd fallback (НЕ из LotTracker).
  // Если caller видит fallbackUsd > 0 — cost basis этой позиции содержит
  // unknown provenance (DeBank current spot вместо реально потраченных
  // долларов). Используется для UI badge и dev-warning'ов в
  // anti-recurrence pattern #1.
  //
  // Стратегия:
  //   1. Sort ops chronologically.
  //   2. Maintain incrementally-built LotTracker.
  //   3. На каждый op:
  //      a. ЕСЛИ это target supply (matched protocol/chain/symbol/marketKey)
  //         → ДО consume читаем `tracker.wacAt(symbol, op.time)`,
  //         сохраняем consumed cost = amount × wac.
  //      b. Apply op to tracker (acquire / consume / etc.).
  //   4. Return Σ consumed amounts/usd.
  const target = normalizeSymbol(symbol);
  const sorted = [...ops]
    .filter((o) => o.status !== "failed" && !isJunkOp(o))
    .sort((a, b) => a.time - b.time);

  let totalAmount = 0;
  let totalUsd = 0;
  let totalFallbackUsd = 0;

  const incrementalOps: ClassifiedOp[] = [];
  for (const op of sorted) {
    // Check if THIS op is a target supply into our position.
    // UCB C7: opMatchesLpMarket strict check works for V3 LP (with proper
    // lpTokenId in movement protocol-token), но для lending позиций где
    // DeBank pool.id (e.g. Fluid vault address 0x324c5dc1...) != receipt
    // token id (fVLT), strict check filters out ALL supplies → walker
    // returns 0. Solution: для lend_supply / lp_add / stake, accept op
    // by (protocol, chain, symbol) match even without explicit lpTokenId
    // match. opMatchesLpMarket остаётся strict для cross-position filter
    // в других callsites (V3 multi-position pair).
    const isSupplyEvent =
      op.type === "lend_supply" || op.type === "lp_add" || op.type === "stake";
    const lpMatched = isSupplyEvent || opMatchesLpMarket(op, lpTokenId);
    const isTargetSupply =
      op.protocol?.id === protocolId &&
      op.chain === chain &&
      op.type !== "claim_rewards" &&
      lpMatched &&
      (openedAt == null || op.time >= openedAt) &&
      op.movement.some(
        (m) =>
          m.direction === "out" &&
          m.amount > 0 &&
          normalizeSymbol(m.symbol) === target,
      );

    if (isTargetSupply) {
      // UCB C5 Phase C: предпочитаем shared LotTracker. Если не передан —
      // fallback на inline rebuild с incrementalOps (legacy O(n²) путь).
      let wac: number | null;
      if (sharedLotTracker) {
        wac = sharedLotTracker.wacAt(walletId, symbol, op.time);
      } else {
        // UCB C5 Phase D (Task #18): Production callers всегда передают
        // sharedLotTracker. Если мы здесь — это test-fixture без
        // ucb_pipeline. В dev режиме warning'аем, чтобы детектить
        // production регрессию (новый caller забыл передать lotsByWallet).
        if (
          typeof process !== "undefined" &&
          process.env?.NODE_ENV !== "production" &&
          process.env?.NODE_ENV !== "test"
        ) {
          // eslint-disable-next-line no-console
          console.warn(
            `[open_positions] sharedLotTracker undefined — fell back to inline buildLotTrackerFromOps. ` +
              `Production callers must pass lotsByWallet (UCB C5 Phase D). ` +
              `Pos: wallet=${walletId} protocol=${protocolId} chain=${chain} symbol=${symbol}.`,
          );
        }
        const trackerNow = buildLotTrackerFromOps(incrementalOps, {
          walletId,
          histPrices,
          ...(costBasisOverrideByHash &&
            costBasisOverrideByHash.size > 0 && {
              costBasisOverrideByHash: new Map(costBasisOverrideByHash),
            }),
        });
        wac = trackerNow.wacAt(walletId, symbol, op.time);
      }

      for (const m of op.movement) {
        if (m.direction !== "out" || m.amount <= 0) continue;
        if (normalizeSymbol(m.symbol) !== target) continue;
        totalAmount += m.amount;
        // UCB C9: trust tracker когда wacAt set — даже = 0 (explicit
        // borrow-funded signal). Fallback к m.usd only когда wacAt
        // returns null (= no data in tracker, asset never tracked).
        //
        // Кейс: vladimir POS-005 Fluid WBTC — 0.226 WBTC borrowed из
        // Morpho (cost basis = $0 per UCB). Без C9 fallback на market
        // m.usd $17,648 → inflate startUsd на $17.6k фантомного "вложения"
        // когда реальные деньги — нулевые (debt). Real PnL ломался.
        if (wac != null) {
          totalUsd += m.amount * wac;
        } else {
          // Fallback: no tracker data (wac=null) → historical price → m.usd.
          //
          // UCB C5 Phase F (Task #19): tracker возвратил null → cost basis
          // от lots не найден. Historical price из DefiLlama — приемлемый
          // proxy (часто accurate в пределах %). m.usd (DeBank current
          // spot) — НЕ accurate для long-term позиций (например купил
          // BTC год назад за $40k, current $90k — m.usd скажет $90k вместо
          // $40k → inflated startUsd → wrong PnL).
          //
          // Считаем `m.usd`-derived USD как `fallbackUsd` (unknown provenance).
          // Caller (buildSupplyToken) сможет mark позицию badge'м.
          // В dev режиме warning'аем — это сигнал что классификатор/
          // lots-tracker не покрыл какой-то протокол.
          const coin = defillamaCoinKey(op.chain, m.tokenId, m.symbol);
          let priceAtTx: number | null = null;
          if (coin) {
            const hp = priceFromMap(histPrices, coin, op.time);
            if (hp != null && hp > 0) priceAtTx = hp;
          }
          if (priceAtTx != null) {
            // Historical price — НЕ silent fallback (это known unit price
            // на момент tx, accurate для нашей цели).
            totalUsd += m.amount * priceAtTx;
          } else if (m.usd != null && m.usd > 0) {
            // m.usd — DeBank current spot. UNKNOWN provenance для cost basis.
            // Track как fallback и warning в dev.
            totalUsd += m.usd;
            totalFallbackUsd += m.usd;
            if (
              typeof process !== "undefined" &&
              process.env?.NODE_ENV !== "production" &&
              process.env?.NODE_ENV !== "test"
            ) {
              // eslint-disable-next-line no-console
              console.warn(
                `[open_positions] silent m.usd fallback (anti-recurrence #1): ` +
                  `wallet=${walletId} protocol=${protocolId} chain=${chain} ` +
                  `symbol=${symbol} time=${op.time} amount=${m.amount} fallbackUsd=${m.usd}. ` +
                  `LotTracker не имеет lots для этого символа, и DefiLlama hist-цена недоступна → ` +
                  `подменяем cost basis на current spot (m.usd). PnL может быть искажён.`,
              );
            }
          }
        }
      }
    }

    incrementalOps.push(op);
  }

  return { amount: totalAmount, usd: totalUsd, fallbackUsd: totalFallbackUsd };
}

/**
 * Сопоставляет op с конкретным LP-маркетом по mint'у LP-receipt'а.
 * - Если `lpTokenId` не задан — пропускаем все ops (legacy поведение).
 * - Иначе оп матчится, если:
 *   1. Его `linkedLpTokenId` (от async-deposit linker) равен lpTokenId, ИЛИ
 *   2. В его movement есть protocol-token с этим tokenId (классические
 *      Uniswap-style lp_add/remove где receipt в той же tx).
 * Сравнение нечувствительно к chain-prefix'у ("arb:0x..." vs "0x...").
 */
function opMatchesLpMarket(op: ClassifiedOp, lpTokenId?: string): boolean {
  if (!lpTokenId) return true;
  const target = stripChainPrefix(lpTokenId).toLowerCase();
  const linked = op.linkedLpTokenId
    ? stripChainPrefix(op.linkedLpTokenId).toLowerCase()
    : null;
  if (linked === target) return true;
  for (const m of op.movement) {
    if (!m.isProtocolToken) continue;
    if (stripChainPrefix(m.tokenId).toLowerCase() === target) return true;
  }
  return false;
}

/**
 * Нормализация tokenId / pool.id для матчинга через `:`-разделители.
 * Известные форматы DeBank:
 *   - "arb:0x..." / "eth:0x..." — chain prefix (короткий тэг до 6 символов
 *     БЕЗ префикса 0x).
 *   - "0x...:lending" / "0x...:vault" — pool variant suffix (тип пула).
 *   - Просто "0x..." — без декораций.
 * Возвращаем «голый» 0x-адрес: убираем chain prefix СПЕРЕДИ и market suffix
 * СЗАДИ, оставляя только hex-часть. Если это не hex (например, "ethereum")
 * — возвращаем как есть.
 */
function stripChainPrefix(id: string): string {
  let s = id;
  // Удаляем chain prefix вида "arb:" / "eth:" / "bera:" / "matic:" — короткий
  // тэг (до 6 символов, без 0x) перед двоеточием.
  s = s.replace(/^[a-z]{2,6}:/i, "");
  // Удаляем market/variant suffix вида ":lending" / ":vault" / ":spot"
  // (любой текстовый суффикс после двоеточия).
  s = s.replace(/:[a-z][a-z0-9_-]+$/i, "");
  return s;
}

/**
 * **Net** deposited amount = Σ out (deposits) − Σ in (withdrawals) for a
 * (protocol, symbol) pair. Нужен для расчёта supply-yield лендинга:
 *   `accrued = current_supply − net_deposited`
 *
 * **Историческая проблема (2026-05-14)**: ранее функция считала только
 * `Σ out` (без минуса withdraw'ов). Для long-running позиции с deposit→
 * withdraw→redeposit циклами `Σ deposited` уезжал выше `current_supply`,
 * `accrued` получался отрицательным → `computeFees` возвращал null →
 * UI показывал «набежавшие fee = 0» (POS-003 via.irk@gmail.com).
 *
 * Также фильтруем by op type: только supply/withdraw, чтобы случайный
 * swap токена в Uniswap'е и т.п. не считался депозитом в Aave/Compound.
 */
function depositAmountSum(
  ops: ClassifiedOp[],
  protocolId: string,
  symbol: string,
  /**
   * H8 (2026-05-14): chain filter.
   *
   * DeBank exposes Aave V3 on Polygon, Arbitrum, Mainnet etc. under the
   * SAME `protocol.id` (e.g. "aave3"). Without filtering by chain,
   * a multi-chain user with $100 deposited on Arbitrum + $200 on
   * Mainnet would have a total `deposited = 300` and `live.supply
   * = 100` on the Arbitrum row → `accrued = 100 - 300 = -200` →
   * computeFees returns null → "набежавшие fee = 0" in UI.
   *
   * Made required (not optional) to prevent silent multi-chain bugs
   * — callers MUST pass the chain.
   */
  chain: string,
): number {
  const target = normalizeSymbol(symbol);
  let deposited = 0;
  let withdrawn = 0;
  for (const op of ops) {
    if (op.status === "failed") continue;
    if (isJunkOp(op)) continue;
    if (!op.protocol || op.protocol.id !== protocolId) continue;
    if (op.chain !== chain) continue;
    const isSupply =
      op.type === "lend_supply" ||
      op.type === "lp_add" ||
      op.type === "stake";
    const isWithdraw =
      op.type === "lend_withdraw" ||
      op.type === "lp_remove" ||
      op.type === "unstake";
    if (!isSupply && !isWithdraw) continue;
    for (const m of op.movement) {
      if (m.amount <= 0) continue;
      if (normalizeSymbol(m.symbol) !== target) continue;
      if (isSupply && m.direction === "out") deposited += m.amount;
      else if (isWithdraw && m.direction === "in") withdrawn += m.amount;
    }
  }
  return Math.max(0, deposited - withdrawn);
}

/**
 * Посчитать накопленные fees / supply-yield для позиции.
 *  - Для V3 LP — fees лежат в `lp.rewards` (uncollected fees, не часть supply).
 *  - Для лендинга — supply yield = `(current_amount − Σ deposited) × current_price`,
 *    т.е. чистые проценты, начисленные протоколом сверху, без перемешивания с
 *    движением цены актива.
 */
function computeFees(
  lp: LiveProtocolPosition,
  ops: ClassifiedOp[],
  currentPrices: Map<string, number>,
  ageDays: number | null,
  /**
   * Опциональный override для `depositAmountSum` per (symbol). Когда задан —
   * на этот ключ используется on-chain truth (Σ mint − Σ burn aToken'а) вместо
   * ops-derived sum. Источник: `useAaveLendingAudit` hook. Снимает класс багов
   * от неполного DeBank history (POS-008 ghost yield).
   *
   * Map keyed by normalized symbol (UPPERCASE).
   */
  onChainDepositedBySymbol?: Map<string, number>,
): {
  feesUsd: number;
  source: "v3_rewards" | "supply_yield";
  byToken: OpenPosition["feesByToken"];
} | null {
  if (isV3LpProtocol(lp.protocolName)) {
    const usd = lp.rewards.reduce((s, r) => s + r.usd, 0);
    if (usd <= 0) {
      // Диагностика: V3 позиция должна иметь rewards в DeBank
      // (`portfolio_item.detail.reward_token_list`), но пришло пусто.
      // Возможные причины: DeBank ещё не индексировал, или DeBank
      // вообще не отдаёт rewards для этого NFT (баг на их стороне).
      if (typeof window !== "undefined") {
        console.warn(
          `[computeFees] V3 ${lp.protocolName}/${lp.chain} rewards empty ` +
            `(supply=${lp.supply.map((s) => `${s.amount.toFixed(4)} ${s.symbol}`).join("+")}). ` +
            `DeBank may not have indexed pending fees for this NFT yet — ` +
            `try Refresh in 15-30 min.`,
        );
      }
      return null;
    }
    const byToken: OpenPosition["feesByToken"] = lp.rewards
      .filter((r) => r.amount > 0)
      .map((r) => ({
        symbol: r.symbol,
        amount: r.amount,
        usd: r.usd,
        nativeApr: null, // у V3 fees нет «исходной amount» базы для native APR
      }));
    return { feesUsd: usd, source: "v3_rewards", byToken };
  }
  // Rebase-style supply yield: aToken/cToken/fToken/etc. — amount растёт
  // со временем благодаря начислению процентов. Покрываем lending +
  // некоторые yield-protoколы где receipt тоже rebase-style.
  const catLc = lp.category.toLowerCase();
  const isRebaseStyle =
    catLc.includes("lend") ||
    catLc.includes("restaking") ||
    // Liquid staking receipts (stETH, rETH) тоже растут rebase-style.
    catLc.includes("staking");
  if (isRebaseStyle) {
    let yieldUsd = 0;
    const byToken: OpenPosition["feesByToken"] = [];
    const accruedDiag: string[] = [];
    for (const s of lp.supply) {
      const opsDeposited = depositAmountSum(ops, lp.protocolId, s.symbol, lp.chain);
      // On-chain audit override: если есть, используем authoritative netDeposited
      // вместо ops-derived (которая может быть неполная из-за пропущенных
      // DeBank tx). Применяется только когда on-chain net > ops-derived
      // (т.е. ops пропустили какие-то supplies). Обратное (on-chain < ops) —
      // подозрительно: может означать что ops содержат позиции которые
      // на цепи фактически уже сняты, или другие artifacts; fallback на ops.
      const symKey = normalizeSymbol(s.symbol);
      const onChainNet = onChainDepositedBySymbol?.get(symKey);
      const deposited =
        onChainNet != null && onChainNet > opsDeposited
          ? onChainNet
          : opsDeposited;
      accruedDiag.push(
        `${s.symbol}: current=${s.amount.toFixed(4)} net_deposited=${deposited.toFixed(4)}` +
          (onChainNet != null
            ? ` (on-chain=${onChainNet.toFixed(4)}, ops=${opsDeposited.toFixed(4)})`
            : ""),
      );
      if (deposited <= 0) continue;
      const accrued = s.amount - deposited;
      if (accrued <= 0) continue;
      const cur = isStableSymbol(s.symbol)
        ? 1
        : (currentPrices.get(normalizeSymbol(s.symbol)) ?? null);
      const usd = cur != null && cur > 0 ? accrued * cur : 0;
      yieldUsd += usd;
      const nativeApr =
        ageDays && ageDays > 0
          ? (accrued / deposited) * (365 / ageDays) * 100
          : null;
      byToken.push({ symbol: s.symbol, amount: accrued, usd, nativeApr });
    }
    if (yieldUsd <= 0) {
      // Диагностика: положенно ждать accrual, но он 0 или отрицательный.
      if (typeof window !== "undefined") {
        console.warn(
          `[computeFees] ${lp.protocolName}/${lp.chain} supply-yield = 0 ` +
            `for category="${lp.category}". Per-symbol: ${accruedDiag.join("; ") || "(no supply)"}. ` +
            `If current ≈ net_deposited, проценты ещё не накопились ИЛИ ` +
            `protocol_id mismatch между live (${lp.protocolId}) и ops history.`,
        );
      }
      return null;
    }
    return { feesUsd: yieldUsd, source: "supply_yield", byToken };
  }
  return null;
}

function fallbackUsdFromOpen(
  ops: ClassifiedOp[],
  protocolId: string,
  symbol: string,
  /** Исторические цены — критично для long-term позиций (см. cycleDeposit comment). */
  histPrices?: Map<string, number>,
): { totalAmount: number; totalUsd: number } {
  // Для fallback: сумма OUT-движений целевого токена в open-операции этого протокола.
  let totalAmount = 0;
  let totalUsd = 0;
  for (const op of ops) {
    if (op.status === "failed") continue;
    if (isJunkOp(op)) continue;
    if (!op.protocol || op.protocol.id !== protocolId) continue;
    for (const m of op.movement) {
      if (m.direction !== "out" || m.amount <= 0) continue;
      if (normalizeSymbol(m.symbol) !== normalizeSymbol(symbol)) continue;
      totalAmount += m.amount;
      // Приоритет: historical price > m.usd fallback.
      let priceAtTx: number | null = null;
      if (histPrices && histPrices.size > 0) {
        if (isStableSymbol(m.symbol)) {
          priceAtTx = 1;
        } else {
          const coin = defillamaCoinKey(op.chain, m.tokenId, m.symbol);
          if (coin) {
            const hp = priceFromMap(histPrices, coin, op.time);
            if (hp != null && hp > 0) priceAtTx = hp;
          }
        }
      }
      if (priceAtTx != null) {
        totalUsd += m.amount * priceAtTx;
      } else if (m.usd != null && m.usd > 0) {
        totalUsd += m.usd;
      }
    }
  }
  return { totalAmount, totalUsd };
}

/**
 * Определяет, является ли live-позиция фактически закрытой (но API вернул
 * residual dust).
 *
 * DeBank/Vybe/CoinStats регулярно показывают «$0.50 — $50» остатки на
 * lending/LP позициях после полного withdraw — это accrued interest, dust
 * rewards, точность округления протокола, in-flight rewards. С точки
 * зрения пользователя позиция закрыта, но в UI она висит как открытая.
 *
 * Эвристика (срабатывает любая):
 *   1. Hard dust (current+debt < $1) → точно закрыта.
 *   2. Shrunk to dust: currentUsd < 1% от max исторического депозита
 *      ИЛИ < 5% от startUsd, плюс пороги $50 / $5 чтобы не отсечь валидные.
 *   3. Withdrawn ratio: Σ withdrawn / Σ deposited ≥ 90% (по любым in-направлениям
 *      операций с этим protocolId+chain — не требуем точного `lend_withdraw`).
 *
 * Если истории нет (CoinStats-кошелёк) — отсекаем только hard dust.
 */
const LIVE_HARD_DUST_USD = 1;
/** Если current < этой суммы И уменьшилось > 99% от max историч. депозита — закрыта. */
const LIVE_SHRUNK_DUST_USD = 50;
/** Если есть close events и withdrawn/deposited >= 90% — закрыта. */
const CLOSED_WITHDRAW_RATIO = 0.9;
/** Доля современного остатка относительно max-deposit ниже которой считаем закрытой. */
const SHRUNK_RATIO = 0.01;

function isLivePositionClosed(
  lp: LiveProtocolPosition,
  ops: ClassifiedOp[],
): boolean {
  const totalCurrentUsd = lp.assetUsd;
  const totalDebtUsd = lp.borrow.reduce((s, b) => s + b.usd, 0);
  const netCurrentUsd = totalCurrentUsd - totalDebtUsd;

  // Hard dust: явно закрытая, < $1 net остаток.
  if (Math.abs(netCurrentUsd) < LIVE_HARD_DUST_USD) {
    return true;
  }

  // Анализ истории (нужен для двух эвристик ниже).
  // Считаем все in/out движения для (protocolId, chain) — НЕ требуем точного
  // совпадения `lend_withdraw`/`lp_remove`, потому что для нестандартных
  // протоколов classifier может пометить operations как `swap`/`unknown`.
  let totalDepositedUsd = 0;
  let totalWithdrawnUsd = 0;
  let maxRunningDeposit = 0;
  let runningDeposit = 0;
  let hasCloseEvent = false;
  for (const op of ops) {
    if (op.status === "failed") continue;
    if (isJunkOp(op)) continue;
    if (!op.protocol || op.protocol.id !== lp.protocolId) continue;
    if (op.chain !== lp.chain) continue;
    const isAdd =
      op.type === "lp_add" ||
      op.type === "lend_supply" ||
      op.type === "stake";
    const isRemove =
      op.type === "lp_remove" ||
      op.type === "lend_withdraw" ||
      op.type === "unstake";
    if (!isAdd && !isRemove) continue;
    if (isRemove) hasCloseEvent = true;
    for (const m of op.movement) {
      if (m.amount <= 0) continue;
      const usd = m.usd ?? 0;
      if (isAdd && m.direction === "out") {
        totalDepositedUsd += usd;
        runningDeposit += usd;
      } else if (isRemove && m.direction === "in") {
        totalWithdrawnUsd += usd;
        runningDeposit -= usd;
      }
    }
    if (runningDeposit > maxRunningDeposit) maxRunningDeposit = runningDeposit;
  }

  // 2. Shrunk to dust: позиция уменьшилась до пыли относительно своего
  // исторического максимума. Поднятый порог $50 ловит lending residual.
  if (
    totalCurrentUsd < LIVE_SHRUNK_DUST_USD &&
    totalDebtUsd < LIVE_SHRUNK_DUST_USD &&
    maxRunningDeposit > 0 &&
    totalCurrentUsd / maxRunningDeposit < SHRUNK_RATIO
  ) {
    return true;
  }

  // 3. Withdrawn ratio: явная история закрытий и большая часть депозитов
  // выведена. Применяем только если currentUsd «низкий» в абсолюте — иначе
  // активная позиция с rolling-депозитами могла бы сработать ложно.
  if (
    hasCloseEvent &&
    totalCurrentUsd < LIVE_SHRUNK_DUST_USD &&
    totalDebtUsd < LIVE_SHRUNK_DUST_USD &&
    totalDepositedUsd > 0 &&
    totalWithdrawnUsd / totalDepositedUsd >= CLOSED_WITHDRAW_RATIO
  ) {
    return true;
  }

  return false;
}

export function buildOpenPositions(
  loaded: BuildInput[],
  options?: BuildOptions,
): OpenPosition[] {
  const currentPrices = buildCurrentPriceMap(loaded);
  const histPrices = options?.histPrices ?? new Map<string, number>();
  const v3MintPoolPrices = options?.v3MintPoolPrices;
  const v3MintCgPrices = options?.v3MintCgPrices;

  // UCB C5: cost-basis tracker source-of-truth.
  // 1. Если caller передал `lotsByWallet` (новый LotTracker из ucb_pipeline) —
  //    используем его напрямую (full UCB: CEX inheritance, manual annotations,
  //    bridge propagation, D6 reward income).
  // 2. Иначе — fallback на legacy `buildCostBasisTracker` (cumulative WAC без
  //    overrides). Это backward-compat для callers'ов, ещё не подключённых
  //    к provider'ского newTrackers (e.g. unit tests, ad-hoc analytics).
  //
  // depositUsdFromOp / currentCostBasisForPosition / fallbackUsdFromOpen внутри
  // принимают `LotTrackerLike` (либо новый LotTracker, либо legacy
  // CostBasisTracker через shim) — переход прозрачный, divergence устраняется.
  const lotsByWallet = options?.lotsByWallet;
  const trackerByWallet = new Map<string, CostBasisTracker>();
  if (!lotsByWallet) {
    for (const l of loaded) {
      trackerByWallet.set(
        l.wallet.id,
        buildCostBasisTracker(l.ops, histPrices),
      );
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  //  V3 mint matching: для каждой LIVE V3 позиции находим op.hash mint'а,
  //  который её создал. Используется как стабильный per-NFT discriminator
  //  (вместо supplyAmountsHash который чувствителен к ребалансировке).
  //
  //  Алгоритм:
  //    1. Группируем ops по (wallet, protocolId, chain) только V3-style.
  //    2. Считаем "open" mints (lp_add) минус "closed" (lp_remove FIFO).
  //    3. Для каждой LIVE V3 позиции: жадный matching по symbol pair +
  //       amount magnitude (current supply ≈ deposited × WAC scale).
  //    4. Один mint можно сматчить только один раз (Set already-matched).
  //
  //  Если match не нашёлся (live > mints или нет данных) → fallback
  //  на supplyAmountsHash из buildOne.
  // ─────────────────────────────────────────────────────────────────────
  const v3MintMatches = matchV3LiveToMints(loaded, options?.v3PoolByTxHash);

  // Set всех mint hash'ей которые УЖЕ привязаны к конкретным NFT через
  // matchV3LiveToMints. Передаётся в buildV3Details как `consumedMintHashes`
  // чтобы fallback strict-pair-filter ИСКЛЮЧИЛ их при построении unmatched
  // NFT — иначе один mint используется для двух NFT (баг POS-009/010 PAXG).
  const consumedMintHashesByPC = new Map<string, Set<string>>();
  for (const [matchKey, mintHash] of v3MintMatches) {
    // matchKey = `${walletId}|${protocolId}|${chain}|${pair}|${assetUsd}`
    // Группируем по walletId|protocolId|chain (без assetUsd, без pair —
    // чтобы все NFT одного протокола+chain в этом wallet знали про consumed).
    const parts = matchKey.split("|");
    const groupKey = `${parts[0]}|${parts[1]}|${parts[2]}`;
    let s = consumedMintHashesByPC.get(groupKey);
    if (!s) {
      s = new Set();
      consumedMintHashesByPC.set(groupKey, s);
    }
    s.add(mintHash);
  }

  // Все живые позиции по всем кошелькам.
  // Перед buildOne фильтруем «фантомные» позиции (закрытые on-chain, но
  // API вернуло residual dust — типичная проблема DeBank lending после
  // withdraw, остаточные accrued interest на $0.50-$5).
  const all: OpenPosition[] = [];
  for (const l of loaded) {
    if (!l.live) continue;
    for (const lp of l.live.positions) {
      if (isLivePositionClosed(lp, l.ops)) continue;
      const matchKey = v3LiveMatchKey({
        walletId: l.wallet.id,
        protocolId: lp.protocolId,
        chain: lp.chain,
        symbols: lp.supply.map((s) => s.symbol),
        assetUsd: lp.assetUsd,
      });
      const v3MintHash = v3MintMatches.get(matchKey);
      const consumedKey = `${l.wallet.id}|${lp.protocolId}|${lp.chain}`;
      const consumedSet = consumedMintHashesByPC.get(consumedKey);
      if (
        typeof window !== "undefined" &&
        isV3LpProtocol(lp.protocolName) &&
        !v3MintHash
      ) {
        console.warn(
          `[V3 unmatched] live ${lp.protocolName} ${lp.chain} ` +
            `${lp.supply.map((s) => `${s.amount.toFixed(3)} ${s.symbol}`).join("+")} ` +
            `(assetUsd=$${lp.assetUsd.toFixed(2)}) → no mint match. ` +
            `key="${matchKey}". Fallback: strict pair filter в buildV3Details. ` +
            `Excluded ${consumedSet?.size ?? 0} consumed mints.`,
        );
      }
      const built = buildOne(
        lp,
        l,
        trackerByWallet,
        lotsByWallet,
        currentPrices,
        histPrices,
        v3MintHash,
        v3MintPoolPrices,
        v3MintCgPrices,
        consumedSet,
        options?.costBasisOverrideByHash,
        options?.lendingAuditByKey,
      );
      if (built) all.push(built);
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  //  SELF-AUDIT: детектируем структурно-сомнительные позиции и логируем.
  //
  //  Срабатывает когда после `buildOne` обнаруживаются дубликаты ключей
  //  `(walletId, chain, protocolId, symbols)` — это значит несколько
  //  LiveProtocolPosition сливаются в один override-scope (баг 06.05.2026
  //  с POS-001/002 в Uniswap V3, когда credit toggle переключал обе).
  //
  //  Также детектируем абсолютно одинаковую `startUsd` (с точностью до
  //  $0.01) у >=2 позиций — почти всегда следствие неуникального matching
  //  по `lp.lpTokenId` (V3 NFT-style: один pool.id для нескольких NFT).
  //
  //  Эти диагностики НЕ ломают рендер — просто console.warn в dev. Они
  //  пишут точный детект, чтобы при следующем подобном случае пользователь
  //  не открывал тикет, а методика сама подсказала что искать.
  // ─────────────────────────────────────────────────────────────────────
  if (typeof window !== "undefined" && all.length > 1) {
    const byScope = new Map<string, OpenPosition[]>();
    const byStartUsd = new Map<string, OpenPosition[]>();
    for (const p of all) {
      const sym = [...p.supplyTokens.map((t) => t.symbol)].sort().join("+");
      const scopeKey = `${p.walletId}|${p.chain}|${p.protocol.id}|${sym}`;
      const arr = byScope.get(scopeKey) ?? [];
      arr.push(p);
      byScope.set(scopeKey, arr);
      if (p.startUsd > 1) {
        const usdKey = `${p.walletId}|${p.chain}|${p.protocol.id}|${p.startUsd.toFixed(2)}`;
        const arr2 = byStartUsd.get(usdKey) ?? [];
        arr2.push(p);
        byStartUsd.set(usdKey, arr2);
      }
    }
    for (const [scope, group] of byScope) {
      if (group.length < 2) continue;
      const distinctInstance = new Set(group.map((p) => p.instanceId)).size;
      if (distinctInstance < group.length) {
        console.warn(
          `[Capflow audit] Duplicate position scope without instanceId discriminator: ${scope}. ` +
            `${group.length} live positions share same key. ` +
            `Override toggles (credit/hidden/currentValue) will collide. ` +
            `Likely cause: multiple V3 NFTs in same pool, или не-уникальный pool.id от DeBank.`,
        );
      }
    }
    for (const [usdKey, group] of byStartUsd) {
      if (group.length < 2) continue;
      console.warn(
        `[Capflow audit] ${group.length} positions with identical startUsd ($${group[0]!.startUsd.toFixed(2)}) ` +
          `in ${usdKey}. ` +
          `Likely cause: cost basis attribution sums по pool, не по NFT. ` +
          `Symbols: ${group.map((p) => p.supplyTokens.map((t) => t.symbol).join("+")).join(" | ")}`,
      );
    }
  }

  // ВНИМАНИЕ: Inferred-позиции (реконструированные из истории) НЕ попадают
  // в OpenPositions. Если live API не видит позицию — почти всегда она
  // закрыта on-chain (просто classifier не распознал withdraw как
  // `lp_remove`/`lend_withdraw` для нестандартного протокола), и
  // показывать её как «открытую» — это «фантом».
  //
  // Все inferred-кандидаты (открытые без матча close + неполные closures)
  // идут в архив через `buildClosedPositions` как `unmatched`-циклы.
  // Пользователь видит их в Листе закрытых позиций, и они НЕ учитываются
  // в аналитике дашборда.
  //
  // Если у пользователя реально есть открытая нишевая позиция (live API
  // не покрывает) — она попадёт в архив как unmatched, и оттуда её можно
  // явно «открыть как live» (overrides).

  // ─────────────────────────────────────────────────────────────────────
  //  V3 multi-NFT fee claims attribution: pro-rata by current liquidity
  //
  //  Проблема: `computeClaimedFeesUsd` возвращает Σ всех claim_rewards
  //  для (protocolId, chain, pair). Если в одном pool у юзера 2 NFT
  //  (две WETH/USDC позиции) — обе получат ту же сумму → overcounting.
  //
  //  В DeBank нет NFT tokenId → точно отнести claim к конкретной NFT
  //  без RPC чтения логов нельзя. Используем pro-rata по currentUsd:
  //  каждой NFT — её доля от общего liquidity группы. Для одиночных NFT
  //  делитель = 1, поведение не меняется.
  // ─────────────────────────────────────────────────────────────────────
  {
    type Group = { positions: OpenPosition[]; total: number };
    const groups = new Map<string, Group>();
    for (const p of all) {
      const isV3 = p.v3 != null;
      if (!isV3) continue;
      const pair = [...p.supplyTokens.map((t) => t.symbol)]
        .sort()
        .join("+");
      const key = `${p.walletId}|${p.chain}|${p.protocol.id}|${pair}`;
      const g = groups.get(key) ?? { positions: [], total: 0 };
      g.positions.push(p);
      g.total += p.currentUsd > 0 ? p.currentUsd : 0;
      groups.set(key, g);
    }
    for (const g of groups.values()) {
      if (g.positions.length < 2) continue;
      // Каждая позиция в группе сейчас имеет ОДИНАКОВЫЙ feesClaimedUsd
      // (= total claims по pair). Разделим pro-rata по currentUsd.
      const claimedTotal = g.positions[0]?.feesClaimedUsd ?? 0;
      if (claimedTotal <= 0) continue;
      for (const p of g.positions) {
        const share =
          g.total > 0 ? (p.currentUsd > 0 ? p.currentUsd : 0) / g.total : 1 / g.positions.length;
        p.feesClaimedUsd = claimedTotal * share;
        p.feesLifetimeUsd = (p.feesUsd ?? 0) + p.feesClaimedUsd;
        if (p.startUsd > 0 && p.ageDays && p.ageDays > 0) {
          p.feeAprLifetime =
            (p.feesLifetimeUsd / p.startUsd) * (365 / p.ageDays) * 100;
        }
        // Также pro-rata детализированную историю — каждый event имеет
        // своё `usd`, делим на ту же долю; tokensReceived amount'ы тоже.
        p.feesClaimedHistory = p.feesClaimedHistory.map((ev) => ({
          ...ev,
          usd: ev.usd * share,
          tokensReceived: ev.tokensReceived.map((t) => ({
            symbol: t.symbol,
            amount: t.amount * share,
            usd: t.usd * share,
          })),
          aprPeriod:
            p.startUsd > 0 && ev.daysSincePrev && ev.daysSincePrev > 0
              ? ((ev.usd * share) / p.startUsd) * (365 / ev.daysSincePrev) * 100
              : null,
        }));
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  //  V3 multi-NFT cost basis redistribution (FIX для POS-009/010 PAXG dup):
  //
  //  Если N V3 NFT в одном pair имеют ОДИНАКОВЫЙ startUsd (= тот же mint
  //  attributed N раз через fallback), это значит:
  //   - DeBank вернул N live позиций (split NFT через decreaseLiquidity+mint)
  //   - В ops history только M < N mints
  //   - Несколько NFT получили один и тот же deposit USD (дубль)
  //
  //  Решение: redistribute total startUsd pro-rata к currentUsd. Это
  //  даёт реалистичный baseline для PnL до тех пор пока Alchemy log
  //  parsing для отдельных NFT mints не реализован (Phase 5+).
  //
  //  Условие срабатывания:
  //   - Группа V3 NFT с одинаковым (walletId, chain, protocolId, pair)
  //   - >= 2 позиции с identical startUsd (с tolerance $1)
  //   - Σ startUsd > Σ currentUsd × 1.05 (т.е. дубль завышает cost basis)
  // ─────────────────────────────────────────────────────────────────────
  {
    type Group2 = { positions: OpenPosition[]; totalCurrent: number };
    const groups2 = new Map<string, Group2>();
    for (const p of all) {
      if (!p.v3) continue;
      const pair = [...p.supplyTokens.map((t) => t.symbol)].sort().join("+");
      const key = `${p.walletId}|${p.chain}|${p.protocol.id}|${pair}`;
      const g = groups2.get(key) ?? { positions: [], totalCurrent: 0 };
      g.positions.push(p);
      g.totalCurrent += p.currentUsd > 0 ? p.currentUsd : 0;
      groups2.set(key, g);
    }
    for (const g of groups2.values()) {
      if (g.positions.length < 2) continue;
      // Детект identical startUsd (with $1 tolerance).
      const startUsds = g.positions.map((p) => p.startUsd);
      const distinctCount = new Set(
        startUsds.map((u) => Math.round(u)),
      ).size;
      const totalStart = startUsds.reduce((a, b) => a + b, 0);
      // Если distinctCount=1 → ВСЕ имеют одинаковый startUsd → дубль.
      // Если totalStart > totalCurrent × 1.05 → cost basis явно завышен.
      const isDuplicated =
        distinctCount === 1 ||
        (g.totalCurrent > 0 && totalStart > g.totalCurrent * 1.05);
      if (!isDuplicated) continue;
      // True total deposit = МАКСИМУМ из startUsd'ов (1 mint × N НЕ должен
      // умножать). Альтернатива — взять distinct values без учёта дублей.
      const trueTotalDeposit = Math.max(...startUsds);
      // Распределяем pro-rata к currentUsd.
      for (const p of g.positions) {
        const share =
          g.totalCurrent > 0
            ? (p.currentUsd > 0 ? p.currentUsd : 0) / g.totalCurrent
            : 1 / g.positions.length;
        const newStartUsd = trueTotalDeposit * share;
        // Меняем startUsd. Pro-rata также supplyTokens.startUsd чтобы
        // сохранить консистентность.
        const oldStartUsd = p.startUsd;
        p.startUsd = newStartUsd;
        if (oldStartUsd > 0) {
          for (const t of p.supplyTokens) {
            t.startUsd = (t.startUsd / oldStartUsd) * newStartUsd;
          }
        }
        // H6: collateral-side PnL only.
        p.netPnlUsd = p.currentUsd - p.startUsd;
        p.netPnlPct =
          p.startUsd > 0 ? (p.netPnlUsd / p.startUsd) * 100 : 0;
      }
      if (typeof window !== "undefined") {
        console.warn(
          `[V3 redistribution] Found ${g.positions.length} duplicate-startUsd ` +
            `V3 positions in ${g.positions[0]?.protocol.name} ${g.positions[0]?.chain} ` +
            `(pair: ${g.positions[0]?.supplyTokens.map((t) => t.symbol).join("+")}). ` +
            `Redistributed total $${trueTotalDeposit.toFixed(2)} pro-rata по currentUsd. ` +
            `Реальный cost basis per NFT требует Alchemy log parsing (Phase 5+).`,
        );
      }
    }
  }

  // Сортируем: сначала свежие открытия (если openedAt известен), затем по
  // currentUsd по убыванию.
  all.sort((a, b) => {
    if (a.openedAt && b.openedAt) return b.openedAt - a.openedAt;
    if (a.openedAt) return -1;
    if (b.openedAt) return 1;
    return b.currentUsd - a.currentUsd;
  });

  // Выдаём id'ы.
  return all.map((p, i) => ({
    ...p,
    id: `POS-${String(i + 1).padStart(3, "0")}`,
  }));
}

/**
 * Set ключей `${walletId}|${chain}|${protocolId}` для всех позиций,
 * которые live API в данный момент возвращает как активные.
 *
 * Используется в `buildClosedPositions` чтобы решить: незакрытый цикл
 * из истории — это реально открытая позиция (есть в live) или
 * unmatched-фантом (live её не видит → почти всегда закрыта).
 */
export function buildLiveProtocolKeys(loaded: BuildInput[]): Set<string> {
  const keys = new Set<string>();
  for (const l of loaded) {
    if (!l.live) continue;
    for (const lp of l.live.positions) {
      if (isLivePositionClosed(lp, l.ops)) continue;
      keys.add(`${l.wallet.id}|${lp.chain}|${lp.protocolId}`);
    }
  }
  return keys;
}

function buildOne(
  lp: LiveProtocolPosition,
  loaded: BuildInput,
  trackerByWallet: Map<string, CostBasisTracker>,
  /**
   * UCB C5: per-wallet LotTracker (от ucb_pipeline). Если задан — используется
   * вместо legacy `trackerByWallet[walletId]`. Адаптация через
   * `PerWalletLotTrackerView` сохраняет 2-arg avgAt/currentAvg API для
   * downstream без правки depositUsdFromOp / currentCostBasisForPosition.
   */
  lotsByWallet: Map<string, LotTracker> | undefined,
  currentPrices: Map<string, number>,
  histPrices: Map<string, number>,
  /**
   * Hash mint-op'а для V3-style NFT-positions. Если задан — используется
   * как stable per-NFT discriminator (instanceId), и `findFirstOpen` /
   * `currentCostBasisForPosition` фильтруют ops по op.hash mint'а вместо
   * pool.id. Без этого две V3 NFT в одном пуле получают одинаковый
   * cost basis (см. POS-001/002 на Alex 2026-05-07).
   */
  v3MintOpHash?: string,
  /** Точные V3 pool prices на mint-блоках (slot0). Для buildV3Details. */
  v3MintPoolPrices?: BuildOptions["v3MintPoolPrices"],
  /** CoinGecko USD цены на timestamp mint'а — наивысший приоритет. */
  v3MintCgPrices?: BuildOptions["v3MintCgPrices"],
  /**
   * Set hash'ей mints, уже привязанных к ДРУГИМ V3 NFT в этом протоколе+chain.
   * Передаётся в buildV3Details чтобы fallback strict-pair-filter их
   * исключил (предотвращает дубль cost basis для unmatched NFT).
   */
  consumedMintHashes?: ReadonlySet<string>,
  /**
   * UCB single-source-of-truth: cost basis overrides from D3/A4. Передаётся
   * в `computePositionConsumedCostFromLots` для построения accurate fresh
   * LotTracker (с теми же overrides как `newTrackers.lotsByWallet`).
   */
  costBasisOverrideByHash?: ReadonlyMap<string, number>,
  /**
   * On-chain audit для Aave V3 lending позиций (см. BuildOptions.lendingAuditByKey).
   * Передаётся в `computeFees` чтобы переопределить `depositAmountSum` на
   * authoritative on-chain Σ mint − Σ burn aToken'а. Это закрывает класс
   * багов от неполного DeBank history (POS-008 0.069 WBTC ghost yield).
   */
  lendingAuditByKey?: BuildOptions["lendingAuditByKey"],
): OpenPosition | null {
  const { wallet, ops } = loaded;
  if (lp.supply.length === 0) return null;

  const targetSyms = new Set(lp.supply.map((s) => normalizeSymbol(s.symbol)));

  // Универсальный matching по mint'у/contract-address LP-receipt'а.
  // У каждой DeFi-позиции (lending market, LP, vault, perp, staking pool)
  // свой уникальный контракт — этот контракт и используем для уникализации.
  // Применяем для ВСЕХ категорий: если у позиции есть `lpTokenId` (DeBank
  // pool.id / detail.token.id / supply protocol-token id) — фильтруем ops
  // по нему, отделяя историю одного маркета от других в этом протоколе.
  // Если `lpTokenId` не задан — фильтр not-op (двухступенчатый fallback в
  // findFirstOpen / cycleDeposit гарантирует что результаты не потеряются).
  const filterLpTokenId = lp.lpTokenId;
  // Трёхступенчатый поиск даты открытия:
  //   1) С lpTokenId-фильтром + строгий targetSyms (по live supply) —
  //      обычная семантика для протоколов с receipt'ом.
  //   2) Без lpTokenId, строгий targetSyms — fallback если DeBank не дал
  //      pool.id или формат не совпал с linker'ом.
  //   3) Без lpTokenId + RELAX режим (любое meaningful out > $1) —
  //      для receipt-less протоколов (Morpho Blue) или случаев когда
  //      historical collateral symbols отличаются от live supply
  //      (Morpho показывает WETH+USDC через unwrap GLV-vault, а в
  //      истории был GLV out → строгий targetSyms никогда не найдёт).
  let opened = findFirstOpen(
    ops,
    lp.protocolId,
    lp.chain,
    targetSyms,
    filterLpTokenId,
  );
  if (!opened && filterLpTokenId) {
    opened = findFirstOpen(ops, lp.protocolId, lp.chain, targetSyms);
  }
  if (!opened) {
    opened = findFirstOpen(
      ops,
      lp.protocolId,
      lp.chain,
      targetSyms,
      undefined,
      true /* relax */,
    );
  }
  // V3 short-circuit: если у нас есть mint op.hash для этой live позиции
  // (от matchV3LiveToMints), переопределяем `opened` на ИМЕННО этот mint.
  // Без этого 3 V3 NFT в одном пуле получают одинаковую дату — самой ранней
  // mint в этом пуле. С v3MintOpHash каждая получает свою дату создания.
  if (v3MintOpHash) {
    const mintOp = ops.find((o) => o.hash === v3MintOpHash);
    if (mintOp) {
      opened = { time: mintOp.time, hash: mintOp.hash };
    }
  } else if (isV3LpProtocol(lp.protocolName)) {
    // V3 без сматченного NFT: findFirstOpen фильтрует по `targetSyms.has`
    // (intersection), что для WETH/ARB live позиции возвращает самый ранний
    // WETH/USDC mint (общий WETH). Перезаписываем на самый ранний lp_add с
    // ТОЧНОЙ парой = sorted normalized live symbols.
    const livePairKey = [...targetSyms].sort().join("+");
    const earliestPairMatch = ops
      .filter(
        (o) =>
          !!o.protocol &&
          o.protocol.id === lp.protocolId &&
          o.chain === lp.chain &&
          o.type === "lp_add" &&
          o.status !== "failed",
      )
      .map((o) => {
        const meaningful = o.movement.filter(
          (m) =>
            m.direction === "out" &&
            m.amount > 0 &&
            !m.isProtocolToken &&
            !(
              (m.symbol === "ETH" || m.symbol === "WETH") &&
              m.amount < 0.01 &&
              (m.usd ?? 0) < 100
            ),
        );
        const pair = [
          ...new Set(meaningful.map((m) => normalizeSymbol(m.symbol))),
        ]
          .sort()
          .join("+");
        return { op: o, pair };
      })
      .filter((x) => x.pair === livePairKey)
      .sort((a, b) => a.op.time - b.op.time)[0];
    if (earliestPairMatch) {
      opened = {
        time: earliestPairMatch.op.time,
        hash: earliestPairMatch.op.hash,
      };
    }
  }

  // Avantis-fix backfill: если до сих пор opened=null, но в protocol+chain
  // есть `swap` ops с OUT-side underlying матчащим live LP supply tokens —
  // вероятно это yield-vault deposit классифицированный как swap (Avantis
  // USDC OUT → USDC.f IN; classifier не различил без `isProtocolToken`
  // флага на receipt-токене). Берём earliest такой swap как opened-event.
  if (!opened) {
    const liveUnderlying = new Set(
      lp.supply.map((s) => normalizeSymbol(s.symbol)),
    );
    const earliestSwap = ops
      .filter(
        (o) =>
          !!o.protocol &&
          o.protocol.id === lp.protocolId &&
          o.chain === lp.chain &&
          o.type === "swap" &&
          o.status !== "failed",
      )
      .filter((o) => {
        // OUT-side содержит хотя бы один underlying токен live LP.
        const outs = o.movement.filter(
          (m) =>
            m.direction === "out" && m.amount > 0 && !m.isProtocolToken,
        );
        return outs.some((m) => liveUnderlying.has(normalizeSymbol(m.symbol)));
      })
      .sort((a, b) => a.time - b.time)[0];
    if (earliestSwap) {
      opened = { time: earliestSwap.time, hash: earliestSwap.hash };
    }
  }

  // Диагностика: live позиция есть, но `opened` остался null после всех
  // попыток. Это означает что в `ops` нет ни одного matching lp_add /
  // lend_supply / stake / perp_open. Самые частые причины:
  //   1) История DeBank /history усечена (превысили maxPages=50) — самый
  //      ранний mint остался за пределами окна. Решение — увеличить
  //      maxPages или fetch by chain.
  //   2) NFT/receipt пришли через transfer от другого адреса — никакого
  //      mint в этом кошельке не было. Решение — авто-detect такого случая.
  //   3) protocol.id mismatch между live (`lp.protocolId`) и историей
  //      (`op.protocol.id`). Логируем самплы для verification.
  //   4) Cross-chain (live на L2, mint был на L1).
  // Лог печатается ОДИН раз на позицию в dev-console, чтобы можно было
  // быстро понять причину для конкретного POS-XXX.
  if (!opened && typeof window !== "undefined") {
    const sameProtoOps = ops.filter(
      (o) =>
        o.protocol?.id === lp.protocolId &&
        o.chain === lp.chain &&
        o.status !== "failed",
    );
    const opsByType = sameProtoOps.reduce<Record<string, number>>((acc, o) => {
      acc[o.type] = (acc[o.type] ?? 0) + 1;
      return acc;
    }, {});
    const allProtoIds = new Set(
      ops.map((o) => o.protocol?.id).filter(Boolean),
    );
    console.warn(
      `[open_positions] no opened-event for live ${lp.protocolName}/${lp.chain} ` +
        `(${[...targetSyms].join("+")}) on wallet ${wallet.name}. ` +
        `lp.protocolId="${lp.protocolId}" lp.lpTokenId="${lp.lpTokenId ?? ""}". ` +
        `Same protoId+chain ops: ${sameProtoOps.length} (by type: ${JSON.stringify(opsByType)}). ` +
        `Total ops on wallet: ${ops.length}. ` +
        `Distinct protoIds present in ops: ${[...allProtoIds].slice(0, 20).join(",") || "(none)"}.`,
    );
  }

  // UCB C5: cost-basis tracker для этого wallet'а.
  // Если caller передал `lotsByWallet` (новый LotTracker от ucb_pipeline) —
  // адаптируем его через PerWalletLotTrackerView (per-wallet view с
  // legacy `avgAt`/`currentAvg` API). Иначе — используем legacy tracker.
  // Результат downstream одинаковый: depositUsdFromOp читает WAC через
  // `tracker.avgAt(symbol, time)`. Эта проводка устраняет divergence
  // между newTrackers (UCB single-source-of-truth) и legacy CostBasisTracker
  // которая давала ошибку $220 на POS-005 и $2k на POS-007 swap'ах.
  const tracker = lotsByWallet?.get(wallet.id)
    ? new PerWalletLotTrackerView(
        lotsByWallet.get(wallet.id)!,
        wallet.id,
      )
    : trackerByWallet.get(wallet.id);

  // V3-style concentrated liquidity → отдельная механика с IL.
  const v3 = isV3LpProtocol(lp.protocolName)
    ? buildV3Details(
        lp,
        ops,
        histPrices,
        currentPrices,
        v3MintOpHash,
        v3MintPoolPrices,
        v3MintCgPrices,
        consumedMintHashes,
      )
    : null;

  const supplyTokens: OpenPositionToken[] = lp.supply.map((s) => {
    // Стартовая стоимость = «сколько USD я реально вложил в эту позицию
    // в момент открытия». Это семантически отличается от current value
    // (которое включает накопленный yield).
    //
    // Алгоритм:
    // 1. **ПРИОРИТЕТ** — `cycleDeposit.usd`: сумма USD которая ушла в адрес
    //    protocolId за этот цикл. Точное значение из tx histories.
    //    Используем если `live.amount >= deposit.amount × 0.95` (т.е. позиция
    //    не была частично выведена). Yield-рост (live > deposit) не считаем
    //    проблемой — startUsd остаётся реально вложенным.
    // 2. **Fallback на runningAvg** — если cycleDeposit.usd = 0
    //    (classifier не нашёл deposit ops в истории, например для очень
    //    нишевого протокола без полной истории на DeBank/Helius).
    //    `startUsd = live.amount × avgAt(opened.time)` — средневзвешенная
    //    цена покупки токена на момент открытия позиции.
    // 3. Last resort — пропорциональный fallbackUsdFromOpen.
    const isStable = s.isStable;
    const avgNow = isStable ? 1 : (tracker?.currentAvg(s.symbol) ?? null);
    const avgAtOpen = isStable
      ? 1
      : opened
        ? (tracker?.avgAt(s.symbol, opened.time) ?? avgNow)
        : avgNow;
    let cycleDeposit = currentCycleDepositForSymbol(
      ops,
      lp.protocolId,
      lp.chain,
      opened?.time ?? null,
      s.symbol,
      filterLpTokenId,
      histPrices,
      tracker, // Bob/Vladimir fix: pass cost-basis tracker для per-supply WAC
    );
    // Fallback без фильтра, если по конкретному маркету ничего не нашли
    // (DeBank pool.id не совпал с linkedLpTokenId / линкер не свёл пары).
    if (cycleDeposit.usd === 0 && filterLpTokenId) {
      cycleDeposit = currentCycleDepositForSymbol(
        ops,
        lp.protocolId,
        lp.chain,
        opened?.time ?? null,
        s.symbol,
        undefined,
        histPrices,
        tracker,
      );
    }

    let startUsd: number;
    let priceSource: OpenPositionToken["priceSource"];

    // UCB single-source-of-truth (Vladimir POS-002 fix):
    //
    // **ПРИОРИТЕТ 1**: LotTracker-based — replays ops через fresh tracker
    // с D3/A4/D5 overrides и захватывает cost basis консумированных лотов
    // для lend_supply / lp_add ops в эту позицию. Это даёт ТОТ ЖЕ результат
    // что lot-by-lot view в Purchase History popup — устраняет inconsistency
    // между column sum и position summary.
    //
    // Lending (Aave / Fluid / Compound / Morpho / Spark), V3 LP, GMX V2 /
    // GLV — ВСЕ позиции где underlying actively supplied используют этот path.
    //
    // **ПРИОРИТЕТ 2**: legacy cycleDeposit (WAC через CostBasisTracker) —
    // fallback когда LotTracker replay вернул 0 (e.g. позиция в protocol
    // без proper ops match).
    //
    // **ПРИОРИТЕТ 3**: avgAtOpen × s.amount — last-resort если ни один
    // tracker не has data.
    const overrideByHash = costBasisOverrideByHash;
    // UCB C5 Phase C: используем shared LotTracker если доступен (от
    // ucb_pipeline через lotsByWallet). Это устраняет inline ребилд
    // на каждый supply event и гарантирует, что lot-by-lot popup и
    // position summary читают одинаковый WAC.
    const sharedLot = lotsByWallet?.get(wallet.id);
    const lotConsumed: { amount: number; usd: number; fallbackUsd: number } =
      isStable
        ? { amount: 0, usd: 0, fallbackUsd: 0 }
        : computePositionConsumedCostFromLots(
            ops,
            wallet.id,
            lp.protocolId,
            lp.chain,
            s.symbol,
            opened?.time ?? null,
            filterLpTokenId,
            histPrices,
            overrideByHash,
            sharedLot,
          );

    if (
      // UCB C9: accept lotConsumed как valid даже если usd = 0
      // (borrow-funded positions имеют zero cost basis по UCB).
      // Differentiation: lotConsumed.amount > 0 значит walker нашёл
      // target supply ops (i.e. real position). Если amount = 0 — нет
      // позиции в наших ops, fallback к cycleDeposit.
      lotConsumed.amount > 0 &&
      lotConsumed.usd >= 0 &&
      s.amount >= lotConsumed.amount * 0.5
    ) {
      if (s.amount >= lotConsumed.amount * 0.95) {
        startUsd = lotConsumed.usd;
      } else {
        // Партиальный withdraw — пропорционально оставшейся доле.
        startUsd = lotConsumed.usd * (s.amount / lotConsumed.amount);
      }
      priceSource = "cost_basis";
    } else if (
      cycleDeposit.usd > 0 &&
      cycleDeposit.amount > 0 &&
      s.amount >= cycleDeposit.amount * 0.5
    ) {
      if (s.amount >= cycleDeposit.amount * 0.95) {
        startUsd = cycleDeposit.usd;
      } else {
        startUsd = cycleDeposit.usd * (s.amount / cycleDeposit.amount);
      }
      priceSource = "cost_basis";
    } else if (avgAtOpen != null && avgAtOpen > 0) {
      startUsd = s.amount * avgAtOpen;
      priceSource = "cost_basis";
    } else {
      const fb = fallbackUsdFromOpen(ops, lp.protocolId, s.symbol, histPrices);
      startUsd =
        fb.totalAmount > 0
          ? fb.totalUsd * (s.amount / fb.totalAmount)
          : s.usd;
      priceSource = "fallback";
    }
    // Начальное кол-во токенов в позиции — берём из того же источника,
    // что и startUsd, чтобы числа были консистентны. Приоритет = lot
    // tracker (точные consumed amount'ы), иначе cycleDeposit, иначе
    // live `s.amount` как last-resort (значит нет deposit-history).
    const startAmount =
      lotConsumed.amount > 0
        ? lotConsumed.amount
        : cycleDeposit.amount > 0
          ? cycleDeposit.amount
          : s.amount;

    // Нормализуем tokenId: убираем chain prefix ("arb:0x..." → "0x...")
    // и suffix ":lending"/":vault" — нужно для on-chain lookup'ов.
    const rawTid = s.tokenId;
    const cleanTid = rawTid
      ? rawTid
          .replace(/^[a-z]{2,6}:/i, "")
          .replace(/:[a-z][a-z0-9_-]+$/i, "")
      : undefined;
    return {
      symbol: s.symbol,
      amount: s.amount,
      startAmount,
      currentUsd: s.usd,
      avgBuyPrice: isStable ? 1 : (avgAtOpen ?? null),
      startUsd,
      priceSource,
      // UCB C5 Phase F (Task #19): explicit unknown provenance flag.
      // > 0 → cost basis включает silent m.usd fallback (см. console.warn
      // в computePositionConsumedCostFromLots).
      ...(lotConsumed.fallbackUsd > 0 && { fallbackUsd: lotConsumed.fallbackUsd }),
      ...(cleanTid && { tokenId: cleanTid }),
    };
  });

  // Position-level startUsd через **universal WAC по receipt-токену**:
  //   - V3 LP: используем механизм Uniswap V3 (с расчётом IL).
  //   - Любая позиция с известным `lpTokenId` (lending aToken, staking stETH,
  //     LP receipt, GMX V2 GM/GLV, …): идём по матчащим ops хронологически,
  //     накапливаем `cost` (USD заплачено) и `amount` (receipt-token
  //     получено). При partial withdraw списываем cost = receiptOut × avg.
  //     В итоге `costUsd` = «сколько вложено в то, что СЕЙЧАС в позиции».
  //     Это правильная semantics для multi-deposit + partial-withdraw циклов.
  //   - Если `lpTokenId` неизвестен (DeBank не отдал anchor): fallback на
  //     per-token decomposition supplyTokens.startUsd.reduce(+).
  // КРИТИЧНО: для start-USD нужно различать 2 типа multi-asset supply:
  //
  //  A) **Independent multi-collateral** (Aave V3, Morpho, Compound):
  //     каждый supply-актив депонируется ОТДЕЛЬНОЙ tx, имеет независимый
  //     receipt (aWETH+aWBTC) или receipt-less учёт. `currentCostBasisForPosition`
  //     отслеживает только ОДИН receipt → даёт неполный ответ. Правильно
  //     суммировать per-token startUsd через `supplyTokens.reduce`.
  //
  //  B) **Aggregated single-receipt** (GMX V2 GM, GLV, GLP, FLP, Fluid
  //     Vault fVLT, Balancer BPT): пользователь вкладывает X USDC,
  //     получает ОДИН receipt-токен. Live state показывает «underlying»
  //     композицию (1.94 WETH + 4528 USDC), но это разложение receipt'а,
  //     не отдельные депозиты. Position-level по этому receipt'у даёт
  //     ПРАВИЛЬНЫЙ суммарный USD ($9000), а per-token sum даёт неправильный
  //     ($4528 — scaled до live underlying ratio). Баг 2026-05-09: POS-001
  //     GMX V2 показывал $4528 вместо $9000.
  //
  // Решение: считаем ОБА варианта и берём МАКСИМУМ:
  //   - Для (A) Aave: positionLevel ≈ половина (один receipt из двух),
  //     supplySum ≈ полная сумма → MAX берёт supplySum (правильно)
  //   - Для (B) GMX: positionLevel ≈ полная сумма (один receipt), supplySum
  //     ≈ scaled (неполная) → MAX берёт positionLevel (правильно)
  //   - Для single-asset lending: оба ≈ полная сумма → MAX = либо
  //
  // Различаем (A) single-aggregated vs (B) multi-collateral через признак
  // «есть ли в supplyTokens символ, которого пользователь физически НЕ
  // вносил из кошелька». Если есть — это synthetic decomposition
  // aggregated-receipt'а, и supplySumStartUsd ненадёжен.
  //
  //   - **(A) Single-aggregated** (GMX V2 GM, GLV, Fluid Vault fVLT, Balancer
  //     BPT, Pendle SY/PT/YT): пользователь вносит ОДИН тип актива (USDC),
  //     получает receipt, который live-state раскладывает на multi-asset
  //     композицию (WBTC + USDC). WBTC в out-movements не появлялся.
  //     → use `positionLevelDeposit` (out-side USD only)
  //   - **(B) Independent multi-collateral** (Aave V3, Morpho, Compound):
  //     каждый supply-актив депозитится отдельной tx с реальным out-movement.
  //     → use `MAX(positionLevelDeposit, supplySumStartUsd)`
  //
  // ВАЖНО: предыдущая попытка различать через `distinctReceipts.size` была
  // неверной, потому что ops протокола включают ВСЕ позиции пользователя в
  // этом протоколе (POS-001, POS-002, POS-003 = 3 разных GM-контракта в
  // GMX V2), что даёт `size > 1` всегда. Из-за этого фикс не активировался
  // и POS-002 показывал $5,366 вместо $5,000. Bug 2026-05-09 v3.
  const positionLevelDeposit =
    !v3 && filterLpTokenId
      ? currentCostBasisForPosition(
          ops,
          lp.protocolId,
          lp.chain,
          opened?.time ?? null,
          filterLpTokenId,
          tracker,
          histPrices,
        ).costUsd
      : 0;
  const supplySumStartUsd = supplyTokens.reduce((acc, t) => acc + t.startUsd, 0);
  // Собираем set'ом символов то что пользователь реально вносил в эту
  // конкретную позицию (фильтр по filterLpTokenId, чтобы не смешивать
  // разные сабпозиции одного протокола).
  const cycleStart = opened?.time ?? 0;
  const outSymbolsInCycle = new Set<string>();
  for (const op of ops) {
    if (op.status === "failed") continue;
    if (!op.protocol || op.protocol.id !== lp.protocolId) continue;
    if (op.chain !== lp.chain) continue;
    if (op.time < cycleStart) continue;
    if (op.type !== "lp_add" && op.type !== "lend_supply") continue;
    if (filterLpTokenId && !opMatchesLpMarket(op, filterLpTokenId)) continue;
    for (const m of op.movement) {
      if (m.direction !== "out" || m.amount <= 0) continue;
      if (m.isProtocolToken) continue;
      // Gas micro-amounts ETH не считаем «вкладом».
      if (
        (m.symbol === "ETH" || m.symbol === "WETH") &&
        m.amount < 0.01 &&
        (m.usd ?? 0) < 100
      )
        continue;
      outSymbolsInCycle.add(normalizeSymbol(m.symbol));
    }
  }
  // Если хоть один supply-токен НЕ был внесён пользователем — это synthetic
  // decomposition aggregated-receipt'а.
  const hasSyntheticSupply = supplyTokens.some(
    (t) => !outSymbolsInCycle.has(normalizeSymbol(t.symbol)),
  );
  const isSingleAggregated = hasSyntheticSupply && positionLevelDeposit > 0;
  let startUsd = v3
    ? v3.depositUsd
    : isSingleAggregated
      ? positionLevelDeposit
      : Math.max(positionLevelDeposit, supplySumStartUsd);

  // UCB C5 Phase G (Task #37, anti-recurrence #1, 2026-05-23):
  // Когда position.startUsd берётся НЕ из Σ supplyTokens.startUsd (V3 LP
  // case: v3.depositUsd из hist-prices; single-aggregated case: receipt
  // walker), rescale supplyTokens пропорционально чтобы Σ === startUsd.
  //
  // Без этого rescale на V3 LP позициях с большим mark-to-market drift
  // (e.g. POS-007 PAXG/USDC: walker = $642, hist = $1180.82 → diff $538)
  // получался [provenance warn] divergence — Σ supplyTokens != position.startUsd.
  // Это путало пользователя и UI (per-token PnL summing != position PnL).
  //
  // Если supplyTokens.startUsd суммируется к 0 (исходный walker pустой
  // на orphan/new position) → распределяем equally, чтобы избежать
  // деления на ноль.
  if (supplyTokens.length > 0 && startUsd > 0) {
    const supplyTokensSum = supplyTokens.reduce(
      (s, t) => s + (t.startUsd ?? 0),
      0,
    );
    if (Math.abs(supplyTokensSum - startUsd) / Math.max(startUsd, 1) > 0.005) {
      // Diff > 0.5% → rescale.
      const scale =
        supplyTokensSum > 0 ? startUsd / supplyTokensSum : 0;
      for (const t of supplyTokens) {
        if (scale > 0) {
          t.startUsd = (t.startUsd ?? 0) * scale;
        } else {
          t.startUsd = startUsd / supplyTokens.length;
        }
      }
    }
  }
  // `lp.assetUsd` DeBank даёт all-in: underlying liquidity + accrued
  // uncollected fees. Для всех протоколов кроме V3 LP это правильно
  // (fees rebase'ятся в supply amount → не дублируются). Для V3 LP
  // (Uniswap V3 / PancakeSwap / Aerodrome V3 etc.) fees — отдельный
  // balance в `tokensOwed0/1`, который DeBank складывает в assetUsd.
  // В нашем UI fees показываются ОТДЕЛЬНОЙ колонкой "Fee" + участвуют
  // в "Итого активы" через `totalAssetsOf()`. Если не вычесть их из
  // currentUsd, они **дважды учитываются** в Итого активы.
  //
  // Поэтому для V3 LP: currentUsd = lp.assetUsd − pending fees.
  // Это даёт pure liquidity value (LP NFT принципал), что matches
  // Uniswap UI «Position Value» / Revert «Current LP Value».
  //
  // ВАЖНО: `feesUsd` ещё не посчитан в этой точке — он считается
  // через `computeFees(lp, ...)` ниже. Делаем pre-compute v3 fees
  // из `lp.rewards` напрямую (тот же источник, что computeFees
  // для v3_rewards), чтобы вычесть до общего currentUsd init'а.
  let currentUsd = lp.assetUsd;
  if (isV3LpProtocol(lp.protocolName)) {
    const v3PendingFeesUsd = lp.rewards.reduce(
      (s, r) => s + (Number.isFinite(r.usd) ? r.usd : 0),
      0,
    );
    currentUsd = Math.max(0, lp.assetUsd - v3PendingFeesUsd);
  }
  const currentDebtUsd = lp.borrow.reduce((acc, t) => acc + t.usd, 0);
  const ageDays = opened
    ? Math.max(0, Math.floor((Date.now() / 1000 - opened.time) / 86_400))
    : null;

  // Fees / supply-yield.
  // Построить on-chain deposited override per symbol (для supply_yield в Aave)
  let onChainDepositedBySymbol: Map<string, number> | undefined;
  if (lendingAuditByKey) {
    const m = new Map<string, number>();
    for (const s of lp.supply) {
      if (!s.tokenId) continue;
      const addr = s.tokenId.includes(":")
        ? s.tokenId.split(":").pop()!
        : s.tokenId;
      const auditKey = `${lp.chain}|${wallet.address.toLowerCase()}|${addr.toLowerCase()}`;
      const entry = lendingAuditByKey.get(auditKey);
      if (entry != null && entry.netDeposited > 0) {
        m.set(normalizeSymbol(s.symbol), entry.netDeposited);
      }
    }
    if (m.size > 0) onChainDepositedBySymbol = m;
  }
  const fees = computeFees(lp, ops, currentPrices, ageDays, onChainDepositedBySymbol);
  const feesUsd = fees?.feesUsd ?? null;
  const feesSource = fees?.source ?? null;
  const feesByToken: OpenPosition["feesByToken"] = fees?.byToken ?? [];
  const feeApr =
    feesUsd != null && startUsd > 0 && ageDays && ageDays > 0
      ? (feesUsd / startUsd) * (365 / ageDays) * 100
      : null;

  // Claimed fees: Σ всех claim_rewards ops по этому protocolId × chain.
  // Для V3 LP — фильтруем по символ-паре (WETH/USDC NFT не должен видеть
  // fee'и от WETH/ARB NFT в том же протоколе+chain).
  const livePairKey = isV3LpProtocol(lp.protocolName)
    ? [...targetSyms].sort().join("+")
    : undefined;
  const feesClaimedUsd = computeClaimedFeesUsd(
    ops,
    lp.protocolId,
    lp.chain,
    histPrices,
    livePairKey,
    opened?.time ?? null,
  );
  // Детализация по claim'ам — для popup с хронологией.
  const feesClaimedHistory = buildClaimedFeesHistory(
    ops,
    lp.protocolId,
    lp.chain,
    histPrices,
    livePairKey,
    opened?.time ?? null,
    startUsd,
  );
  const feesLifetimeUsd = (feesUsd ?? 0) + feesClaimedUsd;
  const feeAprLifetime =
    startUsd > 0 && ageDays && ageDays > 0
      ? (feesLifetimeUsd / startUsd) * (365 / ageDays) * 100
      : null;

  // ──── «В чём открыли (токен)» — реально внесённые активы из supply tx ────
  // Отличается от `supplyTokens` (live decomposition): берём OUT-side из
  // chain_op'ов, чтобы корректно показать GLV для Morpho-c-GLV-collateral
  // или GM для GMX V2 LP, а не их underlying декомпозицию (WETH+USDC).
  //
  // Правила (применяются per supply/lp_add op):
  //   1. OUT-side `isProtocolToken=true` → collateral-receipt deposit
  //      (e.g. GLV кладётся в Morpho-маркет).
  //   2. Иначе IN-side `isProtocolToken=true` → минт receipt'а из
  //      underlying (e.g. user supplies USDC → получает GM в GMX V2).
  //   3. Иначе OUT-side обычный underlying (Aave/Fluid/Compound: ETH/WBTC/USDC).
  //
  // Дебт-receipts (variableDebt*/stableDebt*) и Aave supply receipts
  // (aArbXxx) исключаем — это accounting-токены, не настоящий deposit.
  const isAccountingToken = (sym: string): boolean =>
    /^variableDebt|^stableDebt/i.test(sym) || /^a[A-Z][a-zA-Z]/.test(sym);
  // Execution-fee micro-amounts (GMX V2 executionFee ≈ 0.00003-0.0002 ETH
  // в каждой deposit-tx). Это оплата keeper'у, не часть deposit'а.
  const isGasMicroAmount = (m: {
    symbol: string;
    amount: number;
    usd: number | null;
  }): boolean =>
    (m.symbol === "ETH" || m.symbol === "WETH") &&
    m.amount < 0.01 &&
    (m.usd ?? 0) < 100;
  // Receipt-less протоколы (Morpho Blue, Drift, Adrena) не имеют
  // lpTokenId, совпадающего с asset movements, — там tokenId = market
  // contract, а movements = underlying GLV/WBTC/USDC. Для них filter
  // выдаст 0; пропускаем filter и матчим только по (protocol, chain).
  // Для остальных (Fluid vaults, GMX markets, V3 NFT pairs) filter
  // обязателен, иначе ops разных sub-positions cross-pollute друг друга.
  const isReceiptLess = isReceiptLessProtocol(lp.protocolId, lp.protocolName);
  // V3 NFT-positions делят ОДИН общий контракт NFT-manager'а (UNI-V3-POS)
  // — `filterLpTokenId` сматчит ВСЕ NFT'ы пары вместо одного. Уникальным
  // идентификатором конкретной NFT является `v3MintOpHash` (= hash mint-tx).
  // Если задан — scope'им к этой одной mint-tx (это семантически correct
  // для «Внесено при ОТКРЫТИИ»: subsequent increase-liquidity — доливки,
  // а не открытие).
  //
  // Без этой проверки bob POS-002 (UniV3 arb ETH+ARB NFT) показывал
  // 3.700 WETH вместо 2.373 — потому что в openedInTokens протекали
  // OUT-движения из POS-001 (1.327 WETH) и POS-003 (0.778 WETH) того же
  // UNI-V3-POS контракта.
  const isV3 = isV3LpProtocol(lp.protocolName);
  const matchingOps = ops.filter((op) => {
    if (op.status === "failed") return false;
    if (!op.protocol) return false;
    const idMatch = op.protocol.id === lp.protocolId;
    const nameMatch =
      op.protocol.name &&
      lp.protocolName &&
      op.protocol.name.toLowerCase() === lp.protocolName.toLowerCase();
    if (!idMatch && !nameMatch) return false;
    if (op.chain !== lp.chain) return false;
    if (op.time < cycleStart) return false;
    const isDelegationMintOp = op.notes?.includes("delegation-mint");
    if (
      op.type !== "lp_add" &&
      op.type !== "lend_supply" &&
      !isDelegationMintOp
    )
      return false;
    // V3 NFT: scope to mint-tx only (when discriminator известен).
    if (isV3 && v3MintOpHash) {
      return op.hash === v3MintOpHash;
    }
    // Delegation-mint bypass: smart-account / EIP-7702 wrapped tx'ы
    // имеют tokenId = NFT-instance-id, не контракт-адрес NFT manager'а.
    // Поэтому opMatchesLpMarket(op, filterLpTokenId) для них всегда false.
    // Для них пропускаем strict filter — notes "delegation-mint" — это
    // достаточный признак того, что op принадлежит этой позиции.
    if (
      !isReceiptLess &&
      !isDelegationMintOp &&
      filterLpTokenId &&
      !opMatchesLpMarket(op, filterLpTokenId)
    )
      return false;
    return true;
  });

  // Global 2-pass pick: даём ОДИН primary asset family для всей
  // позиции, а не per-op (без этого GMX V2 LP давал {USDC + GM},
  // хотя позиция семантически в GM; см. user feedback 2026-05-19).
  //
  // Приоритет: deposited-receipt (e.g. GLV→Morpho) → minted-receipt
  // (e.g. USDC→GM в GMX) → plain underlyings (e.g. ETH→Aave).
  const aggregate = (
    movements: Array<{
      symbol: string;
      amount: number;
      tokenId: string | null;
    }>,
  ): Map<string, { amount: number; tokenId?: string }> => {
    const m = new Map<string, { amount: number; tokenId?: string }>();
    for (const mv of movements) {
      const cur = m.get(mv.symbol) ?? {
        amount: 0,
        ...(mv.tokenId ? { tokenId: mv.tokenId } : {}),
      };
      cur.amount += mv.amount;
      m.set(mv.symbol, cur);
    }
    return m;
  };
  const collect = (
    pred: (m: typeof matchingOps[number]["movement"][number]) => boolean,
  ) =>
    matchingOps.flatMap((op) =>
      op.movement.filter(pred).map((m) => ({
        symbol: m.symbol,
        amount: m.amount,
        tokenId: m.tokenId ?? null,
      })),
    );

  // Helper: NFT-style receipt-markers (e.g. Fluid fVLT — `amount=1`,
  // `usd=null`). Это маркер позиции, не fungible value-bearing токен.
  // Реальные fungible receipts (GLV, GM) имеют USD-цену и большое
  // количество. Без этого фильтра Fluid lending ETH/WBTC показывал бы
  // «fVLT 1» вместо underlying.
  const isNftPositionMarker = (m: {
    amount: number;
    usd: number | null;
  }): boolean => (m.usd == null || m.usd < 1) && m.amount <= 10;

  // Pass 1: OUT-side protocol-tokens (collateral-receipt deposits).
  let openedInMap = aggregate(
    collect(
      (m) =>
        m.direction === "out" &&
        m.amount > 0 &&
        m.isProtocolToken &&
        !isAccountingToken(m.symbol) &&
        !isGasMicroAmount(m) &&
        !isNftPositionMarker(m),
    ),
  );
  // Pass 2: IN-side protocol-tokens (minted receipts).
  if (openedInMap.size === 0) {
    openedInMap = aggregate(
      collect(
        (m) =>
          m.direction === "in" &&
          m.amount > 0 &&
          m.isProtocolToken &&
          !isAccountingToken(m.symbol) &&
          !isGasMicroAmount(m) &&
          !isNftPositionMarker(m),
      ),
    );
  }
  // Pass 3: OUT-side underlyings (no receipt at all).
  if (openedInMap.size === 0) {
    openedInMap = aggregate(
      collect(
        (m) =>
          m.direction === "out" &&
          m.amount > 0 &&
          !isAccountingToken(m.symbol) &&
          !isGasMicroAmount(m),
      ),
    );
  }
  const openedInTokens = Array.from(openedInMap.entries()).map(([symbol, v]) => {
    // Нормализуем tokenId как для supplyTokens.tokenId.
    const cleanTid = v.tokenId
      ? v.tokenId
          .replace(/^[a-z]{2,6}:/i, "")
          .replace(/:[a-z][a-z0-9_-]+$/i, "")
      : undefined;
    return {
      symbol,
      amount: v.amount,
      ...(cleanTid && { tokenId: cleanTid }),
    };
  });

  // ─── openedInUsd: USD из chain_op.m.usd ровно тех же mint-движений ───
  // Считаем по той же фильтрации, что openedInTokens — суммируем m.usd
  // OUT-движений матчащих ops. Используем для consistency между
  // «Внесено токенов» и «Стартовая $».
  //
  // Также флаг `hasDelegationMint`: если хоть один из matching ops был
  // классифицирован через rule 11 (delegation-mint без project_id), то
  // `buildV3Details` не сможет прочитать pool slot0 (Alchemy не знает
  // про этот mint) → fallback на DefiLlama даёт drift $5-30 на $14k.
  // В этом случае `openedInUsd` (= chain-op m.usd на момент tx) — это
  // АВТОРИТЕТНАЯ цена из реестра операций.
  let openedInUsd = 0;
  let hasDelegationMint = false;
  for (const op of matchingOps) {
    if (op.notes?.includes("delegation-mint")) hasDelegationMint = true;
    for (const m of op.movement) {
      if (m.direction !== "out" || m.amount <= 0) continue;
      if (isAccountingToken(m.symbol)) continue;
      if (isGasMicroAmount(m)) continue;
      // Skip protocol-token IN unless it's pass-1 collateral receipt
      // (e.g. GLV→Morpho — counts). For V3 mints, UNI-V3-POS is IN, not
      // OUT, so it's already excluded by direction filter.
      if (m.usd != null && m.usd > 0) openedInUsd += m.usd;
    }
  }

  // Override startUsd для delegation-mint позиций (POS-009 case).
  // Причина: buildV3Details для delegation-mint не может прочитать slot0
  // (Alchemy не индексирует smart-account / EIP-7702 mints), и fallback
  // через DefiLlama hourly-bucket даёт drift $5-30 на $14k позиции
  // ($190 на $3.8k у bob's POS-009). m.usd из chain_op — это точная
  // цена на момент tx, совпадает с тем, что показывается в реестре
  // операций. Использование openedInUsd обеспечивает consistency между
  // «Внесено токенов» и «Стартовая $».
  if (hasDelegationMint && openedInUsd > 0) {
    startUsd = openedInUsd;
  }

  // Orphan V3 NFT detect: buildV3Details вернул null когда мы знаем что
  // это V3 LP протокол, И есть consumedMintHashes (siblings матчились).
  // Это означает: mint этой NFT не нашёлся в нашей chain-ops истории
  // → нет cost basis на момент открытия. Fallback на currentUsd как
  // самое честное «не знаем историю» значение. openedAt = null.
  //
  // **POS-008 PAXG/USDC fix**: раньше pair-fallback подбирал sibling'овский
  // increaseLiquidity op (May 16) и приписывал его как mint orphan'а → wrong
  // attribution $206. Теперь orphan честно говорит «не знаем».
  const isV3Lp = isV3LpProtocol(lp.protocolName);
  const coverageIncomplete =
    isV3Lp &&
    !v3 &&
    consumedMintHashes !== undefined &&
    consumedMintHashes.size > 0;
  if (coverageIncomplete) {
    startUsd = lp.assetUsd;
  }

  // instanceId — стабильный per-position discriminator. Для V3 NFT и других
  // multi-position-в-одном-пуле случаев нужен, чтобы override'ы (credit
  // toggle, hidden, currentValue) применялись к КАЖДОЙ позиции отдельно.
  // Используем hash supply-amounts (округлённых до 4 знаков) — уникальный
  // отпечаток позиции даже без NFT tokenId.
  // Приоритет: mint op.hash (для V3 NFT, стабилен per-NFT) > supplyHash
  // (fallback для всего остального, чувствителен к ребалансировке amounts).
  const supplyHash = supplyAmountsHash(supplyTokens);
  const stableInstanceId = v3MintOpHash || supplyHash || undefined;

  return {
    id: "", // будет проставлен снаружи после сортировки
    walletId: wallet.id,
    walletName: wallet.name,
    walletChain: wallet.chain,
    chain: lp.chain,
    protocol: { id: lp.protocolId, name: lp.protocolName, category: lp.category },
    // Pendle V2 даёт category="common" + itemName="Deposit" — это yield-position,
    // классифицируем как LP. Включаем itemName в детект для таких случаев.
    kind: kindFromCategory(`${lp.category} ${lp.itemName ?? ""}`),
    itemName: lp.itemName,
    // Для orphan'ов opened-event скопирован из sibling-NFT mint'а —
    // это вводит в заблуждение, потому что это не НАШ mint. Обнуляем.
    openedAt: coverageIncomplete ? null : (opened?.time ?? null),
    openHash: coverageIncomplete ? null : (opened?.hash ?? null),
    ageDays: coverageIncomplete ? null : ageDays,
    instanceId: stableInstanceId,
    supplyTokens,
    debtTokens: lp.borrow.map((b) => ({
      symbol: b.symbol,
      amount: b.amount,
      usd: b.usd,
    })),
    openedInTokens: coverageIncomplete ? [] : openedInTokens,
    startUsd,
    // UCB D7: net cost basis с учётом borrow leg. Для no-borrow позиций
    // netStartUsd === startUsd.
    netStartUsd: Math.max(
      0,
      startUsd - computeBorrowProceedsUsd(ops, lp.protocolId, lp.chain),
    ),
    currentUsd,
    currentDebtUsd,
    healthRate: lp.healthRate ?? null,
    feesUsd,
    feesSource,
    feesClaimedUsd,
    feesLifetimeUsd,
    // Orphan-NFT: openedAt = null → ageDays null → feeApr формула не
    // считается (защита от деления на 0 и от ложных APR на фейковом
    // ageDays sibling-NFT'а). UI покажет «—» в APR.
    feeApr: coverageIncomplete ? null : feeApr,
    feeAprLifetime: coverageIncomplete ? null : feeAprLifetime,
    feesClaimedHistory,
    feesByToken,
    // По умолчанию 0 — кредитный статус выставляется вручную через
    // override-чекбокс в UI (см. credit_overrides.ts).
    creditFundedUsd: 0,
    ...(v3 ? { v3 } : {}),
    ...(coverageIncomplete ? { coverageIncomplete: true } : {}),
  };
}

/**
 * UCB D7: компонент net cost basis — Σ borrow proceeds минус Σ repay
 * outlay для одной позиции (protocolId × chain). USD берётся из
 * движения (m.usd) на момент события — это approximate market value
 * заёма / погашения когда оно произошло.
 *
 * netStartUsd = startUsd (collateral cost) − borrowProceedsUsd
 *
 * Семантика: для leveraged lending user'у было extract'ed $X cash через
 * borrow (минус то, что вернул через repay) — это уменьшает реальную
 * "сумму вложения" в позицию. После full repay borrowProceedsUsd → 0
 * и net == gross.
 *
 * Clamp Math.max(0, …) защитит от inverted ситуаций (repay > borrow,
 * редко но возможно когда borrow начал ранее observable window).
 */
export function computeBorrowProceedsUsd(
  ops: ClassifiedOp[],
  protocolId: string,
  chain: string,
): number {
  let net = 0;
  for (const op of ops) {
    if (op.status === "failed") continue;
    if (!op.protocol || op.protocol.id !== protocolId) continue;
    if (op.chain !== chain) continue;
    if (op.type === "borrow") {
      for (const m of op.movement) {
        if (m.direction === "in" && m.amount > 0 && (m.usd ?? 0) > 0) {
          net += m.usd ?? 0;
        }
      }
    } else if (op.type === "repay") {
      for (const m of op.movement) {
        if (m.direction === "out" && m.amount > 0 && (m.usd ?? 0) > 0) {
          net -= m.usd ?? 0;
        }
      }
    }
  }
  return Math.max(0, net);
}

/**
 * Σ всех `claim_rewards` ops для конкретного (protocolId, chain).
 * USD считаем по hist-ценам в момент claim → fallback на m.usd.
 */
function computeClaimedFeesUsd(
  ops: ClassifiedOp[],
  protocolId: string,
  chain: string,
  histPrices: Map<string, number>,
  /**
   * Опциональный фильтр: считаем только claim_rewards ops, у которых
   * receives' symbol-pair == livePairKey (sorted normalized). Без этого
   * параметра на V3 позиции одного протокола+chain все pair'ы (WETH/USDC,
   * WETH/ARB) сливаются в одну сумму. С ним — каждая пара видит свои
   * fee'и.
   */
  livePairKey?: string,
  /**
   * Время открытия позиции. Если задано — claim_rewards с op.time < openedTime
   * пропускаются. Это критично для V3 LP: если у юзера была закрытая
   * WETH/USDT позиция ранее, её fee'и не должны приписываться к новой
   * WETH/USDT позиции того же протокола+chain (bob POS-007: до 8.02 18:14
   * был fee collect от прошлой NFT на $704.57 — приписался к новой как
   * "ghost fee").
   */
  openedTime?: number | null,
): number {
  let total = 0;
  for (const op of ops) {
    if (op.status === "failed") continue;
    if (isJunkOp(op)) continue;
    if (op.type !== "claim_rewards") continue;
    if (!op.protocol || op.protocol.id !== protocolId) continue;
    if (op.chain !== chain) continue;
    if (openedTime != null && op.time < openedTime) continue;
    if (livePairKey != null) {
      const meaningful = op.movement.filter(
        (m) => m.direction === "in" && m.amount > 0 && !m.isProtocolToken,
      );
      const opPair = [
        ...new Set(meaningful.map((m) => normalizeSymbol(m.symbol))),
      ]
        .sort()
        .join("+");
      if (opPair !== livePairKey) continue;
    }
    for (const m of op.movement) {
      if (m.direction !== "in" || m.amount <= 0) continue;
      if (isStableSymbol(m.symbol)) {
        total += m.amount;
        continue;
      }
      const coin = defillamaCoinKey(op.chain, m.tokenId, m.symbol);
      let price: number | null = null;
      if (coin) {
        const p = priceFromMap(histPrices, coin, op.time);
        if (p != null && p > 0) price = p;
      }
      if (price != null) {
        total += m.amount * price;
      } else if (m.usd != null && m.usd > 0) {
        total += m.usd;
      }
    }
  }
  return total;
}

/**
 * Развёрнутая история claim'ов для одной позиции — детализация для popup'а.
 *
 * Возвращает Array<ClaimEvent> отсортированный по времени, где каждый event:
 *   - время / hash claim'а
 *   - USD-стоимость снятых fee'ев на момент claim'а (hist-цена)
 *   - токены и их amount'ы
 *   - days since previous claim (или с момента открытия для первого)
 *   - APR за период: `(claim_usd / startUsd) × (365 / days) × 100`
 *
 * APR-baseline = `startUsd` (cost basis). Стабилен между периодами,
 * не требует исторической стоимости позиции (которой у нас нет).
 *
 * positionUsdAtClaim сейчас = `startUsd` (placeholder); в будущем можно
 * заменить на реальную стоимость через pool sqrtPrice на блоке claim'а.
 *
 * pnlSincePrev пока null — без исторической стоимости позиции вычислить
 * нельзя. Если нужно — добавим RPC-чтение sqrtPrice на блоке claim'а.
 */
function buildClaimedFeesHistory(
  ops: ClassifiedOp[],
  protocolId: string,
  chain: string,
  histPrices: Map<string, number>,
  livePairKey: string | undefined,
  openedTime: number | null,
  startUsd: number,
): OpenPosition["feesClaimedHistory"] {
  const events: OpenPosition["feesClaimedHistory"] = [];
  for (const op of ops) {
    if (op.status === "failed") continue;
    if (isJunkOp(op)) continue;
    if (op.type !== "claim_rewards") continue;
    if (!op.protocol || op.protocol.id !== protocolId) continue;
    if (op.chain !== chain) continue;
    if (openedTime != null && op.time < openedTime) continue;
    if (livePairKey != null) {
      const meaningful = op.movement.filter(
        (m) => m.direction === "in" && m.amount > 0 && !m.isProtocolToken,
      );
      const opPair = [
        ...new Set(meaningful.map((m) => normalizeSymbol(m.symbol))),
      ]
        .sort()
        .join("+");
      if (opPair !== livePairKey) continue;
    }
    let usd = 0;
    const tokensReceived: { symbol: string; amount: number; usd: number }[] = [];
    for (const m of op.movement) {
      if (m.direction !== "in" || m.amount <= 0) continue;
      let tokenUsd = 0;
      if (isStableSymbol(m.symbol)) {
        tokenUsd = m.amount;
      } else {
        const coin = defillamaCoinKey(op.chain, m.tokenId, m.symbol);
        let price: number | null = null;
        if (coin) {
          const p = priceFromMap(histPrices, coin, op.time);
          if (p != null && p > 0) price = p;
        }
        tokenUsd = price != null ? m.amount * price : (m.usd ?? 0);
      }
      usd += tokenUsd;
      tokensReceived.push({
        symbol: normalizeSymbol(m.symbol),
        amount: m.amount,
        usd: tokenUsd,
      });
    }
    if (usd <= 0) continue;
    events.push({
      time: op.time,
      hash: op.hash,
      usd,
      tokensReceived,
      positionUsdAtClaim: startUsd > 0 ? startUsd : null,
      aprPeriod: null, // заполним ниже после сортировки
      daysSincePrev: null,
      pnlSincePrev: null,
      pnlSincePrevPct: null,
    });
  }
  events.sort((a, b) => a.time - b.time);
  // Считаем APR за период от предыдущего claim'а (или openedTime для
  // первого claim'а) до этого claim'а.
  let prevTime = openedTime ?? null;
  for (const ev of events) {
    if (prevTime != null && startUsd > 0) {
      const days = (ev.time - prevTime) / 86_400;
      if (days > 0) {
        ev.daysSincePrev = days;
        ev.aprPeriod = (ev.usd / startUsd) * (365 / days) * 100;
      }
    }
    prevTime = ev.time;
  }
  return events;
}

/* ====================== Inferred positions из истории ===================== */

/** Минимальная нетто-сумма депозитов в USD, чтобы считать позицию открытой. */
const INFERRED_MIN_DEPOSIT_USD = 1;

const ADD_TYPES = new Set<ClassifiedOp["type"]>([
  "lp_add",
  "lend_supply",
  "stake",
  "perp_open",
]);

const REMOVE_TYPES = new Set<ClassifiedOp["type"]>([
  "lp_remove",
  "lend_withdraw",
  "unstake",
  "perp_close",
]);

/**
 * Кандидат на отдельную inferred-позицию — каждый `lp_add` (или иной
 * open-event) создаёт отдельную запись. Депозиты НЕ слипаются в одну
 * сумму. lp_remove распределяются FIFO — гасят более ранние депозиты
 * первыми.
 */
interface PositionCandidate {
  protocolId: string;
  protocolName: string;
  protocolCategory: string;
  chain: string;
  /** Время открытия — `op.time` исходного lp_add. */
  openedAt: number;
  openHash: string;
  /** Per-token остаток в этом «отдельном» депозите. */
  remaining: Map<string, { symbol: string; amount: number; usd: number }>;
}

function inferredKindFromCategory(cat: string): PositionKind {
  return kindFromCategory(cat);
}

/**
 * Реконструирует позиции для кошелька из истории операций.
 *
 * Алгоритм (по требованию пользователя):
 *  1. Каждый `lp_add` (и аналогичные open-types) создаёт **отдельную**
 *     позицию-кандидата с собственными tokens/usd/timestamp.
 *  2. `lp_remove` (и close-types) распределяются FIFO — сначала гасят
 *     самый ранний lp_add того же протокола, потом следующий и т.д.
 *  3. После применения всех removes остаются позиции с положительными
 *     остатками — они и идут в OpenPosition[].
 *  4. `claim_rewards` для протокола накапливаются в общий feesClaimedUsd
 *     и распределяются между остающимися позициями пропорционально их
 *     стоимости (примерно справедливо).
 *
 * Это даёт например для Flash Trade: 2 lp_add (548 USDC + 752 USDC) без
 * removes → 2 отдельные позиции с разными датами открытия.
 */
function buildInferredPositions(
  loaded: BuildInput,
  liveKeys: Set<string>,
): OpenPosition[] {
  const wallet = loaded.wallet;

  // Группируем по протоколу: сначала собираем все open-events в порядке
  // времени, потом проходим removes и гасим FIFO.
  const candidatesByProto = new Map<string, PositionCandidate[]>();
  // claim_rewards суммируем глобально по протоколу (потом распределим).
  const claimedByProto = new Map<string, number>();

  // Сортируем ops по времени для FIFO.
  const sortedOps = [...loaded.ops].sort((a, b) => a.time - b.time);

  for (const op of sortedOps) {
    if (op.status === "failed") continue;
    if (isJunkOp(op)) continue;
    if (!op.protocol) continue;
    const protoKey = `${op.chain}|${op.protocol.id}`;

    if (op.type === "claim_rewards") {
      let claimed = 0;
      for (const m of op.movement) {
        if (m.direction !== "in" || m.amount <= 0) continue;
        if (m.usd != null && m.usd > 0) claimed += m.usd;
      }
      claimedByProto.set(protoKey, (claimedByProto.get(protoKey) ?? 0) + claimed);
      continue;
    }

    const isAdd = ADD_TYPES.has(op.type);
    const isRemove = REMOVE_TYPES.has(op.type);
    if (!isAdd && !isRemove) continue;

    if (isAdd) {
      // Каждый lp_add → отдельный candidate.
      const remaining = new Map<
        string,
        { symbol: string; amount: number; usd: number }
      >();
      for (const m of op.movement) {
        if (m.direction !== "out" || m.amount <= 0) continue;
        const sym = normalizeSymbol(m.symbol);
        const cur = remaining.get(sym) ?? { symbol: m.symbol, amount: 0, usd: 0 };
        cur.amount += m.amount;
        cur.usd += m.usd ?? 0;
        remaining.set(sym, cur);
      }
      // Если ни одного выходящего токена — это «open» без депозита, пропускаем.
      if (remaining.size === 0) continue;
      const candidate: PositionCandidate = {
        protocolId: op.protocol.id,
        protocolName: op.protocol.name,
        protocolCategory: op.protocol.category ?? "yield",
        chain: op.chain,
        openedAt: op.time,
        openHash: op.hash,
        remaining,
      };
      const arr = candidatesByProto.get(protoKey) ?? [];
      arr.push(candidate);
      candidatesByProto.set(protoKey, arr);
      continue;
    }

    // isRemove — FIFO применяем к существующим candidates этого протокола.
    const arr = candidatesByProto.get(protoKey);
    if (!arr || arr.length === 0) continue;
    for (const m of op.movement) {
      if (m.direction !== "in" || m.amount <= 0) continue;
      const sym = normalizeSymbol(m.symbol);
      let amountLeft = m.amount;
      let usdLeft = m.usd ?? 0;
      for (const cand of arr) {
        if (amountLeft <= 0) break;
        const tok = cand.remaining.get(sym);
        if (!tok || tok.amount <= 0) continue;
        const used = Math.min(tok.amount, amountLeft);
        const usdShare = (used / m.amount) * usdLeft;
        tok.amount -= used;
        tok.usd -= usdShare;
        if (tok.amount <= 1e-9) cand.remaining.delete(sym);
        amountLeft -= used;
      }
    }
  }

  // Финал: для каждой пары protoKey + candidate с остатками — строим OpenPosition.
  const out: OpenPosition[] = [];
  for (const [protoKey, candidates] of candidatesByProto) {
    const live = liveKeys.has(`${wallet.id}|${protoKey.split("|")[0]}|${protoKey.split("|")[1]}`);
    if (live) continue;

    // Сначала отфильтруем «пустые» (полностью погашенные) candidates.
    const survivors = candidates.filter((c) => {
      let totalUsd = 0;
      for (const t of c.remaining.values()) totalUsd += t.usd;
      return totalUsd >= INFERRED_MIN_DEPOSIT_USD;
    });
    if (survivors.length === 0) continue;

    // Распределим claim_rewards протокола пропорционально remaining USD.
    const claimedTotal = claimedByProto.get(protoKey) ?? 0;
    const survivorsUsd = survivors.map((c) => {
      let s = 0;
      for (const t of c.remaining.values()) s += t.usd;
      return s;
    });
    const totalSurvivorUsd = survivorsUsd.reduce((a, b) => a + b, 0);

    survivors.forEach((cand, idx) => {
      const candUsd = survivorsUsd[idx]!;
      const supplyTokens: OpenPositionToken[] = [];
      for (const tok of cand.remaining.values()) {
        if (tok.amount <= 0 || tok.usd <= 0) continue;
        supplyTokens.push({
          symbol: tok.symbol,
          amount: tok.amount,
          // Для inferred candidates у нас нет отдельной истории supply
          // events — fallback на текущее `amount` (это и есть «остаток»,
          // ничего точнее не доступно).
          startAmount: tok.amount,
          currentUsd: tok.usd,
          avgBuyPrice: tok.amount > 0 ? tok.usd / tok.amount : null,
          startUsd: tok.usd,
          priceSource: "fallback",
        });
      }
      if (supplyTokens.length === 0) return;

      const ageDays = Math.max(
        0,
        Math.floor((Date.now() / 1000 - cand.openedAt) / 86_400),
      );
      const startUsd = candUsd;
      const currentUsd = candUsd;
      const feesClaimedUsd =
        totalSurvivorUsd > 0
          ? (claimedTotal * candUsd) / totalSurvivorUsd
          : 0;
      const feesLifetimeUsd = feesClaimedUsd;
      const feeAprLifetime =
        startUsd > 0 && ageDays > 0
          ? (feesLifetimeUsd / startUsd) * (365 / ageDays) * 100
          : null;

      out.push({
        id: "",
        walletId: wallet.id,
        walletName: wallet.name,
        walletChain: wallet.chain,
        chain: cand.chain,
        protocol: {
          id: cand.protocolId,
          name: cand.protocolName,
          category: cand.protocolCategory,
        },
        kind: inferredKindFromCategory(cand.protocolCategory),
        itemName: "Из истории",
        openedAt: cand.openedAt,
        openHash: cand.openHash,
        ageDays,
        instanceId: cand.openHash,
        supplyTokens,
        debtTokens: [],
        // Для inferred-history позиций (без сопоставленной live entry)
        // нет отдельной supply-tx истории — fallback на supplyTokens
        // (что фактически осталось в позиции).
        openedInTokens: supplyTokens.map((t) => ({
          symbol: t.symbol,
          amount: t.startAmount,
          ...(t.tokenId && { tokenId: t.tokenId }),
        })),
        startUsd,
        // UCB D7: inferred-history positions без debt — net == gross.
        netStartUsd: startUsd,
        currentUsd,
        currentDebtUsd: 0,
        healthRate: null,
        feesUsd: null,
        feesSource: null,
        feesClaimedUsd,
        feesLifetimeUsd,
        feeApr: null,
        feeAprLifetime,
        feesByToken: [],
        creditFundedUsd: 0,
        inferred: true,
      });
    });
  }
  return out;
}

/* ============================ V3 LP details =============================== */

/**
 * Подсчитать стоимость депозита, HODL value и impermanent loss для V3 LP.
 *
 * Алгоритм:
 *  1. Найти все `lp_add` ops, где OUT-движение содержит токен из live.supply.
 *     Берём ALL такие events — пользователь мог добавлять ликвидность несколько
 *     раз.
 *  2. Для каждого деп события: deposit_usd_at_tx = Σ amount_i × price_at_tx_i,
 *     где price_at_tx — историческая цена из DefiLlama (для стейблов = $1).
 *  3. Σ deposit_usd по всем событиям = `depositUsd`.
 *  4. Σ deposit_amount по токенам × current_price = `hodlUsd`.
 *  5. IL = hodlUsd − live.assetUsd.
 */
function buildV3Details(
  lp: LiveProtocolPosition,
  ops: ClassifiedOp[],
  histPrices: Map<string, number>,
  currentPrices: Map<string, number>,
  /**
   * Hash mint op'а (от matchV3LiveToMints). Если задан — фильтруем
   * lp_add ops ТОЛЬКО до этого конкретного mint'а. Без него все mints
   * в одном пуле (например, 3 NFT WETH/USDC) суммируются → все позиции
   * получают одинаковый depositUsd. С ним — каждая видит свой mint.
   */
  v3MintOpHash?: string,
  /**
   * Точные USD-цены V3 mint'ов через `pool.slot0()` на mint-блоке.
   * **ПРИОРИТЕТНЫЙ** источник для `priceAtTx` — точнее DefiLlama hourly,
   * совпадает с Revert Finance / Uniswap UI (отклонение 0%).
   * Ключ: `${chain}|${txHash}`.
   */
  v3MintPoolPrices?: BuildOptions["v3MintPoolPrices"],
  /**
   * CoinGecko USD цены на timestamp mint'а — НАИВЫСШИЙ приоритет (если
   * есть). Совпадает с Revert Finance методологией (multi-venue
   * aggregator, USDC ≠ exactly $1, byte-precise match).
   * Ключ: `${chain}|${txHash}`.
   */
  v3MintCgPrices?: BuildOptions["v3MintCgPrices"],
  /**
   * Set hash'ей mint ops, которые уже привязаны к ДРУГИМ NFT через
   * matchV3LiveToMints. Когда `v3MintOpHash` не задан (этот NFT не
   * получил матч), fallback strict-pair-filter ДОЛЖЕН исключить эти
   * консьюмированные mints — иначе один и тот же mint используется
   * для двух NFT, и обе показывают одинаковый startUsd (баг
   * POS-009/010 PAXG dup).
   */
  consumedMintHashes?: ReadonlySet<string>,
): V3Details | null {
  // Live supply tokens — нормализованные.
  const liveSyms = new Set(lp.supply.map((s) => normalizeSymbol(s.symbol)));
  // Канонический символ-пэйр live-позиции (sorted, normalized).
  const livePairKey = [...liveSyms].sort().join("+");

  const lpAdds = ops.filter(
    (o) =>
      !!o.protocol &&
      o.protocol.id === lp.protocolId &&
      o.type === "lp_add" &&
      o.status !== "failed",
  );
  // Фильтр пары: ТОЧНОЕ совпадение sorted normalized symbol-pair'а
  // между мн-вом OUT'ов mint-op'а и live supply. Используем `intersect`
  // ТОЛЬКО если v3MintOpHash задан (тогда отдельный mint всё равно отсечёт
  // лишнее). Без v3MintOpHash строгий фильтр по паре критичен — иначе
  // WETH/ARB live позиция засосёт WETH/USDC mint'ы потому что WETH общий,
  // и startUsd получится сумма чужих NFT (баг POS-003 на Alex 2026-05-08).
  let matched = lpAdds.filter((op) => {
    const outs = op.movement.filter(
      (m) => m.direction === "out" && m.amount > 0 && !m.isProtocolToken,
    );
    // Газ ETH (микро) исключаем при определении пары.
    const meaningful = outs.filter(
      (m) =>
        !(
          (m.symbol === "ETH" || m.symbol === "WETH") &&
          m.amount < 0.01 &&
          (m.usd ?? 0) < 100
        ),
    );
    if (meaningful.length === 0) return false;
    const opPairKey = [...new Set(meaningful.map((m) => normalizeSymbol(m.symbol)))]
      .sort()
      .join("+");
    return opPairKey === livePairKey;
  });
  // Если есть привязка к конкретному mint NFT — оставляем только его.
  // Это разделяет 3 V3 NFT в одном пуле, у каждой свой depositUsd.
  if (v3MintOpHash) {
    matched = matched.filter((op) => op.hash === v3MintOpHash);
  } else if (consumedMintHashes && consumedMintHashes.size > 0) {
    // Этот NFT — orphan: matchV3LiveToMints не нашёл ему mint в нашей
    // chain-ops истории, но siblings в том же pair-group получили
    // matches. Раньше здесь был pair-only fallback (`!consumedMintHashes`),
    // но он причислял sibling'овский `IncreaseLiquidity` op как «мой
    // mint» → POS-008 PAXG/USDC получала $206 из May 16 increase
    // POS-007. Это **wrong attribution** — increase на одном NFT не
    // создаёт mint другого.
    //
    // Правильное поведение: orphan-NFT помечается `coverageIncomplete`,
    // depositUsd = null (= caller сделает fallback на currentUsd).
    // Возвращаем null чтобы caller знал об отсутствии истории.
    return null;
  }
  if (matched.length === 0) return null;

  // Per-token суммы депозитов и USD-стоимость на момент каждого депозита.
  const depositMap = new Map<string, number>();
  let depositUsd = 0;
  let histCount = 0;
  let fallbackCount = 0;

  for (const op of matched) {
    // 1. Попытка точной цены через V3 pool slot0 на блоке mint'а.
    //    Совпадает с Revert / Uniswap UI байт-в-байт (если стейблов хватает).
    const poolPriceKey = `${op.chain}|${op.hash.toLowerCase()}`;
    const poolPrice = v3MintPoolPrices?.get(poolPriceKey);
    const cgPrice = v3MintCgPrices?.get(poolPriceKey);
    // Determine USD per token0 / token1 if poolPrice available + one side stable.
    let usdPerToken0: number | null = null;
    let usdPerToken1: number | null = null;
    let pricesFromCg = false;
    // ──────────────────────────────────────────────────────────────────
    //  ПРИОРИТЕТ #0: CoinGecko per-token USD на timestamp mint'а.
    //
    //  Совпадает с Revert Finance методологией (multi-venue aggregator,
    //  USDC ≠ exactly $1, time-bucketed). Если для обоих токенов есть
    //  CoinGecko цена — используем их напрямую и пропускаем pool-derived
    //  логику. Slot0 остаётся fallback'ом если CoinGecko вернул null
    //  (новый токен / rate-limit).
    // ──────────────────────────────────────────────────────────────────
    if (poolPrice && cgPrice) {
      const t0 = poolPrice.token0.toLowerCase();
      const t1 = poolPrice.token1.toLowerCase();
      const cg0 = cgPrice.byAddress.get(t0);
      const cg1 = cgPrice.byAddress.get(t1);
      // Native ETH placeholder (movement.tokenId = 0xeeeeee...) — добавим
      // в byAddress по WETH адресу через anchorTokenAddress fallback.
      const cgNativeEth = cgPrice.byAddress.get("0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee");
      const c0 = cg0 ?? (poolPrice.anchorTokenAddress?.toLowerCase() === t0 ? cgNativeEth : undefined);
      const c1 = cg1 ?? (poolPrice.anchorTokenAddress?.toLowerCase() === t1 ? cgNativeEth : undefined);
      if (c0 != null && c1 != null) {
        usdPerToken0 = c0;
        usdPerToken1 = c1;
        pricesFromCg = true;
      }
    }
    if (!pricesFromCg && poolPrice) {
      // Идентификация какой токен в пуле — token0 vs token1 по адресу.
      // Movement.tokenId: для arb/eth/etc. — chain-prefix или raw 0x-hex.
      // Сравниваем case-insensitively, без chain prefix.
      const mints = op.movement.filter(
        (m) => m.direction === "out" && m.amount > 0 && !m.isProtocolToken,
      );
      // Снимаем chain prefix у tokenId если есть.
      const stripPrefix = (id: string): string =>
        id.includes(":") ? id.split(":").pop()! : id;
      const t0 = poolPrice.token0.toLowerCase();
      const t1 = poolPrice.token1.toLowerCase();
      // Один из mints должен быть стейблом — тогда другой = token-USD-price.
      let stableUsd = 0;
      let stableSide: 0 | 1 | null = null;
      for (const m of mints) {
        if (!isStableSymbol(m.symbol)) continue;
        const tid = stripPrefix(m.tokenId).toLowerCase();
        if (tid === t0) {
          stableSide = 0;
          stableUsd = 1;
        } else if (tid === t1) {
          stableSide = 1;
          stableUsd = 1;
        }
      }
      if (stableSide === 1) {
        // token1 = stable ($1) → token0 USD = price1Per0
        usdPerToken0 = poolPrice.price1Per0 * stableUsd;
        usdPerToken1 = stableUsd;
      } else if (stableSide === 0) {
        // token0 = stable ($1) → token1 USD = 1 / price1Per0
        usdPerToken0 = stableUsd;
        usdPerToken1 = stableUsd / poolPrice.price1Per0;
      } else {
        // Volatile/volatile pool (WETH/ARB, WBTC/ETH, PAXG/WBTC, etc.):
        // pool ratio даёт точное соотношение, но абсолютный USD нужен
        // из внешнего источника.
        //
        // ПРИОРИТЕТ якорей:
        //   1) **anchor pool slot0** на ТОМ ЖЕ блоке (`poolPrice.anchorTokenUsd`):
        //      точная цена WETH-USD на блоке mint'а из WETH/USDC pool.
        //      Совпадает с Revert Finance / Uniswap UI байт-в-байт.
        //   2) DefiLlama hourly bucket для самого ликвидного токена пары —
        //      fallback если anchor pool не сконфигурирован для этой сети
        //      или RPC чтение упало.
        //
        // Без anchor'а (только DefiLlama) дрифт достигает $10-30 на $14k
        // позиции (баг POS-002 на Alex 2026-05-08: $14,583 vs $14,555).
        if (
          poolPrice.anchorTokenAddress != null &&
          poolPrice.anchorTokenUsd != null &&
          poolPrice.anchorTokenUsd > 0
        ) {
          const anchorAddr = poolPrice.anchorTokenAddress.toLowerCase();
          if (t0 === anchorAddr) {
            usdPerToken0 = poolPrice.anchorTokenUsd;
            usdPerToken1 = poolPrice.anchorTokenUsd / poolPrice.price1Per0;
          } else if (t1 === anchorAddr) {
            usdPerToken1 = poolPrice.anchorTokenUsd;
            usdPerToken0 = poolPrice.anchorTokenUsd * poolPrice.price1Per0;
          }
        }
        // Fallback на DefiLlama если anchor не сработал.
        if (usdPerToken0 == null && usdPerToken1 == null) {
          const t0Mov = mints.find(
            (m) => stripPrefix(m.tokenId).toLowerCase() === t0,
          );
          const t1Mov = mints.find(
            (m) => stripPrefix(m.tokenId).toLowerCase() === t1,
          );
          const anchorPriority = (sym: string): number => {
            const s = normalizeSymbol(sym);
            if (s === "ETH") return 3;
            if (s === "BTC") return 2;
            return 1;
          };
          const t0Priority = t0Mov ? anchorPriority(t0Mov.symbol) : 0;
          const t1Priority = t1Mov ? anchorPriority(t1Mov.symbol) : 0;
          function llamaPrice(mov: TokenMovement): number | null {
            const coin = defillamaCoinKey(op.chain, mov.tokenId, mov.symbol);
            if (!coin) return null;
            const p = priceFromMap(histPrices, coin, op.time);
            return p != null && p > 0 ? p : null;
          }
          if (t0Priority >= t1Priority && t0Mov) {
            const p0 = llamaPrice(t0Mov);
            if (p0 != null) {
              usdPerToken0 = p0;
              usdPerToken1 = p0 / poolPrice.price1Per0;
            }
          }
          if (usdPerToken0 == null && t1Mov) {
            const p1 = llamaPrice(t1Mov);
            if (p1 != null) {
              usdPerToken1 = p1;
              usdPerToken0 = p1 * poolPrice.price1Per0;
            }
          }
        }
      }
    }

    // ──────────────────────────────────────────────────────────────────
    //  ТОЧНЫЙ путь: Pool.Mint event с atomic amount0/amount1
    //
    //  Если poolPrice содержит exactAmount0/1 (прочитаны из receipt log'ов)
    //  — используем их напрямую, минуя округлённый m.amount от DeBank.
    //  Это убирает $1-3 noise от DeBank rounding'а и даёт точное совпадение
    //  с Revert (тот тоже парсит Pool.Mint event).
    //
    //  exactAmount хранится как string (uint256), чтобы пережить JSON serial.
    //  Конвертация в human float через split-by-decimals для сохранения
    //  всех ~17 sig digits JS Number'а.
    // ──────────────────────────────────────────────────────────────────
    function atomicToHuman(atomic: string, decimals: number): number {
      if (!atomic) return 0;
      const s = atomic.padStart(decimals + 1, "0");
      const intPart = s.slice(0, s.length - decimals) || "0";
      const fracPart = s.slice(s.length - decimals);
      return Number(`${intPart}.${fracPart}`);
    }
    let usedExact = false;
    if (
      poolPrice &&
      poolPrice.exactAmount0 != null &&
      poolPrice.exactAmount1 != null
    ) {
      const a0 = atomicToHuman(poolPrice.exactAmount0, poolPrice.decimals0);
      const a1 = atomicToHuman(poolPrice.exactAmount1, poolPrice.decimals1);
      // Найти symbol для каждой стороны через movement (DeBank даёт правильный
      // symbol для UI, но atomic amounts читаем из chain'а).
      const stripPrefix = (id: string): string =>
        id.includes(":") ? id.split(":").pop()! : id;
      const t0Lower = poolPrice.token0.toLowerCase();
      const t1Lower = poolPrice.token1.toLowerCase();
      let sym0 = "";
      let sym1 = "";
      for (const m of op.movement) {
        if (m.direction !== "out") continue;
        const tid = stripPrefix(m.tokenId).toLowerCase();
        const symN = normalizeSymbol(m.symbol);
        if (tid === t0Lower) sym0 = symN;
        else if (tid === t1Lower) sym1 = symN;
        else if (symN === "ETH" && poolPrice.anchorTokenAddress) {
          // native ETH match: addr to one of pool tokens via anchor.
          const a = poolPrice.anchorTokenAddress.toLowerCase();
          if (a === t0Lower) sym0 = symN;
          else if (a === t1Lower) sym1 = symN;
        }
      }
      // Если symbol не определился — fallback из known WETH symbol.
      if (!sym0 && poolPrice.anchorTokenAddress?.toLowerCase() === t0Lower) sym0 = "ETH";
      if (!sym1 && poolPrice.anchorTokenAddress?.toLowerCase() === t1Lower) sym1 = "ETH";

      depositMap.set(sym0 || `t0:${t0Lower.slice(0, 6)}`, (depositMap.get(sym0) ?? 0) + a0);
      depositMap.set(sym1 || `t1:${t1Lower.slice(0, 6)}`, (depositMap.get(sym1) ?? 0) + a1);

      // USD prices: используем уже вычисленные usdPerToken{0,1}, или $1 для стейблов.
      let p0 = usdPerToken0;
      let p1 = usdPerToken1;
      if (p0 == null && sym0 && isStableSymbol(sym0)) p0 = 1;
      if (p1 == null && sym1 && isStableSymbol(sym1)) p1 = 1;
      // Последний fallback на DefiLlama для редких случаев.
      if (p0 == null && sym0) {
        const coin = defillamaCoinKey(op.chain, t0Lower, sym0);
        if (coin) {
          const hp = priceFromMap(histPrices, coin, op.time);
          if (hp != null && hp > 0) p0 = hp;
        }
      }
      if (p1 == null && sym1) {
        const coin = defillamaCoinKey(op.chain, t1Lower, sym1);
        if (coin) {
          const hp = priceFromMap(histPrices, coin, op.time);
          if (hp != null && hp > 0) p1 = hp;
        }
      }
      if (p0 != null) {
        depositUsd += a0 * p0;
        histCount++;
      }
      if (p1 != null) {
        depositUsd += a1 * p1;
        histCount++;
      }
      usedExact = true;
      // Диагностический лог.
      if (typeof window !== "undefined") {
        const priceSource = pricesFromCg
          ? "coingecko+mintEvent"
          : poolPrice.anchorTokenUsd != null
            ? "anchor_pool_slot0+mintEvent"
            : "pool_slot0_with_stable+mintEvent";
        console.info(
          `[V3 startUsd] ${op.protocol?.name ?? ""} ${op.chain} mint=${op.hash.slice(0, 10)} ` +
            `block=${poolPrice.blockNumber} src=${priceSource} ` +
            `t0=${t0Lower.slice(0, 8)}/$${p0?.toFixed(4) ?? "?"} ` +
            `t1=${t1Lower.slice(0, 8)}/$${p1?.toFixed(6) ?? "?"} ` +
            `(${a0.toFixed(8)} ${sym0} + ${a1.toFixed(8)} ${sym1}) → $${depositUsd.toFixed(2)}`,
        );
      }
    }

    // ──────────────────────────────────────────────────────────────────
    //  Fallback: старая логика через op.movement (DeBank rounded amounts)
    //  Используется когда poolPrice нет или Mint event не прочитался.
    // ──────────────────────────────────────────────────────────────────
    if (!usedExact) {
    for (const m of op.movement) {
      if (m.direction !== "out" || m.amount <= 0) continue;
      const sym = normalizeSymbol(m.symbol);
      depositMap.set(sym, (depositMap.get(sym) ?? 0) + m.amount);

      // Цена в момент tx — приоритет: pool sqrtPrice > DefiLlama > m.usd.
      let priceAtTx: number | null = null;
      // 1. Pool sqrtPrice (если pool был WETH/USDC и USDC = $1).
      if (poolPrice && (usdPerToken0 != null || usdPerToken1 != null)) {
        const stripPrefix = (id: string): string =>
          id.includes(":") ? id.split(":").pop()! : id;
        const tid = stripPrefix(m.tokenId).toLowerCase();
        // Прямое совпадение address-to-address.
        if (tid === poolPrice.token0.toLowerCase() && usdPerToken0 != null) {
          priceAtTx = usdPerToken0;
          histCount++;
        } else if (
          tid === poolPrice.token1.toLowerCase() &&
          usdPerToken1 != null
        ) {
          priceAtTx = usdPerToken1;
          histCount++;
        } else {
          const symNorm = normalizeSymbol(m.symbol);
          if (symNorm === "ETH" && poolPrice.anchorTokenAddress) {
            const anchorAddr = poolPrice.anchorTokenAddress.toLowerCase();
            if (anchorAddr === poolPrice.token0.toLowerCase() && usdPerToken0 != null) {
              priceAtTx = usdPerToken0;
              histCount++;
            } else if (
              anchorAddr === poolPrice.token1.toLowerCase() &&
              usdPerToken1 != null
            ) {
              priceAtTx = usdPerToken1;
              histCount++;
            }
          }
        }
      }
      if (priceAtTx == null && isStableSymbol(m.symbol)) {
        priceAtTx = 1;
        histCount++;
      }
      if (priceAtTx == null) {
        const coin = defillamaCoinKey(op.chain, m.tokenId, m.symbol);
        if (coin) {
          const hp = priceFromMap(histPrices, coin, op.time);
          if (hp != null && hp > 0) {
            priceAtTx = hp;
            histCount++;
          }
        }
      }
      if (priceAtTx == null) {
        if (m.usd != null && m.usd > 0) {
          priceAtTx = m.usd / m.amount;
          fallbackCount++;
        }
      }
      if (priceAtTx != null) depositUsd += m.amount * priceAtTx;
    }
    if (typeof window !== "undefined") {
      const breakdown = op.movement
        .filter((m) => m.direction === "out" && m.amount > 0)
        .map((m) => `${m.amount.toFixed(8)} ${m.symbol}`)
        .join(" + ");
      const priceSource = poolPrice
        ? poolPrice.anchorTokenUsd != null
          ? "anchor_pool_slot0"
          : "pool_slot0_with_stable"
        : "defillama_only";
      console.info(
        `[V3 startUsd] ${op.protocol?.name ?? ""} ${op.chain} mint=${op.hash.slice(0, 10)} ` +
          `block=${poolPrice?.blockNumber ?? "?"} src=${priceSource} ` +
          `t0=${poolPrice?.token0?.slice(0, 8) ?? ""}/$${usdPerToken0?.toFixed(4) ?? "?"} ` +
          `t1=${poolPrice?.token1?.slice(0, 8) ?? ""}/$${usdPerToken1?.toFixed(6) ?? "?"} ` +
          `(${breakdown}) → $${depositUsd.toFixed(2)}`,
      );
    }
    }
  }

  // HODL value = Σ deposit_amount × current_price.
  let hodlUsd = 0;
  const depositTokens: V3Details["depositTokens"] = [];
  for (const [sym, amount] of depositMap) {
    const cur = isStableSymbol(sym)
      ? 1
      : (currentPrices.get(sym) ?? null);
    const usdAtDeposit = matched
      .flatMap((op) => op.movement)
      .filter(
        (m) =>
          m.direction === "out" &&
          normalizeSymbol(m.symbol) === sym &&
          m.amount > 0,
      )
      .reduce((s, m) => s + (m.usd ?? 0), 0); // эта сумма пойдёт в depositTokens.usdAtDeposit как справочно (current-priced)
    depositTokens.push({ symbol: sym, amount, usdAtDeposit });
    if (cur != null) hodlUsd += amount * cur;
  }

  // Pure liquidity value БЕЗ pending fees (rewards) — fees показываются
  // отдельной колонкой и складываются в "Итого активы" через totalAssetsOf.
  // Без этого вычитания fees учитываются дважды (как часть currentLp И
  // как pending). HODL counterfactual использует только underlying
  // deposit amounts × current price — fees не учитывает, поэтому
  // сравнение должно быть с liquidity-only currentLpUsd.
  const v3PendingFeesUsd = lp.rewards.reduce(
    (s, r) => s + (Number.isFinite(r.usd) ? r.usd : 0),
    0,
  );
  const currentLpUsd = Math.max(0, lp.assetUsd - v3PendingFeesUsd);
  const impermanentLossUsd = hodlUsd - currentLpUsd;
  const pnlUsd = currentLpUsd - depositUsd;
  const pnlPct = depositUsd > 0 ? (pnlUsd / depositUsd) * 100 : 0;
  const pricesSource: V3Details["pricesSource"] =
    fallbackCount === 0
      ? "historical"
      : histCount === 0
        ? "fallback"
        : "mixed";

  return {
    depositTokens,
    depositUsd,
    hodlUsd,
    impermanentLossUsd,
    currentLpUsd,
    pnlUsd,
    pnlPct,
    pricesSource,
  };
}

/**
 * Матчинг LIVE V3 позиций с mint-op'ами (lp_add, создающими NFT).
 *
 * Каждый mint в V3 (Uniswap V3, Pancake V3, Sushi V3, Algebra) создаёт
 * **уникальный NFT** в `NonfungiblePositionManager`. Без RPC чтения мы не
 * знаем NFT tokenId, но можем сматчить по supply токенам и amount'ам:
 *
 *   1. Группируем `lp_add` ops в (wallet, protocolId, chain) только для
 *      V3-style протоколов.
 *   2. FIFO consumption: каждый `lp_remove` закрывает самый ранний open
 *      mint с теми же symbols. После всех removes — `openMints[]`.
 *   3. Для каждой LIVE V3 позиции в этом протоколе:
 *      - Фильтруем openMints по точному совпадению **symbol pair**
 *        (sorted: WETH+USDC ≠ WETH+ARB).
 *      - Сортируем кандидатов по близости amount'ов (live vs deposited).
 *      - Берём лучшего, удаляем из пула, сохраняем в matches.
 *
 * Возвращаем `Map<liveMatchKey, mintOpHash>` где liveMatchKey =
 * `${walletId}|${protocolId}|${chain}|${sorted-symbols}|${assetUsd}`.
 *
 * Если match не нашёлся (live позиций больше чем mint'ов) — `instanceId`
 * для такой позиции упадёт на fallback `supplyAmountsHash` в `buildOne`.
 */
/**
 * Канонический ключ для сопоставления LIVE V3 позиции с её mint op.hash
 * через `matchV3LiveToMints`. Используется в обоих местах (генератор и
 * потребитель), чтобы avoid silent mismatch.
 *
 * КРИТИЧНО: использует `normalizeSymbol` (WETH→ETH) ДО сортировки. Если
 * этого не делать, ключи расходятся когда live state имеет 'WETH' а
 * mint history имеет 'ETH' (ситуация Alex 2026-05-08: lookup не находил
 * v3MintMatches, и POS-001/POS-003 получали неправильные startUsd).
 */
function v3LiveMatchKey(args: {
  walletId: string;
  protocolId: string;
  chain: string;
  symbols: readonly string[];
  assetUsd: number;
}): string {
  const sym = [...args.symbols].map((s) => normalizeSymbol(s)).sort().join("+");
  return `${args.walletId}|${args.protocolId}|${args.chain}|${sym}|${args.assetUsd.toFixed(2)}`;
}

function matchV3LiveToMints(
  loaded: BuildInput[],
  /**
   * P1: pool address для каждой mint-tx. Ключ — `${chain}|${hash.toLowerCase()}`.
   * Если задан и для конкретной mint pool известен — матчим строго по
   * `lp.lpTokenId === pool address`. Иначе fallback на amount-distance heuristic.
   */
  v3PoolByTxHash?: ReadonlyMap<string, string | null>,
): Map<string, string /* op.hash */> {
  const out = new Map<string, string>();
  const poolOf = (chain: string, hash: string): string | null => {
    if (!v3PoolByTxHash) return null;
    return (
      v3PoolByTxHash.get(`${chain.toLowerCase()}|${hash.toLowerCase()}`) ??
      null
    );
  };

  for (const l of loaded) {
    if (!l.live) continue;

    // 1. Собираем V3-style mints в этом кошельке per protocol+chain.
    type Mint = {
      hash: string;
      time: number;
      protocolId: string;
      chain: string;
      symbols: string; // sorted "SYM1+SYM2"
      amount0: number;
      amount1: number;
    };
    const mintsByPC = new Map<string, Mint[]>(); // key: protocolId|chain
    for (const op of l.ops) {
      if (op.status === "failed") continue;
    if (isJunkOp(op)) continue;
      if (!op.protocol) continue;
      if (op.type !== "lp_add") continue;
      if (!isV3LpProtocol(op.protocol.name)) continue;
      // КРИТИЧНО: исключаем `increaseLiquidity` ops — это не создание NFT,
      // а добор ликвидности в существующую. Они тоже sends-only и
      // классифицируются как `lp_add`, но НЕ соответствуют отдельной NFT.
      // Если их оставить, optimal assignment может сматчить live к доп.депу
      // (баг POS-002 на Alex 2026-05-08: $1,836 mint → переключилось на
      // $474 increase, дата сместилась с Apr на May).
      if (op.notes?.includes("v3-increase-liquidity")) continue;
      const outs = op.movement.filter(
        (m) => m.direction === "out" && m.amount > 0 && !m.isProtocolToken,
      );
      // Газ ETH (микро) исключаем.
      const meaningfulOuts = outs.filter(
        (m) =>
          !(
            (m.symbol === "ETH" || m.symbol === "WETH") &&
            m.amount < 0.01 &&
            (m.usd ?? 0) < 100
          ),
      );
      if (meaningfulOuts.length === 0) continue;
      // Используем `normalizeSymbol` (WETH→ETH) ДО сортировки, чтобы
      // канонический порядок не сбивался когда mint имеет 'ETH' а live
      // имеет 'WETH' (или наоборот).
      const sortedOuts = [...meaningfulOuts]
        .map((m) => ({ ...m, _canonSym: normalizeSymbol(m.symbol) }))
        .sort((a, b) => a._canonSym.localeCompare(b._canonSym));
      const symbols = sortedOuts.map((m) => m._canonSym).join("+");
      const amount0 = sortedOuts[0]?.amount ?? 0;
      const amount1 = sortedOuts[1]?.amount ?? 0;
      const key = `${op.protocol.id}|${op.chain}`;
      const arr = mintsByPC.get(key) ?? [];
      arr.push({
        hash: op.hash,
        time: op.time,
        protocolId: op.protocol.id,
        chain: op.chain,
        symbols,
        amount0,
        amount1,
      });
      mintsByPC.set(key, arr);
    }

    // 2. FIFO consumption: lp_remove закрывает старейший open mint с
    //    matching symbols. (Грубая heuristic, но обычно работает для
    //    хронологических partial closes.)
    const closedSet = new Set<string>(); // op.hash mint'ов которые были закрыты
    for (const op of [...l.ops].sort((a, b) => a.time - b.time)) {
      if (op.status === "failed") continue;
    if (isJunkOp(op)) continue;
      if (!op.protocol) continue;
      if (op.type !== "lp_remove") continue;
      if (!isV3LpProtocol(op.protocol.name)) continue;
      // Партиальные `decreaseLiquidity` (receives-only, NFT не сжигается)
      // НЕ закрывают NFT — она остаётся live. Не FIFO-консумим её здесь,
      // чтобы не помечать живой mint как закрытый.
      if (op.notes?.includes("v3-decrease-liquidity")) continue;
      const ins = op.movement
        .filter(
          (m) => m.direction === "in" && m.amount > 0 && !m.isProtocolToken,
        )
        .map((m) => ({ ...m, _canonSym: normalizeSymbol(m.symbol) }))
        .sort((a, b) => a._canonSym.localeCompare(b._canonSym));
      const symbols = ins.map((m) => m._canonSym).join("+");
      const key = `${op.protocol.id}|${op.chain}`;
      const mints = (mintsByPC.get(key) ?? [])
        .filter((m) => m.symbols === symbols && !closedSet.has(m.hash))
        .sort((a, b) => a.time - b.time);
      // Закрытие — самый старый. Heuristic: берём первый, чтобы не
      // удалить слишком много (partial closes тоже могут попасть, тогда
      // mint остаётся открытым). Усложнить можно через amount diff,
      // но для начальной версии достаточно FIFO.
      const oldest = mints[0];
      if (oldest) closedSet.add(oldest.hash);
    }

    // 3. Match LIVE V3 positions to remaining open mints.
    //    КРИТИЧНО: при N лайвов и M минтов в одном pool+pair greedy-матчинг
    //    может дать sub-optimal (пример: 4 WETH/USDC NFT с близкими ETH-
    //    суммами). Поэтому для каждой группы (protocol, chain, pair)
    //    собираем все live + mint, и решаем optimal assignment через
    //    brute-force перестановки (N! для маленьких N).
    type LivePos = {
      lp: LiveProtocolPosition;
      amt0: number;
      amt1: number;
      key: string; // protocol|chain
      pair: string; // sorted normalized symbols
    };
    const livesByGroup = new Map<string, LivePos[]>(); // key: protocol|chain|pair
    for (const lp of l.live.positions) {
      if (!isV3LpProtocol(lp.protocolName)) continue;
      const liveSorted = [...lp.supply]
        .map((s) => ({ ...s, _canonSym: normalizeSymbol(s.symbol) }))
        .sort((a, b) => a._canonSym.localeCompare(b._canonSym));
      const pair = liveSorted.map((s) => s._canonSym).join("+");
      const groupKey = `${lp.protocolId}|${lp.chain}|${pair}`;
      const arr = livesByGroup.get(groupKey) ?? [];
      arr.push({
        lp,
        amt0: liveSorted[0]?.amount ?? 0,
        amt1: liveSorted[1]?.amount ?? 0,
        key: `${lp.protocolId}|${lp.chain}`,
        pair,
      });
      livesByGroup.set(groupKey, arr);
    }

    function distance(
      live: { amt0: number; amt1: number },
      mint: Mint,
    ): number {
      const d0 =
        live.amt0 + mint.amount0 > 0
          ? Math.abs(live.amt0 - mint.amount0) / (live.amt0 + mint.amount0)
          : 0;
      const d1 =
        live.amt1 + mint.amount1 > 0
          ? Math.abs(live.amt1 - mint.amount1) / (live.amt1 + mint.amount1)
          : 0;
      return d0 + d1;
    }

    // Brute-force optimal assignment по permutations. Для N <= 8 фактически
    // мгновенно (8! = 40320). N > 8 в DeFi не встречается на практике.
    function optimalAssign(
      lives: LivePos[],
      mints: Mint[],
    ): Map<number, number> {
      const n = lives.length;
      const m = mints.length;
      const k = Math.min(n, m);
      if (k === 0) return new Map();
      // Если k > 8 — fallback на greedy (slot не реалистичен в DeFi).
      if (k > 8) {
        const used = new Set<number>();
        const out = new Map<number, number>();
        const order = [...lives.keys()].sort();
        for (const li of order) {
          let bestJ = -1;
          let bestD = Infinity;
          for (let j = 0; j < m; j++) {
            if (used.has(j)) continue;
            const d = distance(lives[li]!, mints[j]!);
            if (d < bestD) {
              bestD = d;
              bestJ = j;
            }
          }
          if (bestJ >= 0) {
            out.set(li, bestJ);
            used.add(bestJ);
          }
        }
        return out;
      }
      // Brute force: для каждой перестановки mint indices длины k подсчитываем
      // total distance и берём минимальную.
      const liveIdx = [...Array(n).keys()];
      const mintIdx = [...Array(m).keys()];
      let bestPerm: number[] = [];
      let bestSum = Infinity;
      function recurse(picked: number[], available: number[]): void {
        if (picked.length === k) {
          let sum = 0;
          for (let i = 0; i < k; i++) {
            sum += distance(lives[liveIdx[i]!]!, mints[picked[i]!]!);
          }
          if (sum < bestSum) {
            bestSum = sum;
            bestPerm = [...picked];
          }
          return;
        }
        for (let i = 0; i < available.length; i++) {
          const next = available[i]!;
          recurse(
            [...picked, next],
            [...available.slice(0, i), ...available.slice(i + 1)],
          );
        }
      }
      recurse([], mintIdx);
      const result = new Map<number, number>();
      for (let i = 0; i < bestPerm.length; i++) {
        result.set(liveIdx[i]!, bestPerm[i]!);
      }
      return result;
    }

    for (const [groupKey, lives] of livesByGroup) {
      const liveSamplePair = lives[0]!.pair;
      const liveKey = lives[0]!.key;
      const mints = (mintsByPC.get(liveKey) ?? []).filter(
        (m) => !closedSet.has(m.hash) && m.symbols === liveSamplePair,
      );
      if (mints.length === 0) {
        if (typeof window !== "undefined") {
          console.warn(
            `[V3 match] no mints for live group ${groupKey} (${lives.length} lives)`,
          );
        }
        continue;
      }

      // P1: pool-address strict matching. Если у нас есть pool-address
      // resolver (v3PoolByTxHash), сначала пытаемся точный match
      // `lp.lpTokenId === mint pool address`. Это разделяет NFT в разных
      // fee tiers того же pair'а (POS-007/008 PAXG/USDC bug).
      const assignedLiveIdx = new Set<number>();
      const assignedMintHashes = new Set<string>();
      if (v3PoolByTxHash) {
        // Сматчиваем поэтапно: для каждого live с известным lpTokenId
        // ищем mint с таким же pool address.
        for (let li = 0; li < lives.length; li++) {
          const live = lives[li]!;
          const livePool = live.lp.lpTokenId?.toLowerCase();
          if (!livePool) continue;
          for (let mi = 0; mi < mints.length; mi++) {
            const mint = mints[mi]!;
            if (assignedMintHashes.has(mint.hash)) continue;
            const mintPool = poolOf(mint.chain, mint.hash);
            if (mintPool && mintPool.toLowerCase() === livePool) {
              // Strict match!
              const matchKey = v3LiveMatchKey({
                walletId: l.wallet.id,
                protocolId: live.lp.protocolId,
                chain: live.lp.chain,
                symbols: live.lp.supply.map((s) => s.symbol),
                assetUsd: live.lp.assetUsd,
              });
              out.set(matchKey, mint.hash);
              assignedLiveIdx.add(li);
              assignedMintHashes.add(mint.hash);
              if (typeof window !== "undefined") {
                console.info(
                  `[V3 match] pool-exact ${live.lp.protocolId}|${livePool.slice(0, 10)} → ${mint.hash.slice(0, 10)}`,
                );
              }
              break;
            }
          }
        }
      }

      // Остальные (не сматченные строго) — amount-distance heuristic.
      const remainingLives = lives.filter((_, i) => !assignedLiveIdx.has(i));
      const remainingMintsArr = mints.filter(
        (m) => !assignedMintHashes.has(m.hash),
      );
      const assignment = optimalAssign(remainingLives, remainingMintsArr);
      for (const [liveIdx, mintIdx] of assignment) {
        const lp = remainingLives[liveIdx]!.lp;
        const mintHash = remainingMintsArr[mintIdx]!.hash;
        const matchKey = v3LiveMatchKey({
          walletId: l.wallet.id,
          protocolId: lp.protocolId,
          chain: lp.chain,
          symbols: lp.supply.map((s) => s.symbol),
          assetUsd: lp.assetUsd,
        });
        out.set(matchKey, mintHash);
        assignedMintHashes.add(mintHash);
      }
      // Удаляем сматченные mints из общего пула (для других групп — на случай
      // если два разных pair'а в одной протокол+chain имеют наложение).
      // `assignedMintHashes` уже содержит и pool-exact, и amount-distance
      // matches — единый источник истины.
      const remaining = (mintsByPC.get(liveKey) ?? []).filter(
        (m) => !assignedMintHashes.has(m.hash),
      );
      mintsByPC.set(liveKey, remaining);

      if (typeof window !== "undefined" && (lives.length > 1 || mints.length > 1)) {
        console.info(
          `[V3 match] ${groupKey}: ${lives.length}L ${mints.length}M → ${assignedMintHashes.size} matched (${assignedLiveIdx.size} pool-exact + ${assignment.size} amount-distance)`,
        );
      }
    }
  }

  return out;
}
