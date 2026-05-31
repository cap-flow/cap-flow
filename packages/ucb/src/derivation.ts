/**
 * A3.6 — position DERIVATION builder (knowledge base).
 *
 * Given a position and the wallet's classified ops, extracts the cause-effect
 * chain that yields the position's cost basis FROM the blockchain operations.
 *
 * Two layers, strongest first:
 *
 *   1. ENGINE LOT-TRACE (authoritative) — when an engine context is supplied
 *      we replay `getPositionLotCostBasis` per supplied token and record the
 *      exact lots the engine consumed (FIFO/WAC), each linked back to the
 *      blockchain tx that created it (`sourceHash`). This is the real reason
 *      the number is what it is — it reproduces the position's `startUsd` from
 *      on-chain acquisitions, not a symbol heuristic.
 *
 *   2. OPS HEURISTIC (context) — acquisitions/supplies matched by symbol from
 *      the raw ops. Useful as a human-readable timeline and as a fallback when
 *      no engine context is passed (e.g. server-side reconstruction later).
 *
 * Pure — no I/O. Runs client-side now (the engine runs in the browser); when
 * the server engine lands (B5) it can produce the same derivation server-side.
 */
import type { ClassifiedOp } from "./types.js";
import type { OpenPosition } from "./open_positions.js";
import type { LotMethodology } from "./lots/types.js";
import { getPositionLotCostBasis } from "./position_lot_cost_basis.js";
import { isStableSymbol } from "./protocols.js";

function norm(s: string): string {
  const u = (s ?? "").toUpperCase();
  return u === "WETH" ? "ETH" : u;
}

const ACQUIRE_TYPES = new Set([
  "swap",
  "transfer_in",
  "bridge_in",
  "deposit_fiat",
]);
const SUPPLY_TYPES = new Set(["lend_supply", "lp_add", "stake"]);

export interface DerivationOp {
  time: number;
  date: string;
  type: string;
  hash: string;
  protocol: string | null;
  symbol: string;
  amount: number;
  /** Acquisitions: what was paid (Σ out-movement usd). Supplies: in-position usd. */
  costUsd: number | null;
}

/** One lot consumed by the engine to cover the supplied amount, linked to its
 *  originating blockchain tx so the cause→effect chain is auditable. */
export interface DerivationLot {
  /** Asset of the lot (post-normalization may differ from supplied symbol). */
  symbol: string;
  chain: string | null;
  amount: number;
  costPerUnit: number;
  costUsd: number;
  /** How the lot was acquired (swap / transfer_in / bridge_in / inherited…). */
  acquiredVia: string;
  acquiredAt: number;
  acquiredDate: string;
  /** Blockchain tx that created the lot (the on-chain cause). May be absent for
   *  synthetic / inherited lots. */
  sourceHash: string | null;
  /** Resolved from the wallet ops by `sourceHash` (op type + protocol), when
   *  the creating op is in this wallet's history. */
  opType: string | null;
  opProtocol: string | null;
}

/** Engine lot-trace for a single supplied token — reproduces its `startUsd`. */
export interface DerivationTokenTrace {
  symbol: string;
  methodology: LotMethodology;
  /** Net amount the engine consumed to form cost basis. */
  totalAmountSupplied: number;
  /** Σ lot costUsd — should reconcile with the token's `startUsd`. */
  totalCostUsd: number;
  effectiveWac: number;
  /** Amount the engine could NOT cover from lots (provenance gap → fallback). */
  uncoveredAmount: number;
  lots: DerivationLot[];
}

export interface PositionDerivation {
  schemaVersion: number;
  capturedAtSec: number;
  positionId: string;
  walletId: string;
  chain: string;
  protocol: string;
  startUsd: number;
  netStartUsd: number;
  currentUsd: number;
  /** How much of startUsd came from spot-price fallback (provenance warning). */
  fallbackUsd: number;
  supplyTokens: {
    symbol: string;
    startAmount: number;
    avgBuyPrice: number | null;
    startUsd: number;
    priceSource: string;
  }[];
  /** Authoritative engine lot-trace per supplied token (empty if no engine ctx). */
  tokenTraces: DerivationTokenTrace[];
  acquisitions: DerivationOp[];
  supplies: DerivationOp[];
  /** The cost-basis rule this position exercises (pattern). */
  rule: string;
  /** Did the engine lot-trace fully reproduce the cost basis? */
  engineTraced: boolean;
}

