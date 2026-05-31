/**
 * UCB C5: pipeline orchestrator — single source of truth для cost-basis
 * compute на клиенте.
 *
 * Сейчас этот flow живёт распределённо: `LoadedWalletsProvider` сам
 * последовательно вызывает `applyAnnotationsToOps` → `buildLotTrackerFromOps`
 * → строит position events через `buildPositionsAndLots` → отдельно зовёт
 * `computeRealizedPnlByFamily` в AssetsPage. Каждое место знает свой кусок,
 * но никто не знает full pipeline. Это плодит ошибки order-dependence:
 *
 *   - D6 reward income не считался бы если бы вызвали realized PnL
 *     до build (lot tracker не знал бы про rewards).
 *   - D8 excluded ops применяются только в build pipeline, но если новый
 *     consumer (e.g. timeline view) забудет applyAnnotationsToOps, баг.
 *
 * C5 вводит **один entry point**:
 *
 *   const result = runUcbPipelineForWallet({
 *     walletId, ops, annotationsByKey,
 *     costBasisOverrideByHash, histPrices
 *   });
 *
 * Внутри — фиксированный порядок шагов с documented invariants. Все
 * downstream-метрики (asset rollup, realized PnL, reward income) читают
 * результат, а не пересчитывают самостоятельно.
 *
 * **Этапы**:
 *   - C5 v1: per-wallet orchestrator (lots, realized, reward income)
 *   - C5.2: cross-wallet aggregator `runUcbPipeline(inputs[])`
 *   - C5.3: AssetsPage переключён на orchestrator (D8 bug fix)
 *   - C5.4: full-path mode (lots + positions через `buildLotsAndPositions`)
 *           + manual annotations merging — `LoadedWalletsProvider.newTrackers`
 *           использует orchestrator вместо собственного compose loop.
 */

import { applyAnnotationsToOps } from "./apply_annotations.js";
import { buildLotTrackerFromOps } from "./lots/build.js";
import type { LotTracker } from "./lots/lot_tracker.js";
import { buildLotsAndPositions } from "./positions/cross_protocol.js";
import type { PositionTracker } from "./positions/position_tracker.js";
import {
  type RealizedPnlEntry,
  type RewardIncomeEntry,
  computeRealizedPnlByFamily,
  computeRewardIncomeByFamily,
} from "./realized_pnl.js";
import type { ClassifiedOp } from "./types.js";
import type { ResolvedAnnotation } from "./annotations.js";

export interface UcbWalletInput {
  /**
   * Идентификатор wallet'а, используемый как key для lot/position trackers.
   * В `LoadedWalletsProvider` это **composite** id вроде
   * `api:<walletUuid>:<addressId>` (frontend conventional). В AssetsPage —
   * raw walletUuid. Не имеет семантики кроме «уникальный handle для этого
   * wallet'а в текущем UCB run».
   */
  readonly walletId: string;
  /**
   * UCB C5.4: walletId, который используется для matching annotations
   * (annotationsByKey + resolvedAnnotations.walletId). Если не задан —
   * defaults to `walletId`. Provider кейс: composite id ≠ annotations UUID,
   * передаём UUID сюда.
   */
  readonly walletIdForAnnotations?: string;
  readonly ops: readonly ClassifiedOp[];
  /**
   * Аннотации user'а, keyed by `${walletId}|${txHash.toLowerCase()}|${logIndex}`.
   * Пустая map — annotations нет, pipeline просто проходит через ops as-is.
   */
  readonly annotationsByKey: ReadonlyMap<string, ResolvedAnnotation>;
  /**
   * Merged cost basis overrides по tx hash:
   *   - server CEX inheritance (`cexCostBasisByHash`, UCB D3)
   *   - manual annotations `manualCostBasisUsd` (UCB A3/A4.2)
   *   - bridge WAC propagation (UCB D5, эти НЕ передаются через эту map —
   *     они computed внутри `buildLotTrackerFromOps` через state).
   *
   * Precedence (manual > server) ожидается merged caller'ом (LoadedWalletsProvider).
   */
  readonly costBasisOverrideByHash?: ReadonlyMap<string, number>;
  /** DefiLlama historical price map (опционально, для accurate cost basis). */
  readonly histPrices?: Map<string, number>;
  /**
   * UCB C5.4: если передан — orchestrator использует
   * `buildLotsAndPositions` (full path) который строит и lots И positions
   * в один pass. Иначе fallback на lots-only path. Нужен `walletNameById`
   * чтобы position events корректно дисплеились с human-friendly именами.
   */
  readonly walletNameById?: Map<string, string>;
  /**
   * UCB C5.4: если передан — orchestrator merge'ит per-wallet manual cost
   * basis annotations (`manualCostBasisUsd`) в `costBasisOverrideByHash` с
   * precedence "manual > server". Раньше эта merge-логика была distributed
   * в `LoadedWalletsProvider`; теперь — single canonical path.
   *
   * Передавай **resolved** annotations (с `walletId` field) — orchestrator
   * сам отфильтрует по своему `walletId`.
   */
  readonly resolvedAnnotations?: readonly ResolvedAnnotation[];
}

