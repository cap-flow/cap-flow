/**
 * UCB single-source-of-truth pipeline for open positions.
 *
 * Bug fix (2026-05-21): position.startUsd diverged between /positions and
 * /positions/:id for the same position id. Both pages called
 * `buildOpenPositions` with different option sets and only the list page
 * applied the V3/Lending/CEX overrides. UCB principle #2 ("single source
 * of truth") forbids parallel cost-basis pipelines — so the entire chain
 * lives here, behind one hook consumed by every page.
 *
 * Returned `positions` are the post-override list. Page-level user
 * overrides (creditOverrides, positionOverrides, columnPrefs, …) layer
 * on top inside each page and are intentionally NOT applied here.
 */

import { useEffect, useMemo, useState } from "react";

import { useLoadedWallets, type Loaded } from "@/components/data/LoadedWalletsProvider";
import { useIntegrations } from "@/lib/integrations";
import { useCexWithdrawalCostBasis } from "@/features/cex/hooks";
import { useV3Positions } from "@/lib/v3/hook";
import { useV3LiquidityEvents } from "@/lib/v3/use_liquidity_events";
import { useV3HistoricalPoolPrices } from "@/lib/v3/use_historical_prices";
import { useV3CoinGeckoPrices } from "@/lib/coingecko_v3_prices";
import { getV3PoolsForMintBatch } from "@/lib/v3/pool_lookup";
import { useLendingAudit } from "@/lib/lending/use_lending_audit";
import { useResolvedFeatureFlag } from "@/features/feature-flags/hooks";
import {
  isKrystalV3CrossValidationEnabled,
  isLendingAuditEnabled,
} from "@/lib/portfolio/feature_flags";
import { useKrystalV3Positions } from "@/lib/krystal/hook";
import { useKrystalV3Transactions } from "@/lib/krystal/transactions_hook";
import {
  findKrystalDivergences,
  logKrystalDivergences,
} from "@/lib/krystal/validate";
import {
  filterClosedDustPositions,
  useKrystalV3ClosedPools,
} from "@/lib/krystal/closed_pools_hook";
import {
  buildKrystalOpenIndex,
  filterKrystalAbsentV3Phantoms,
} from "@/lib/krystal/phantom_filter";
import { applyKrystalV3Override } from "@/lib/krystal/override";
import {
  useNonLpOpenerDetector,
  type NonLpOpenerTarget,
} from "@/lib/nonlp/use_opener_detector";
import { applyNonLpOpenerOverride } from "@/lib/nonlp/apply_opener_override";
import { useLotMethodology } from "@/lib/lot_methodology";
import { useServerCanonicalQuery } from "@/features/ucb/hooks";
import {
  describeAdoption,
  type AdoptionVerdict,
} from "@/features/ucb/serve-decision";
import { useWalletHistPrices } from "@/lib/portfolio/use_hist_prices";
import { defillamaCoinKey, fetchHistoricalPrices } from "@/lib/defillama";
import {
  buildOpenPositions,
  isV3LpProtocol,
  type OpenPosition,
} from "@/lib/portfolio/open_positions";
import { applyV3CostBasisOverride } from "@/lib/portfolio/v3_cost_basis_override";
import { dedupeMatchedV3TokenIds } from "@/lib/portfolio/v3_dedupe_matched";
import { applyV3ClaimedFeesSplit } from "@/lib/portfolio/v3_claimed_fees_split";
import { applyLendingCostBasisOverride } from "@/lib/portfolio/lending_cost_basis_override";
import { applyCexInheritanceCostBasisOverride } from "@/lib/portfolio/cex_inheritance_cost_basis_override";
import { warnOnProvenanceIssues } from "@/lib/portfolio/position_provenance";
import type { ClassifiedOp } from "@/lib/portfolio/types";
import type { CexCostBasisMatch } from "@/lib/portfolio/position_coverage";
import type { LotMethodology } from "@/lib/portfolio/lots/types";
import type { V3PositionMap } from "@/lib/v3/hook";

