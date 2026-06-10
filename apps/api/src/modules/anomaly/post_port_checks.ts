/**
 * Epic C post-port checks (phase "post") — run over the SERVER's canonical
 * positions (`ucb_shadow_results`, now that B5/B3-full/B4 land) instead of the
 * legacy snapshot metrics. The strongest signal is `golden_case_drift`: every
 * golden_cases oracle is automatically re-verified against the live server
 * compute, turning the curated anchors into a continuous regression gate.
 *
 * Pure functions over already-loaded rows (no DB/IO) — the detector service
 * loads canonical positions + golden cases and feeds them here.
 */
import type { AnomalyFinding } from "./checks.js";
import type { ShadowDiffSummary } from "../ucb/shadow-diff.js";

/** Minimal canonical-position view (subset of OpenPosition from ucb_shadow_results). */
export interface CanonicalPosition {
  id: string;
  walletId: string;
  chain: string;
  protocol: { id: string };
  lpTokenId?: string | null;
  matchedV3TokenId?: string | null;
  openHash?: string | null;
  startUsd: number;
  currentUsd: number;
  netPnlUsd: number;
  /** cross_protocol PositionTracker cost basis (SoT) — для tracker_divergence.
   *  Проставляется computePositions только для lending; null/absent иначе. */
  costBasisTrackerUsd?: number | null;
  coverageIncomplete?: boolean;
  /** Annualized fee APR по lifetime (Krystal/engine); null когда не считается. */
  feeAprLifetime?: number | null;
  /** Σ pending+claimed fees (база для APR). */
  feesLifetimeUsd?: number;
  /** Per-supply-token провенанс cost basis (для pricing/fallback чеков). */
  supplyTokens?: {
    symbol: string;
    isStable: boolean;
    avgBuyPrice: number | null;
    startUsd: number;
    /** M6 priced-not-trusted доля (оценка по цене входа) — НЕ silent-spot, легитимна. */
    fallbackUsd?: number;
    /** 'cost_basis' (реальные траты/lot) | 'fallback' (silent m.usd current-spot — anti-pattern #1). */
    priceSource?: string;
  }[];
}

/** Minimal golden-case view (numbers already parsed from numeric). */
export interface GoldenCaseView {
  id: string;
  walletId: string;
  chain: string;
  protocolId: string;
  marketKey: string | null;
  openHash: string | null;
  label: string;
  /** 'golden' = expected is the correct value; 'wrong' = owner-flagged bad. */
  kind: string;
  status: string;
  expectedStartUsd: number | null;
  toleranceAbsUsd: number;
  tolerancePct: number;
}

export const POST_PORT_THRESHOLDS = {
  /** lp_uncovered_nearzero: startUsd ~0 but the position holds real value. */
  nearZeroStartUsd: 1,
  nearZeroCurrentUsdFloor: 100,
  /** pnl_impossible_negative slack (leverage adds real noise). */
  pnlImpossibleNegSlackPct: 0.01,
  /** stable_avgprice_off: на сколько avgBuyPrice стейбла может отойти от $1. */
  stableAvgPriceTolerance: 0.05,
  /** cost_basis_from_spot: абсолютный пол fallback-доли cost basis ($). */
  costBasisFallbackFloorUsd: 100,
  /** cost_basis_from_spot: доля cost basis из спота, выше которой шумим. */
  costBasisFallbackPct: 0.5,
  /** fee_apr_without_fee: ниже этого |fee| считаем нулём. */
  feeNoiseUsd: 0.01,
  /** fee_apr_without_fee: APR ниже этого (%, lifetime) — флоат-пыль, не флагуем. */
  feeAprNoiseFloorPct: 0.1,
  /** client_server_cost_basis_divergence: |delta| ≥ этого ($) → error (иначе warn). */
  divergenceErrorFloorUsd: 50,
  /** client_server_cost_basis_divergence: |delta|/server ≥ этого → error. */
  divergenceErrorPct: 0.05,
  /** tracker_divergence: ниже обоих порогов (|Δ| и |Δ|/ref) — шум, не флагуем. */
  trackerDivergenceFloorUsd: 50,
  trackerDivergencePct: 0.02,
} as const;