export interface UcbWalletResult {
  readonly walletId: string;
  /**
   * Ops ПОСЛЕ применения annotations + soft-delete filtering. Все downstream
   * consumers должны использовать `effectiveOps`, не raw `ops`, чтобы
   * D8 exclusions работали универсально.
   */
  readonly effectiveOps: readonly ClassifiedOp[];
  /** Filled LotTracker готовый к запросам wacAt / consume / getLots. */
  readonly lotTracker: LotTracker;
  /**
   * UCB C5.4: filled PositionTracker — заполнен ТОЛЬКО если caller
   * передал `walletNameById` (full-path mode). Иначе undefined.
   * Содержит position events (lend_supply, lp_add, stake, etc.) с
   * lot consumption references.
   */
  readonly positionTracker?: PositionTracker;
  /** Realized PnL по family (только non-stable → stable / withdraw_fiat sales). */
  readonly realizedPnl: readonly RealizedPnlEntry[];
  /** UCB D6: FMV-at-receipt по family (income from rewards). */
  readonly rewardIncome: readonly RewardIncomeEntry[];
  /** Сколько ops было soft-deleted через D8 annotations (diagnostic). */
  readonly exclusionsCount: number;
}

/**
 * Прогнать UCB pipeline для одного wallet'а.
 *
 * Order invariant (НЕ менять без обновления unit tests):
 *   1. `applyAnnotationsToOps` — manualOpType + D8 exclusions. После этого
 *      `effectiveOps` уже без excluded и с переписанными типами.
 *   2. `buildLotTrackerFromOps` — proceeds-tracking lots с cost basis
 *      overrides (server CEX inheritance + manual + bridge WAC).
 *   3. `computeRealizedPnlByFamily` — отдельный tracker внутри, но ему
 *      передаём те же effectiveOps + overrides для консистентности.
 *   4. `computeRewardIncomeByFamily` — суммирует FMV для reward-type ops.
 *
 * Без `try/catch` — пусть выбрасываются ошибки upstream; presentation
 * layer (LoadedWalletsProvider) уже catch'ит и помечает wallet как
 * `loadError`. Это намеренно: silent fallback'и в orchestrator'е скрывают
 * data-quality bugs.
 */
export function runUcbPipelineForWallet(
  input: UcbWalletInput,
): UcbWalletResult {
  const baseOverrides =
    input.costBasisOverrideByHash ?? new Map<string, number>();
  // UCB C5.4: annotation matching может идти по другому id, чем lot tracker
  // key (provider use case: composite id для трекеров, UUID для annotations).
  const annotationsWalletId =
    input.walletIdForAnnotations ?? input.walletId;

  // Step 1: annotations + D8 soft-delete.
  const effectiveOps = applyAnnotationsToOps(
    input.ops,
    annotationsWalletId,
    input.annotationsByKey,
  );
  const exclusionsCount = input.ops.length - effectiveOps.length;

  // Step 1b (C5.4): merge manual cost basis annotations с server overrides.
  // Precedence: manual annotation > server CEX inheritance > derived.
  const overridesMutable = new Map(baseOverrides);
  if (input.resolvedAnnotations && input.resolvedAnnotations.length > 0) {
    for (const a of input.resolvedAnnotations) {
      if (
        a.walletId === annotationsWalletId &&
        a.manualCostBasisUsd != null &&
        Number.isFinite(a.manualCostBasisUsd) &&
        a.manualCostBasisUsd >= 0
      ) {
        overridesMutable.set(a.txHash.toLowerCase(), a.manualCostBasisUsd);
      }
    }
  }

  // Step 2: lots tracker (+ positions если есть walletNameById).
  let lotTracker: LotTracker;
  let positionTracker: PositionTracker | undefined;

  if (input.walletNameById) {
    // Full path: lots + positions в один pass через cross_protocol.ts.
    const { lots, positions } = buildLotsAndPositions(
      [...effectiveOps],
      input.walletId,
      {
        walletNameById: input.walletNameById,
        histPrices: input.histPrices,
        ...(overridesMutable.size > 0 && {
          costBasisOverrideByHash: overridesMutable,
        }),
      },
    );
    lotTracker = lots;
    positionTracker = positions;
  } else {
    // Lots-only path (lighter, для AssetsPage / realized PnL).
    lotTracker = buildLotTrackerFromOps([...effectiveOps], {
      walletId: input.walletId,
      histPrices: input.histPrices,
      costBasisOverrideByHash: overridesMutable,
    });
  }

  // Step 3: realized PnL (отдельный tracker внутри realized_pnl, но
  // тот же overrides гарантирует консистентность с main lot tracker).
  const realizedPnl = computeRealizedPnlByFamily(
    effectiveOps,
    input.walletId,
    overridesMutable,
  );

  // Step 4: reward income (FMV at receipt — отдельная метрика от realized).
  const rewardIncome = computeRewardIncomeByFamily(effectiveOps);

  return {
    walletId: input.walletId,
    effectiveOps,
    lotTracker,
    ...(positionTracker && { positionTracker }),
    realizedPnl,
    rewardIncome,
    exclusionsCount,
  };
}