function ymd(timeSec: number): string {
  // op.time is unix seconds.
  return new Date(timeSec * 1000).toISOString().slice(0, 10);
}

/** Optional engine context — when present, the derivation uses the real
 *  lot-trace instead of the symbol heuristic. These are exactly the inputs the
 *  production cost-basis pipeline feeds `getPositionLotCostBasis`. */
export interface DerivationEngineContext {
  /** DefiLlama historical prices keyed as the engine expects. */
  histPrices?: Map<string, number>;
  /** Merged A4/D3/C2/C3/D5 cost-basis overrides by tx hash. */
  costBasisOverrideByHash?: ReadonlyMap<string, number>;
  /** Lot consumption methodology (defaults to WAC for position display). */
  methodology?: LotMethodology;
}

/**
 * @param position the open position being anchored
 * @param ops      the classified ops for the position's wallet
 * @param capturedAtSec unix seconds stamp (pass Date.now()/1000 from caller)
 * @param engine   optional engine context → enables the authoritative lot-trace
 */
export function buildPositionDerivation(
  position: OpenPosition,
  ops: readonly ClassifiedOp[],
  capturedAtSec: number,
  engine?: DerivationEngineContext,
): PositionDerivation {
  // Assets actually put into the position (deposit-side), normalized.
  const targetSymbols = new Set(
    (position.openedInTokens.length > 0
      ? position.openedInTokens.map((t) => t.symbol)
      : position.supplyTokens.map((t) => t.symbol)
    ).map(norm),
  );

  const acquisitions: DerivationOp[] = [];
  const supplies: DerivationOp[] = [];

  for (const op of ops) {
    if (op.status === "failed") continue;
    const protoName = op.protocol?.name ?? null;

    if (ACQUIRE_TYPES.has(op.type)) {
      // IN-movements of a target asset → an acquisition. Cost = Σ out usd
      // (what was paid), which is the real cost basis for a swap.
      const ins = op.movement.filter(
        (m) => m.direction === "in" && targetSymbols.has(norm(m.symbol)),
      );
      if (ins.length === 0) continue;
      const paid = op.movement
        .filter((m) => m.direction === "out")
        .reduce((s, m) => s + (m.usd ?? 0), 0);
      for (const m of ins) {
        acquisitions.push({
          time: op.time,
          date: ymd(op.time),
          type: op.type,
          hash: op.hash,
          protocol: protoName,
          symbol: m.symbol,
          amount: m.amount,
          costUsd: paid > 0 ? paid : (m.usd ?? null),
        });
      }
    } else if (SUPPLY_TYPES.has(op.type)) {
      const outs = op.movement.filter(
        (m) => m.direction === "out" && targetSymbols.has(norm(m.symbol)),
      );
      for (const m of outs) {
        supplies.push({
          time: op.time,
          date: ymd(op.time),
          type: op.type,
          hash: op.hash,
          protocol: protoName,
          symbol: m.symbol,
          amount: m.amount,
          costUsd: m.usd ?? null,
        });
      }
    }
  }

  acquisitions.sort((a, b) => a.time - b.time);
  supplies.sort((a, b) => a.time - b.time);

  // ── ENGINE LOT-TRACE (authoritative) ───────────────────────────────────
  // Index ops by hash so each consumed lot can be linked to the op that
  // created it (the on-chain cause behind the cost basis).
  const opByHash = new Map<string, ClassifiedOp>();
  for (const op of ops) {
    if (op.hash && !opByHash.has(op.hash)) opByHash.set(op.hash, op);
  }

  const tokenTraces: DerivationTokenTrace[] = [];
  if (engine) {
    const methodology = engine.methodology ?? "WAC";
    for (const t of position.supplyTokens) {
      // Stables have trivial $1 cost basis — no lot trace needed.
      if (isStableSymbol(t.symbol)) continue;
      let cb;
      try {
        cb = getPositionLotCostBasis({
          ops: [...ops],
          walletId: position.walletId,
          protocolId: position.protocol.id,
          chain: position.chain,
          symbol: t.symbol,
          currentAmount: t.amount,
          methodology,
          // Match the production startUsd pipeline (open_positions.ts): net
          // supplied amount + merged overrides → reproduces the same number.
          useNetSuppliedAmount: true,
          ...(engine.costBasisOverrideByHash && {
            costBasisOverrideByHash: engine.costBasisOverrideByHash,
          }),
          ...(engine.histPrices && { histPrices: engine.histPrices }),
        });
      } catch {
        continue;
      }
      if (cb.consumedLots.length === 0 && cb.totalAmountSupplied === 0) continue;
      tokenTraces.push({
        symbol: t.symbol,
        methodology: cb.methodology,
        totalAmountSupplied: cb.totalAmountSupplied,
        totalCostUsd: cb.totalCostUsd,
        effectiveWac: cb.effectiveWac,
        uncoveredAmount: cb.uncoveredAmount,
        lots: cb.consumedLots.map((l) => {
          const op = l.sourceHash ? opByHash.get(l.sourceHash) : undefined;
          return {
            symbol: l.symbol ?? t.symbol,
            chain: l.chain ?? null,
            amount: l.amount,
            costPerUnit: l.costPerUnit,
            costUsd: l.costUsd,
            acquiredVia: l.acquiredVia,
            acquiredAt: l.purchaseTime,
            acquiredDate: ymd(l.purchaseTime),
            sourceHash: l.sourceHash ?? null,
            opType: op?.type ?? null,
            opProtocol: op?.protocol?.name ?? null,
          };
        }),
      });
    }
  }

  const fallbackUsd = position.supplyTokens.reduce(
    (s, t) => s + (t.fallbackUsd ?? 0),
    0,
  );
  const currentUsd = position.supplyTokens.reduce(
    (s, t) => s + t.currentUsd,
    0,
  );

  // Engine-traced when every non-stable supplied token produced a lot-trace
  // that the engine fully covered (no provenance gap).
  const nonStableTokens = position.supplyTokens.filter(
    (t) => !isStableSymbol(t.symbol),
  );
  const totalUncovered = tokenTraces.reduce((s, tr) => s + tr.uncoveredAmount, 0);
  const engineTraced =
    !!engine &&
    nonStableTokens.length > 0 &&
    tokenTraces.length >= nonStableTokens.length &&
    totalUncovered <= 1e-9;

  let rule: string;
  if (engineTraced) {
    rule =
      "cost basis lot-traced by the engine: each supplied token's startUsd is the Σ of consumed lots, every lot linked to the blockchain tx (sourceHash) that acquired it — fully reproducible from on-chain ops";
  } else if (engine && tokenTraces.length > 0) {
    rule =
      "cost basis partially lot-traced — some supplied amount was not covered by lots (uncoveredAmount > 0) and fell back to spot/hist price; provenance incomplete";
  } else if (fallbackUsd > 0) {
    rule =
      "cost basis partially from spot-price fallback — provenance incomplete";
  } else {
    rule =
      "cost basis = stablecoin/asset actually paid to acquire the supplied asset (Σ swap out-usd), lot-traced (FIFO/WAC), preserved across the supply chain";
  }

  return {
    schemaVersion: 2,
    capturedAtSec,
    positionId: position.id,
    walletId: position.walletId,
    chain: position.chain,
    protocol: position.protocol.name,
    startUsd: position.startUsd,
    netStartUsd: position.netStartUsd,
    currentUsd,
    fallbackUsd,
    supplyTokens: position.supplyTokens.map((t) => ({
      symbol: t.symbol,
      startAmount: t.startAmount,
      avgBuyPrice: t.avgBuyPrice,
      startUsd: t.startUsd,
      priceSource: t.priceSource,
    })),
    tokenTraces,
    acquisitions,
    supplies,
    rule,
    engineTraced,
  };
}