function eqKey(a: string | null | undefined, b: string | null | undefined): boolean {
  if (a == null || b == null) return false;
  return a.toLowerCase() === b.toLowerCase();
}

/** Match a golden case to its canonical position (per-wallet; mirrors verify scripts). */
export function matchCanonical(
  g: GoldenCaseView,
  positions: readonly CanonicalPosition[],
): CanonicalPosition | undefined {
  return positions.find((p) => {
    if (p.walletId !== g.walletId) return false;
    if (p.chain !== g.chain || p.protocol.id !== g.protocolId) return false;
    if (g.marketKey) {
      const mkOk =
        eqKey(p.matchedV3TokenId, g.marketKey) || eqKey(p.lpTokenId, g.marketKey);
      if (!mkOk) return false;
      // 2026-06-10 (testakk Fluid): два инстанса одного рынка (ETH-vault и
      // WBTC-vault делят lpTokenId 0x324c…) — marketKey-only матч брал первый
      // попавшийся → WBTC-golden дрейфовал против ETH-позиции. Если у эталона
      // есть openHash — он обязан совпасть.
      if (g.openHash) return eqKey(p.openHash, g.openHash);
      return true;
    }
    if (g.openHash) return eqKey(p.openHash, g.openHash);
    return true; // chain+protocol only (rare; e.g. single-position protocol)
  });
}

function withinTolerance(
  computed: number,
  expected: number,
  absTol: number,
  pctTol: number,
): boolean {
  const diff = Math.abs(computed - expected);
  const tol = Math.max(absTol, Math.abs(expected) * pctTol);
  return diff <= tol;
}

/**
 * `golden_case_drift` (error) — for each active golden ('golden') case, the
 * matching canonical startUsd must be within tolerance of the expected value.
 * Beyond → error carrying goldenCaseId + driftPct. No matching position →
 * `golden_case_unmatched` (warn): the server compute didn't produce it at all.
 */
export function checkGoldenCaseDrift(
  goldenCases: readonly GoldenCaseView[],
  positions: readonly CanonicalPosition[],
): AnomalyFinding[] {
  const out: AnomalyFinding[] = [];
  for (const g of goldenCases) {
    if (g.status !== "active") continue;
    if (g.kind !== "golden") continue; // 'wrong' handled by a separate signal
    if (g.expectedStartUsd == null) continue; // flag-only golden, nothing to drift
    const p = matchCanonical(g, positions);
    if (!p) {
      out.push({
        checkId: "golden_case_unmatched",
        anomalyType: "golden",
        severity: "warn",
        phase: "post",
        observedValue: null,
        expectedValue: g.expectedStartUsd,
        goldenCaseId: g.id,
        walletId: g.walletId,
        chain: g.chain,
        protocolId: g.protocolId,
        marketKey: g.marketKey,
        detail: {
          reason: `golden ${g.label} has no matching canonical position (server compute missing it)`,
          label: g.label,
        },
      });
      continue;
    }
    if (withinTolerance(p.startUsd, g.expectedStartUsd, g.toleranceAbsUsd, g.tolerancePct)) {
      continue;
    }
    const driftAbs = p.startUsd - g.expectedStartUsd;
    const driftPct = g.expectedStartUsd !== 0 ? (driftAbs / Math.abs(g.expectedStartUsd)) * 100 : null;
    out.push({
      checkId: "golden_case_drift",
      anomalyType: "golden",
      severity: "error",
      phase: "post",
      observedValue: p.startUsd,
      expectedValue: g.expectedStartUsd,
      goldenCaseId: g.id,
      positionId: p.id,
      walletId: g.walletId,
      chain: g.chain,
      protocolId: g.protocolId,
      marketKey: g.marketKey,
      detail: {
        reason: `canonical startUsd $${p.startUsd.toFixed(2)} drifts from golden ${g.label} $${g.expectedStartUsd.toFixed(2)}`,
        label: g.label,
        driftAbs,
        driftPct,
        toleranceAbsUsd: g.toleranceAbsUsd,
        tolerancePct: g.tolerancePct,
      },
    });
  }
  return out;
}