// ─── C5.2: cross-wallet aggregation ────────────────────────────────────

/**
 * UCB C5.2: aggregated результат через все wallets user'а.
 *
 * Сумма realized PnL и reward income по family — сейчас живёт распределённо
 * (AssetsPage делает manually loop + Map). Здесь — single computation,
 * консистентная с per-wallet `UcbWalletResult`.
 *
 * Asset rollup (E1) пока остаётся в `buildAssetRollup` потому что он
 * читает live token balances, не ops — другая сторона UCB (current state
 * vs flow). Когда snapshot store объединит обе стороны, перенесём сюда.
 */
export interface UcbAggregatedResult {
  readonly perWallet: ReadonlyMap<string, UcbWalletResult>;
  /** Сумма realized USD по family (cross-wallet). */
  readonly realizedByFamily: ReadonlyMap<
    string,
    { realizedUsd: number; eventCount: number }
  >;
  /** Сумма FMV at receipt по family (cross-wallet). */
  readonly rewardIncomeByFamily: ReadonlyMap<
    string,
    { fmvUsd: number; eventCount: number }
  >;
  /** Σ ops which were soft-deleted (D8) across all wallets. */
  readonly totalExclusions: number;
}

/**
 * Запустить UCB pipeline для нескольких wallets и сагрегировать
 * результаты по family.
 *
 * Каждый вызов независим — wallets не пересекаются по lot trackers
 * (внутри-wallet'ного scope'а). Cross-wallet provenance (e.g.
 * "transfer_out → transfer_in пара") пока обрабатывается через
 * `costBasisOverrideByHash` (CEX D3, manual A4.2, bridge D5).
 */
export function runUcbPipeline(
  inputs: readonly UcbWalletInput[],
): UcbAggregatedResult {
  const perWallet = new Map<string, UcbWalletResult>();
  const realizedByFamily = new Map<
    string,
    { realizedUsd: number; eventCount: number }
  >();
  const rewardIncomeByFamily = new Map<
    string,
    { fmvUsd: number; eventCount: number }
  >();
  let totalExclusions = 0;

  for (const input of inputs) {
    const r = runUcbPipelineForWallet(input);
    perWallet.set(input.walletId, r);
    totalExclusions += r.exclusionsCount;

    for (const e of r.realizedPnl) {
      const cur =
        realizedByFamily.get(e.family) ?? { realizedUsd: 0, eventCount: 0 };
      cur.realizedUsd += e.realizedUsd;
      cur.eventCount += e.eventCount;
      realizedByFamily.set(e.family, cur);
    }

    for (const e of r.rewardIncome) {
      const cur =
        rewardIncomeByFamily.get(e.family) ?? { fmvUsd: 0, eventCount: 0 };
      cur.fmvUsd += e.fmvUsd;
      cur.eventCount += e.eventCount;
      rewardIncomeByFamily.set(e.family, cur);
    }
  }

  return {
    perWallet,
    realizedByFamily,
    rewardIncomeByFamily,
    totalExclusions,
  };
}