export interface ComputedPositions {
  /** Post-override positions — UCB authoritative list. */
  positions: OpenPosition[];
  /** Pre-override positions from `buildOpenPositions`, exposed for diagnostics. */
  positionsRaw: OpenPosition[];
  /** Loaded wallets in load order, shared with consumers that need ops. */
  loadedList: Loaded[];
  /** Ops keyed by wallet id — same map the overrides ran against. */
  opsByWallet: Map<string, ClassifiedOp[]>;
  /** CEX withdrawal cost basis matches keyed by tx-hash (lowercased). */
  cexCostBasisByHash: Map<string, CexCostBasisMatch>;
  /** V3 NFT positions snapshot (per-wallet → V3Position[]). */
  v3PositionMap: V3PositionMap;
  /** Current FIFO/LIFO/WAC selection (persisted in localStorage). */
  lotMethodology: LotMethodology;
  /** Setter for lotMethodology (kept here so the picker can sit on any page). */
  setLotMethodology: (m: LotMethodology) => void;
}

/**
 * Single canonical pipeline. Order is load-bearing:
 *  1. buildOpenPositions(…) — UCB lot tracker (newTrackers.lotsByWallet)
 *     + costBasisOverrideByHash + lendingAuditByKey
 *  2. applyV3CostBasisOverride — Etherscan IncreaseLiquidity + slot0
 *  3. applyLendingCostBasisOverride — FIFO/LIFO/WAC lot consumption
 *  4. applyCexInheritanceCostBasisOverride — server P2P→trade→withdrawal WAC
 */