/**
 * Canonical-position invariants (no golden needed):
 *   - `lp_uncovered_nearzero` (error): startUsd ~$0 but currentUsd is real money
 *     AND not honestly flagged coverageIncomplete (the POS-011 plausible-fake).
 *   - `pnl_impossible_negative` (error): lost more than the collateral cost basis.
 */
export function checkCanonicalInvariants(
  positions: readonly CanonicalPosition[],
): AnomalyFinding[] {
  const out: AnomalyFinding[] = [];
  for (const p of positions) {
    if (
      p.startUsd < POST_PORT_THRESHOLDS.nearZeroStartUsd &&
      p.currentUsd > POST_PORT_THRESHOLDS.nearZeroCurrentUsdFloor &&
      !p.coverageIncomplete
    ) {
      out.push({
        checkId: "lp_uncovered_nearzero",
        anomalyType: "cost_basis",
        severity: "error",
        phase: "post",
        observedValue: p.startUsd,
        expectedValue: null,
        positionId: p.id,
        walletId: p.walletId,
        chain: p.chain,
        protocolId: p.protocol.id,
        marketKey: p.lpTokenId ?? p.matchedV3TokenId ?? null,
        detail: {
          reason: `startUsd ~$0 but currentUsd $${p.currentUsd.toFixed(2)} — cost basis missing (not flagged coverageIncomplete)`,
          currentUsd: p.currentUsd,
        },
      });
    }
    if (
      p.startUsd > 0 &&
      p.netPnlUsd < -p.startUsd * (1 + POST_PORT_THRESHOLDS.pnlImpossibleNegSlackPct)
    ) {
      out.push({
        checkId: "pnl_impossible_negative",
        anomalyType: "pnl",
        severity: "error",
        phase: "post",
        observedValue: p.netPnlUsd,
        expectedValue: -p.startUsd,
        positionId: p.id,
        walletId: p.walletId,
        chain: p.chain,
        protocolId: p.protocol.id,
        marketKey: p.lpTokenId ?? p.matchedV3TokenId ?? null,
        detail: {
          reason: `netPnlUsd $${p.netPnlUsd.toFixed(2)} is more negative than the cost basis −$${p.startUsd.toFixed(2)}`,
          startUsd: p.startUsd,
        },
      });
    }
  }
  return out;
}

function marketKeyOf(p: CanonicalPosition): string | null {
  return p.lpTokenId ?? p.matchedV3TokenId ?? null;
}

/**
 * `fee_apr_without_fee` (error) — feeApr > 0, но накопленных fee ≈ $0. APR
 * начислен на пустую базу: классический симптом stale Krystal lp.rewards
 * (инцидент POS-004/005), когда APR-override приходит без реальных комиссий.
 */
export function checkFeeAprWithoutFee(
  positions: readonly CanonicalPosition[],
): AnomalyFinding[] {
  const out: AnomalyFinding[] = [];
  for (const p of positions) {
    if (p.feeAprLifetime == null) continue;
    // APR должен быть осмысленным (не флоат-пыль ~1e-13): иначе false-positive на
    // позициях без комиссий (Alice POS-002 Morpho PT: feeApr=8.7e-13, fees=4.2e-13).
    if (Math.abs(p.feeAprLifetime) < POST_PORT_THRESHOLDS.feeAprNoiseFloorPct) continue;
    if (Math.abs(p.feesLifetimeUsd ?? 0) >= POST_PORT_THRESHOLDS.feeNoiseUsd) continue;
    out.push({
      checkId: "fee_apr_without_fee",
      anomalyType: "lp_data",
      severity: "error",
      phase: "post",
      observedValue: p.feeAprLifetime,
      expectedValue: 0,
      positionId: p.id,
      walletId: p.walletId,
      chain: p.chain,
      protocolId: p.protocol.id,
      marketKey: marketKeyOf(p),
      detail: {
        reason:
          "feeApr > 0, но fee ≈ $0 — APR начислен на пустую базу (инцидент POS-004/005: stale Krystal)",
        feesLifetimeUsd: p.feesLifetimeUsd ?? 0,
      },
    });
  }
  return out;
}

/**
 * `stable_avgprice_off` (info) — у стейбл-токена avgBuyPrice заметно отошёл от
 * $1. EUR-стейблы (EURC/agEUR…) законно котируются не по доллару, поэтому это
 * информационный сигнал на ручной разбор, а не ошибка. Один finding на позицию
 * с detail.tokens = [{symbol, avgBuyPrice}] (idempotency-ключ схлопнул бы токены).
 */
export function checkStableAvgpriceOff(
  positions: readonly CanonicalPosition[],
): AnomalyFinding[] {
  const out: AnomalyFinding[] = [];
  for (const p of positions) {
    const off: { symbol: string; avgBuyPrice: number }[] = [];
    for (const t of p.supplyTokens ?? []) {
      if (!t.isStable) continue;
      if (t.avgBuyPrice == null) continue;
      if (Math.abs(t.avgBuyPrice - 1) <= POST_PORT_THRESHOLDS.stableAvgPriceTolerance) continue;
      off.push({ symbol: t.symbol, avgBuyPrice: t.avgBuyPrice });
    }
    if (off.length === 0) continue;
    out.push({
      checkId: "stable_avgprice_off",
      anomalyType: "pricing",
      severity: "info",
      phase: "post",
      observedValue: off[0]!.avgBuyPrice,
      expectedValue: 1,
      positionId: p.id,
      walletId: p.walletId,
      chain: p.chain,
      protocolId: p.protocol.id,
      marketKey: marketKeyOf(p),
      detail: {
        reason: `стейбл ${off.map((o) => o.symbol).join(", ")} имеет avgBuyPrice ≠ $1 (откл. > ${POST_PORT_THRESHOLDS.stableAvgPriceTolerance}); EUR-стейблы законно отклоняются — потому info, не error`,
        tokens: off,
      },
    });
  }
  return out;
}

/**
 * `cost_basis_from_spot` (warn) — заметная доля cost basis выведена из текущего
 * спота (silent `m.usd` fallback, anti-pattern #1), а не из реальных трат.
 *
 * Сигнал = per-token `priceSource === 'fallback'` (движок ЯВНО пометил, что у
 * токена не было ни lot-cost, ни hist-цены → взял current spot). НЕ используем
 * `fallbackUsd`: это M6 «priced-not-trusted» доля (оценка по цене ВХОДА —
 * легитимна и помечена; для декомпозированных receipt/LP токенов она > 0, хотя
 * cost basis корректен — это давало ложные срабатывания на Alice).
 *
 * Триггер: Σ startUsd токенов с priceSource='fallback' > $100 ЛИБО > 50% startUsd.
 */
export function checkCostBasisFromSpot(
  positions: readonly CanonicalPosition[],
): AnomalyFinding[] {
  const out: AnomalyFinding[] = [];
  for (const p of positions) {
    const spotTokens = (p.supplyTokens ?? []).filter(
      (t) => t.priceSource === "fallback",
    );
    if (spotTokens.length === 0) continue;
    const spotTotal = spotTokens.reduce((sum, t) => sum + (t.startUsd ?? 0), 0);
    if (spotTotal <= 0) continue;
    const overFloor = spotTotal > POST_PORT_THRESHOLDS.costBasisFallbackFloorUsd;
    const overPct =
      p.startUsd > 0 && spotTotal / p.startUsd > POST_PORT_THRESHOLDS.costBasisFallbackPct;
    if (!overFloor && !overPct) continue;
    out.push({
      checkId: "cost_basis_from_spot",
      anomalyType: "cost_basis",
      severity: "warn",
      phase: "post",
      observedValue: spotTotal,
      expectedValue: 0,
      positionId: p.id,
      walletId: p.walletId,
      chain: p.chain,
      protocolId: p.protocol.id,
      marketKey: marketKeyOf(p),
      detail: {
        reason: `cost basis $${spotTotal.toFixed(2)} (${spotTokens.map((t) => t.symbol).join(",")}) взят из текущего спота (priceSource=fallback), а не из реальных трат — провенанс неполон`,
        spotTotal,
        startUsd: p.startUsd,
        spotSymbols: spotTokens.map((t) => t.symbol),
      },
    });
  }
  return out;
}