export function useComputedPositions(): ComputedPositions {
  const { loadedById, costBasisOverrideByHash, newTrackers } =
    useLoadedWallets();
  const [integrations] = useIntegrations();
  const alchemyKey = (integrations.alchemyApiKey ?? "").trim();
  const etherscanKey = (integrations.etherscanApiKey ?? "").trim();

  const loadedList = useMemo(
    () => Object.values(loadedById).sort((a, b) => a.loadedAt - b.loadedAt),
    [loadedById],
  );

  const cexCostBasisQ = useCexWithdrawalCostBasis();
  const cexCostBasisByHash = useMemo(() => {
    const m = new Map<string, CexCostBasisMatch>();
    for (const c of cexCostBasisQ.data ?? []) {
      m.set(c.txHash.toLowerCase(), {
        costBasisUsd: c.costBasisUsd,
        source: c.source,
        asset: c.asset,
      });
    }
    return m;
  }, [cexCostBasisQ.data]);

  const v3 = useV3Positions(loadedList, alchemyKey);
  const v3PositionsFlat = useMemo(() => {
    const out: import("@/lib/v3/positions").V3Position[] = [];
    for (const arr of v3.data.values()) for (const p of arr) out.push(p);
    return out;
  }, [v3.data]);
  // PR-K11 (2026-05-25): Krystal V3 primary mode теперь always-on (был за
  // feature flag, но это давало per-browser inconsistency — fees зависели от
  // localStorage конкретного браузера). Cross-validation (debug warnings)
  // остаётся за флагом для dev/diagnostic режима.
  // API key инжектится server-side через upstream-proxy
  // (см. `apps/api/.../upstream-proxy.service.ts` — `KRYSTAL_API_KEY`).
  // NOTE: useKrystalV3Positions запускается раньше useV3LiquidityEvents
  // чтобы передать `openedTime` lookup → enable BASE chain Alchemy chunked
  // fetch с правильным fromBlock (2026-05-27 follow-up к VolnyySanya fix).
  const krystalV3 = useKrystalV3Positions(loadedList, true);
  const krystalOpenedTimeByTokenId = useMemo<Map<string, number | null>>(() => {
    const m = new Map<string, number | null>();
    for (const [tokenId, s] of krystalV3.data) {
      m.set(tokenId, s.openedTime);
    }
    return m;
  }, [krystalV3.data]);
  const v3CostBasisHook = useV3LiquidityEvents(
    v3PositionsFlat,
    alchemyKey,
    etherscanKey,
    krystalOpenedTimeByTokenId,
  );
  const v3MintPoolPrices = useV3HistoricalPoolPrices(loadedList, alchemyKey);
  const v3MintCgPrices = useV3CoinGeckoPrices(loadedList);

  // PR-K23 (2026-05-27 VolnyySanya audit): Krystal `/v1/positions/{chainId}/
  // {nft}/transactions` endpoint = authoritative per-tx fee claim history.
  // Заменяет UCB+PR-2 split полностью. Один вызов на каждую V3 LP позицию,
  // cache 24h. Используется в applyKrystalV3Override чтобы populate
  // `feesClaimedHistory` + `feesClaimedUsd`.
  const krystalTxTargets = useMemo(() => {
    const out: { chainId: number; npmAddress: string; tokenId: string }[] = [];
    const CHAIN_TO_ID: Record<string, number> = {
      eth: 1, arb: 42161, op: 10, matic: 137, base: 8453, bsc: 56, avax: 43114, ron: 2020,
    };
    for (const [tokenId, summary] of krystalV3.data) {
      const chainId = CHAIN_TO_ID[summary.chainCode.toLowerCase()];
      if (chainId == null || !summary.npmAddress) continue;
      out.push({ chainId, npmAddress: summary.npmAddress, tokenId });
    }
    return out;
  }, [krystalV3.data]);
  const krystalTxHook = useKrystalV3Transactions(krystalTxTargets, true);

  // 2026-05-28 (Option B' MMaksimuk POS-046 audit): отдельный hook на
  // CLOSED Krystal позиции — нужен чтобы отфильтровать dust-фантомы
  // от закрытых NFT'ов которые DeBank ещё показывает (residual $0.5-$5).
  // Полностью fail-soft: ошибка fetch'а → пустой Set → фильтр no-op.
  const krystalClosedHook = useKrystalV3ClosedPools(loadedList, true);

  const lendingAuditHook = useLendingAudit(loadedList, alchemyKey, etherscanKey);
  const lendingAuditFlag = useResolvedFeatureFlag(
    "capflow.feature.lendingAudit",
  );
  const lendingAuditOn = lendingAuditFlag.enabled || isLendingAuditEnabled();

  // Cross-validation (debug warnings) остаётся за флагом для dev/diagnostic
  // режима. (Сам `krystalV3` fetch вынесен наверх — см. выше.)
  const krystalFlag = useResolvedFeatureFlag(
    "capflow.feature.krystalV3CrossValidation",
  );
  const krystalCrossValidate =
    krystalFlag.enabled || isKrystalV3CrossValidationEnabled();
  const krystalPrimary = true;

  const walletHistPrices = useWalletHistPrices(loadedList);
  const [lotMethodology, setLotMethodology] = useLotMethodology();

  // DefiLlama: historical USD for OUT-tokens of V3 lp_add ops. Narrower than
  // useWalletHistPrices because buildOpenPositions only needs V3-specific
  // prices here — broader prices feed the lending override below.
  const [v3LpHistPrices, setV3LpHistPrices] = useState<Map<string, number>>(
    new Map(),
  );

  const v3LpHistRequests = useMemo(() => {
    const items: { coin: string; timestamp: number }[] = [];
    const seen = new Set<string>();
    for (const l of loadedList) {
      if (!l.live) continue;
      const v3Protos = new Set(
        l.live.positions
          .filter((p) => isV3LpProtocol(p.protocolName))
          .map((p) => p.protocolId),
      );
      if (v3Protos.size === 0) continue;
      for (const op of l.ops) {
        if (op.status === "failed") continue;
        if (op.type !== "lp_add") continue;
        if (!op.protocol || !v3Protos.has(op.protocol.id)) continue;
        for (const m of op.movement) {
          if (m.direction !== "out" || m.amount <= 0) continue;
          const coin = defillamaCoinKey(op.chain, m.tokenId, m.symbol);
          if (!coin) continue;
          const key = `${coin}|${Math.floor(op.time / 3600)}`;
          if (seen.has(key)) continue;
          seen.add(key);
          items.push({ coin, timestamp: op.time });
        }
      }
    }
    return items;
  }, [loadedList]);

  useEffect(() => {
    if (v3LpHistRequests.length === 0) {
      setV3LpHistPrices(new Map());
      return;
    }
    let cancelled = false;
    const ctrl = new AbortController();
    void fetchHistoricalPrices(v3LpHistRequests, ctrl.signal)
      .then((m) => {
        if (!cancelled) setV3LpHistPrices(m);
      })
      .catch((err: unknown) => {
        if (!cancelled) console.warn("useComputedPositions: v3 hist fetch failed", err);
      });
    return () => {
      cancelled = true;
      ctrl.abort();
    };
  }, [v3LpHistRequests]);

  // P1: pool-address resolver для V3 lp_add ops. Используется в
  // matchV3LiveToMints для точного 1:1 матчинга live↔mint когда у
  // юзера несколько NFT в разных fee tiers того же pair'а (POS-007/008
  // PAXG/USDC bug). Кешируется в localStorage между загрузками.
  const v3LpAddTxHashes = useMemo(() => {
    const items: { chain: string; txHash: string }[] = [];
    const seen = new Set<string>();
    for (const l of loadedList) {
      if (!l.live) continue;
      const hasV3 = l.live.positions.some((p) =>
        isV3LpProtocol(p.protocolName),
      );
      if (!hasV3) continue;
      for (const op of l.ops) {
        if (op.status === "failed") continue;
        if (op.type !== "lp_add") continue;
        if (!op.protocol) continue;
        const key = `${op.chain}|${op.hash.toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        items.push({ chain: op.chain, txHash: op.hash });
      }
    }
    return items;
  }, [loadedList]);

  const [v3PoolByTxHash, setV3PoolByTxHash] = useState<
    ReadonlyMap<string, string | null>
  >(new Map());

  useEffect(() => {
    if (v3LpAddTxHashes.length === 0 || !alchemyKey) {
      setV3PoolByTxHash(new Map());
      return;
    }
    let cancelled = false;
    void getV3PoolsForMintBatch(v3LpAddTxHashes, alchemyKey)
      .then((m) => {
        if (!cancelled) setV3PoolByTxHash(m);
      })
      .catch((err: unknown) => {
        if (!cancelled)
          console.warn("useComputedPositions: v3 pool lookup failed", err);
      });
    return () => {
      cancelled = true;
    };
  }, [v3LpAddTxHashes, alchemyKey]);

  const positionsRaw = useMemo(() => {
    const result = buildOpenPositions(
      loadedList.map((l) => ({
        wallet: l.wallet,
        ops: l.ops,
        ...(l.live !== undefined && { live: l.live }),
      })),
      {
        histPrices: v3LpHistPrices,
        v3MintPoolPrices: v3MintPoolPrices.data,
        v3MintCgPrices: v3MintCgPrices.data,
        v3PoolByTxHash,
        costBasisOverrideByHash,
        lotsByWallet: newTrackers.lotsByWallet,
        // Lot: FIFO/LIFO/WAC toggle → non-stable supply-token cost basis
        // (lending/yield). LP startUsd идёт из Krystal (methodology-independent).
        methodology: lotMethodology,
        ...(lendingAuditOn && {
          lendingAuditByKey: lendingAuditHook.data,
        }),
      },
    );
    const opsByWalletId = new Map(
      loadedList.map((l) => [l.wallet.id, l.ops as readonly typeof l.ops[number][]]),
    );
    warnOnProvenanceIssues(result, opsByWalletId);
    return result;
  }, [
    loadedList,
    v3LpHistPrices,
    v3MintPoolPrices.data,
    v3MintCgPrices.data,
    v3PoolByTxHash,
    costBasisOverrideByHash,
    newTrackers.lotsByWallet,
    lendingAuditHook.data,
    lendingAuditOn,
    lotMethodology,
  ]);

  // opsByWallet — reused by the lending override and exposed to callers
  // (PositionDetailPage uses it for provenance tables).
  const opsByWallet = useMemo(() => {
    const m = new Map<string, ClassifiedOp[]>();
    for (const l of loadedList) m.set(l.wallet.id, l.ops);
    return m;
  }, [loadedList]);

  // 2026-05-28 (MMaksimuk no-date audit): Non-LP opener detector. Для
  // позиций без openedAt (Lending/Yield/Staked/Locked/Deposit/Farming) —
  // достаём дату открытия через первый receipt-token IN transfer на
  // Etherscan. Чинит случаи где DeBank не отдал open op (Gnosis Safe,
  // mint-from-0, за горизонтом истории). Только non-V3-LP (V3 → Krystal).
  const nonLpOpenerTargets = useMemo<NonLpOpenerTarget[]>(() => {
    const walletAddrById = new Map<string, string>();
    for (const l of loadedList) {
      if (l.wallet.chain === "evm") walletAddrById.set(l.wallet.id, l.wallet.address);
    }
    const out: NonLpOpenerTarget[] = [];
    for (const p of positionsRaw) {
      // Stage 2c: НЕ фильтруем по openedAt — OUT-side cost basis нужен и для
      // позиций С датой (GMX V2 GLV имеет UCB-дату, но wrong startUsd). Date
      // override остаётся conditional (openedAt==null) внутри override-функции.
      if (isV3LpProtocol(p.protocol.name)) continue;
      if (!p.lpTokenId) continue;
      const wallet = walletAddrById.get(p.walletId);
      if (!wallet) continue;
      out.push({
        positionId: p.id,
        chainCode: p.chain,
        receiptToken: p.lpTokenId,
        wallet,
      });
    }
    return out;
  }, [positionsRaw, loadedList]);
  const nonLpOpener = useNonLpOpenerDetector(nonLpOpenerTargets, true);

  // B6 slice 2: server-canonical positions (per-user flag, default OFF).
  const serverCanonical = useServerCanonicalQuery();

  const clientPositions = useMemo(() => {
    let working: OpenPosition[] = positionsRaw.slice();
    if (v3CostBasisHook.data.size > 0 && v3.data.size > 0) {
      const v3Result = applyV3CostBasisOverride(
        working,
        v3.data,
        v3CostBasisHook.data,
      );
      working = v3Result.positions;
      if (v3Result.overriddenCount > 0) {
        for (const w of v3Result.warnings) console.warn(w);
      }
    }
    const lendingResult = applyLendingCostBasisOverride(
      working,
      opsByWallet,
      walletHistPrices.histPrices,
      lotMethodology,
      costBasisOverrideByHash,
    );
    if (lendingResult.overriddenCount > 0) {
      for (const w of lendingResult.warnings) console.warn(w);
    }
    working = lendingResult.positions;
    if (cexCostBasisByHash.size > 0) {
      const cexResult = applyCexInheritanceCostBasisOverride(
        working,
        opsByWallet,
        cexCostBasisByHash,
        walletHistPrices.histPrices,
      );
      if (cexResult.overriddenCount > 0) {
        for (const w of cexResult.warnings) console.warn(w);
      }
      working = cexResult.positions;
    }
    // PR-2 (2026-05-25): split inflated claim_rewards для V3 LP через
    // DecreaseLiquidity events. Решает баг #1 classifier'а где
    // multicall(decreaseLiquidity, collect) метится как claim целиком —
    // principal portion inflated claimed (lex POS-007 \$701 principal listed
    // как fee). Если Krystal primary ON и data есть → step 5 ниже перепишет.
    // Если Krystal OFF / token нет в Krystal → этот fix остаётся authoritative.
    if (v3CostBasisHook.data.size > 0 && v3.data.size > 0) {
      working = applyV3ClaimedFeesSplit(working, v3.data, v3CostBasisHook.data);
    }

    // PR-K29 (MMaksimuk POS-019/020 audit): post-process dedup —
    // если 2+ V3 LP позиции получили один и тот же matchedV3TokenId
    // (artifact of v3_cost_basis_override Phase 1/1.5 ambiguity между
    // nearly-identical NFT'ами в одном пуле), реассайним extras на
    // sibling NFT'ы из Krystal Map. Pure function, no-op если sibling'ов
    // нет. Применимо для любого юзера с 2+ NFT в одном V3 пуле.
    if (krystalV3.data.size > 0) {
      const dedupResult = dedupeMatchedV3TokenIds(working, krystalV3.data);
      if (dedupResult.reassignedCount > 0) {
        for (const w of dedupResult.warnings) console.warn(w);
      }
      working = dedupResult.positions;
    }

    // PR-K3: Krystal primary mode → override V3 current state + fees
    // ПЕРЕД cross-validation (иначе divergences будут zero — мы сами
    // только что синхронизировали). Cost-basis side НЕ трогается.
    if (krystalPrimary && krystalV3.data.size > 0) {
      // walletAddressById нужен для pair-match fallback (Base chain где
      // Etherscan v2 unsupported / Alchemy 403 — matchedV3TokenId не
      // выставляется обычным путём, но Krystal данные есть).
      const walletAddressById = new Map<string, string>();
      for (const l of loadedList) {
        if (l.wallet.chain === "evm") {
          walletAddressById.set(l.wallet.id, l.wallet.address);
        }
      }
      working = applyKrystalV3Override(
        working,
        krystalV3.data,
        walletAddressById,
        krystalTxHook.data,
      );
    }
    // PR-K2: cross-validation log. В primary режиме diff'ы должны быть
    // ~0 (мы только что overrride'нули). В CV-only режиме покажет где
    // наш движок врёт.
    if (krystalCrossValidate && krystalV3.data.size > 0) {
      const divergences = findKrystalDivergences(working, krystalV3.data);
      logKrystalDivergences(divergences);
    }
    // PR-K27 (Option B' MMaksimuk POS-046): filter V3 LP dust phantoms —
    // позиции в пулах где Krystal знает что NFT уже CLOSED (liquidity=0)
    // но DeBank продолжает показывать $0.5-$5 residual. Защитные guards
    // (isV3LpProtocol AND no matchedV3TokenId AND lpTokenId set AND
    // currentUsd < $50) гарантируют что мы не скроем активные позиции.
    if (krystalClosedHook.closedKeys.size > 0) {
      const walletAddressById = new Map<string, string>();
      for (const l of loadedList) {
        if (l.wallet.chain === "evm") {
          walletAddressById.set(l.wallet.id, l.wallet.address);
        }
      }
      working = filterClosedDustPositions(
        working,
        walletAddressById,
        krystalClosedHook.closedKeys,
        isV3LpProtocol,
      );
    }
    // 2026-06-01 (MMaksimuk phantom audit): Krystal-absent phantom filter.
    // Catches BOTH (a) closed-residual dust the flaky CLOSED-fetch above missed
    // and (b) DeBank-only positions Krystal never indexed — by using the PRIMARY
    // (open) Krystal set as the reliable signal. Drops only no-NFT, small,
    // covered-chain V3 LP positions Krystal doesn't list open for that wallet;
    // gauge-staked CL (has matchedV3TokenId) and Krystal-listed positions are
    // kept. Fail-soft when Krystal returned nothing.
    if (krystalV3.data.size > 0) {
      const walletAddressById = new Map<string, string>();
      for (const l of loadedList) {
        if (l.wallet.chain === "evm") {
          walletAddressById.set(l.wallet.id, l.wallet.address);
        }
      }
      const phantomResult = filterKrystalAbsentV3Phantoms(
        working,
        walletAddressById,
        buildKrystalOpenIndex(krystalV3.data.values()),
        isV3LpProtocol,
      );
      for (const d of phantomResult.dropped) {
        console.log(
          `[Krystal phantom filter] dropping ${d.protocol.name} ${d.chain} ` +
            `pool ${d.lpTokenId} ($${d.currentUsd.toFixed(2)}) — no NFT, not in Krystal open`,
        );
      }
      working = phantomResult.positions;
    }
    // 2026-05-28 (MMaksimuk no-date audit, Stage 1): Non-LP opener override.
    // Проставляет openedAt / ageDays / APR для не-LP позиций без даты,
    // используя Etherscan-detected дату первого receipt transfer. Guards
    // внутри: только openedAt==null, только non-V3-LP. startUsd НЕ трогаем.
    if (nonLpOpener.data.size > 0) {
      const walletAddressById = new Map<string, string>();
      for (const l of loadedList) {
        if (l.wallet.chain === "evm") {
          walletAddressById.set(l.wallet.id, l.wallet.address);
        }
      }
      const openerResult = applyNonLpOpenerOverride(
        working,
        nonLpOpener.data,
        walletAddressById,
      );
      if (openerResult.overriddenCount > 0) {
        for (const w of openerResult.warnings) console.warn(w);
      }
      working = openerResult.positions;
    }
    return working;
  }, [
    positionsRaw,
    v3.data,
    v3CostBasisHook.data,
    opsByWallet,
    walletHistPrices.histPrices,
    lotMethodology,
    costBasisOverrideByHash,
    cexCostBasisByHash,
    krystalCrossValidate,
    krystalPrimary,
    krystalV3.data,
    krystalTxHook.data,
    krystalClosedHook.closedKeys,
    nonLpOpener.data,
    loadedList,
  ]);

  // B6 slice 2: adopt server-canonical positions when the flag is ON and every
  // guard passes (server fresh+serve, methodology-match, wallet-set match, and a
  // runtime shape check guarding the cast); otherwise keep the client recompute
  // as the PERMANENT fallback (R16). The public `positions` shape is unchanged →
  // zero downstream page churn.
  // ⚠ FIDELITY: the server pipeline (ucb.service.ts) does NOT yet apply every
  // override this client chain does — slot0 V3 cost basis, V3 claimed-fees split,
  // dust/phantom filters and the non-LP opener are B3-full/B4 (deferred). So
  // adopted positions can lack those fields until those stages land. This is
  // safe because the FLIP (enabling the flag) is gated on the shadow-diff showing
  // parity on those fields first (M5) — adoption code does not re-detect it.
  // Один вердикт адопции: источник (server|client) + причина. Используется и
  // для выбора массива, и для UI-бейджа «расчёт: сервер / браузер (почему)»,
  // чтобы клиентский fallback перестал быть тихим.
  const adoption = useMemo<AdoptionVerdict>(
    () =>
      describeAdoption({
        flagEnabled: serverCanonical.flagEnabled,
        resp: serverCanonical.data ?? null,
        clientLotMethodology: lotMethodology,
        clientPositions,
      }),
    [serverCanonical.flagEnabled, serverCanonical.data, lotMethodology, clientPositions],
  );

  const positions = useMemo<OpenPosition[]>(() => {
    if (adoption.source === "server" && serverCanonical.data?.positions) {
      return serverCanonical.data.positions as OpenPosition[];
    }
    return clientPositions;
  }, [adoption.source, serverCanonical.data, clientPositions]);

  // ── A3.2 dev-only golden capture ──────────────────────────────────────
  // Publish the EXACT assembled ReplayInput pieces the pipeline just consumed
  // to `window.__capflowGolden`, so the fixture-export tooling can freeze a
  // marked position's inputs and the offline harness replays them byte-for-
  // byte (parity = same inputs → same number). DEV-only, zero prod surface.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    (window as unknown as { __capflowGolden?: unknown }).__capflowGolden = {
      wallets: loadedList.map((l) => ({
        wallet: l.wallet,
        ops: l.ops,
        live: l.live ?? null,
      })),
      histPrices: Array.from(walletHistPrices.histPrices.entries()),
      costBasisOverrideByHash: Array.from(costBasisOverrideByHash.entries()),
      lotMethodology,
      nonLpOpenerByKey: Array.from(nonLpOpener.data.entries()),
      cexCostBasisByHash: Array.from(cexCostBasisByHash.entries()),
      // V3 override inputs (raw — contain bigints; tagged at capture time).
      v3PositionMap: Array.from(v3.data.entries()),
      v3CostBasis: Array.from(v3CostBasisHook.data.entries()),
      // Krystal V3 (authoritative LP startUsd) — plain JSON, no bigints.
      krystalV3ByTokenId: Array.from(krystalV3.data.entries()),
      krystalTxByTokenId: Array.from(krystalTxHook.data.entries()),
      positions: positions.map((p) => ({
        id: p.id,
        chain: p.chain,
        protocolId: p.protocol.id,
        protocolName: p.protocol.name,
        lpTokenId: p.lpTokenId ?? null,
        matchedV3TokenId: p.matchedV3TokenId ?? null,
        openHash: p.openHash ?? null,
        walletId: p.walletId,
        startUsd: p.startUsd,
        netStartUsd: p.netStartUsd,
        currentUsd: p.currentUsd,
        netPnlUsd: p.netPnlUsd,
        coverageIncomplete: p.coverageIncomplete ?? false,
        supplyTokens: (p.supplyTokens ?? []).map((t) => ({
          symbol: t.symbol,
          amount: t.amount,
          startUsd: t.startUsd,
          currentUsd: t.currentUsd,
          avgBuyPrice: t.avgBuyPrice,
          priceSource: t.priceSource,
          fallbackUsd: t.fallbackUsd,
        })),
      })),
    };
  }, [
    loadedList,
    walletHistPrices.histPrices,
    costBasisOverrideByHash,
    lotMethodology,
    nonLpOpener.data,
    cexCostBasisByHash,
    v3.data,
    v3CostBasisHook.data,
    krystalV3.data,
    krystalTxHook.data,
    positions,
  ]);

  return {
    positions,
    /** Источник показанных позиций (server|client) + причина — для UI-бейджа. */
    positionsSource: adoption.source,
    positionsServeReason: adoption.reason,
    positionsRaw,
    loadedList,
    opsByWallet,
    cexCostBasisByHash,
    v3PositionMap: v3.data,
    lotMethodology,
    setLotMethodology,
    /**
     * V3 cost basis fetch state. `true` пока useV3LiquidityEvents
     * фетчит Etherscan IncreaseLiquidity events для всех V3 NFT'ов.
     *
     * Когда `true`: ещё не известно, какие V3 позиции — orphan
     * (mint не найден в chain-ops) vs нет. UI должен показывать
     * spinner/«Загрузка…» вместо confident ⚠ badge, чтобы не
     * пугать нового пользователя fake'овым «cost basis incomplete»
     * который через 2-3s исчезнет сам.
     *
     * На subsequent visits (cached в localStorage) `loading=false`
     * сразу с первого render'а.
     */
    v3CostBasisLoading: v3CostBasisHook.loading,
  };
}