/**
 * `client_server_cost_basis_divergence` — клиент и сервер посчитали РАЗНЫЙ cost
 * basis для одной позиции (по `ucb_shadow_results.diff_summary`, который пишет
 * B5 shadow-diff при POST клиентских позиций). Это ловит класс багов, который
 * server-only чеки пропускают: движок один (`@cap-flow/ucb`), но клиент кормит
 * его НЕПОЛНЫМ набором ops (server-hydrated/cached историю минует обогащение),
 * → linkedCostBasisUsd не проставлен → cost basis рушится в receipt-spot.
 *
 * Канонический инцидент POS-011 (testakk GLV→Morpho): client $15,209 vs server
 * $21,588 → deltaStartUsd −$6,379. До фикса (commit e3120f5) этот чек поднял бы
 * error. После фикса diff = 0 → молчит. Идемпотентный регресс-гейт на дрейф
 * клиент↔сервер по всем юзерам, как только shadow-diff прогоняется в проде.
 *
 * Severity: error при |delta| ≥ $50 ИЛИ ≥ 5% server-значения; иначе warn.
 * Учитывает и startUsd (gross), и netStartUsd (collateral − debt, для плеча).
 * presence-mismatch (client_only/server_only) — НЕ здесь: это структурная
 * нестыковка набора позиций (часто V3-enrichment), отдельный сигнал.
 */
export function checkClientServerDivergence(
  summary: ShadowDiffSummary | null | undefined,
): AnomalyFinding[] {
  if (!summary?.deltas?.length) return [];
  const out: AnomalyFinding[] = [];
  for (const d of summary.deltas) {
    if (d.presence !== "both" || !d.divergent) continue;
    // Берём наибольшее по модулю расхождение из gross/net (оба важны для плеча).
    const candidates = [d.deltaStartUsd, d.deltaNetStartUsd].filter(
      (v): v is number => typeof v === "number" && Number.isFinite(v),
    );
    if (candidates.length === 0) continue;
    const delta = candidates.reduce((a, b) => (Math.abs(b) > Math.abs(a) ? b : a), 0);
    if (Math.abs(delta) <= summary.thresholdUsd) continue;
    const serverRef = Math.abs(d.serverStartUsd ?? 0);
    const overFloor = Math.abs(delta) >= POST_PORT_THRESHOLDS.divergenceErrorFloorUsd;
    const overPct =
      serverRef > 0 && Math.abs(delta) / serverRef >= POST_PORT_THRESHOLDS.divergenceErrorPct;
    const severity: AnomalyFinding["severity"] = overFloor || overPct ? "error" : "warn";
    // key = chain|protocolId|lpTokenId|matchedV3TokenId|firstSupplySymbol
    const [chain = "", protocolId = "", lpTokenId = "", v3 = ""] = d.key.split("|");
    const marketKey = v3 || lpTokenId || null;
    out.push({
      checkId: "client_server_cost_basis_divergence",
      anomalyType: "cost_basis",
      severity,
      phase: "post",
      observedValue: d.clientStartUsd,
      expectedValue: d.serverStartUsd,
      // walletId не входит в composite-ключ diff'а (keyOf) → опускаем.
      ...(chain ? { chain } : {}),
      ...(protocolId ? { protocolId } : {}),
      marketKey,
      detail: {
        reason: `client cost basis $${(d.clientStartUsd ?? 0).toFixed(2)} ≠ server $${(d.serverStartUsd ?? 0).toFixed(2)} (Δ $${delta.toFixed(2)}) — клиент кормит движок неполным набором ops (POS-011 класс)`,
        key: d.key,
        deltaStartUsd: d.deltaStartUsd,
        deltaNetStartUsd: d.deltaNetStartUsd,
        reasons: d.reasons,
      },
    });
  }
  return out;
}

/**
 * `tracker_divergence` — display `startUsd` (buildSupplyToken / lending-override
 * path) разошёлся с cross_protocol PositionTracker (SoT, поле
 * `costBasisTrackerUsd`). Это ПРЯМОЙ детект класса параллельных трекеров: на
 * aida POS-001 (token→token) display падал в market-спот ($513), а SoT держал
 * уплаченное ($719) → Δ $206. Не зависит от priceSource/«?» — ловит даже когда
 * баг даёт уверенно-неверное значение.
 *
 * Поле проставляется `computePositions` ТОЛЬКО для lending (lot-traced, без
 * внешнего Krystal/V3-override) → без ложных срабатываний на LP. На старых
 * shadow-строках без поля чек молчит.
 *
 * Severity: error при |Δ| ≥ $50 ИЛИ ≥ 5% от max(startUsd, tracker); иначе warn.
 */
export function checkTrackerDivergence(
  positions: readonly CanonicalPosition[],
): AnomalyFinding[] {
  const out: AnomalyFinding[] = [];

  // 2026-06-10 (testakk Fluid): сравнение НА УРОВНЕ АКТИВА. SoT-сторона
  // (costBasisTrackerUsd) теперь = сумма всех корзин трекера по
  // (wallet, protocol, asset) — см. ucb.service. Симметрично display-сторона
  // группируется по тому же ключу: два волта одного актива сравниваются как
  // Σ display vs SoT, а не каждый против общей суммы (иначе оба бы флагались).
  interface Group {
    positions: CanonicalPosition[];
    displaySum: number;
    trackerUsd: number;
  }
  const groups = new Map<string, Group>();
  for (const p of positions) {
    const tracker = p.costBasisTrackerUsd;
    if (tracker == null || !Number.isFinite(tracker)) continue;
    const assetKey = p.supplyTokens?.[0]?.symbol?.toUpperCase() ?? "?";
    const key = `${p.walletId}|${p.protocol.id}|${p.chain}|${assetKey}`;
    let g = groups.get(key);
    if (!g) {
      g = { positions: [], displaySum: 0, trackerUsd: tracker };
      groups.set(key, g);
    }
    g.positions.push(p);
    g.displaySum += p.startUsd;
    // costBasisTrackerUsd идентичен внутри группы (asset-level сумма) —
    // берём максимум на случай старых shadow-строк со значением первой корзины.
    g.trackerUsd = Math.max(g.trackerUsd, tracker);
  }

  for (const g of groups.values()) {
    const diff = Math.abs(g.displaySum - g.trackerUsd);
    const ref = Math.max(Math.abs(g.displaySum), Math.abs(g.trackerUsd));
    if (ref <= 0) continue;
    const overFloor = diff >= POST_PORT_THRESHOLDS.trackerDivergenceFloorUsd;
    const overPct = diff / ref >= POST_PORT_THRESHOLDS.trackerDivergencePct;
    if (!overFloor && !overPct) continue;
    const severity: AnomalyFinding["severity"] =
      diff >= POST_PORT_THRESHOLDS.divergenceErrorFloorUsd ||
      diff / ref >= POST_PORT_THRESHOLDS.divergenceErrorPct
        ? "error"
        : "warn";
    // Флаг вешаем на крупнейшую позицию группы (стабильный якорь для upsert).
    const anchor = [...g.positions].sort((a, b) => b.startUsd - a.startUsd)[0]!;
    out.push({
      checkId: "tracker_divergence",
      anomalyType: "cost_basis",
      severity,
      phase: "post",
      observedValue: g.displaySum,
      expectedValue: g.trackerUsd,
      positionId: anchor.id,
      walletId: anchor.walletId,
      chain: anchor.chain,
      protocolId: anchor.protocol.id,
      marketKey: marketKeyOf(anchor),
      detail: {
        reason: `display startUsd Σ$${g.displaySum.toFixed(2)} (${g.positions.length} поз.) расходится с cross_protocol SoT $${g.trackerUsd.toFixed(2)} (Δ $${diff.toFixed(2)}) — параллельный трекер разошёлся (класс aida token→token)`,
        startUsd: g.displaySum,
        costBasisTrackerUsd: g.trackerUsd,
        deltaUsd: g.displaySum - g.trackerUsd,
        groupSize: g.positions.length,
      },
    });
  }
  return out;
}

/** All post-port checks over canonical positions + golden cases. */
export function runPostPortChecks(
  positions: readonly CanonicalPosition[],
  goldenCases: readonly GoldenCaseView[],
): AnomalyFinding[] {
  return [
    ...checkGoldenCaseDrift(goldenCases, positions),
    ...checkCanonicalInvariants(positions),
    ...checkFeeAprWithoutFee(positions),
    ...checkStableAvgpriceOff(positions),
    ...checkCostBasisFromSpot(positions),
    ...checkTrackerDivergence(positions),
  ];
}
