/**
 * UCB C5 Phase E (Task #18) — equivalence verification между двумя
 * параллельными pipeline'ами cost-basis:
 *
 *   - `build.ts:buildLotTrackerFromOps`  (legacy, lots-only, использует тесты)
 *   - `positions/cross_protocol.ts:buildLotsAndPositions`  (canonical, production)
 *
 * Если оба корректны, для одного и того же `ops[]` они должны давать
 * ОДИНАКОВЫЕ `lotTracker.wacAt(walletId, symbol, time)` результаты во всех
 * ключевых сценариях (swap, supply, borrow, self-loop, bridge, claim).
 *
 * Если расходятся → это РЕЦИДИВ паттерна #3 (parallel pipelines диверджат)
 * из anti-recurrence methodology. Тест ловит divergence автоматически.
 *
 * После того как этот тест становится зелёным на всех сценариях:
 *   Phase 3 = drop-in replacement legacy build.ts на `buildLotsAndPositions`
 *   wrapper → удалить build.ts полностью.
 */

import { describe, expect, it } from "vitest";

import { buildLotTrackerFromOps } from "./build";
import { buildLotsAndPositions } from "../positions/cross_protocol";
import type { ClassifiedOp } from "../types";
import type { LotTracker } from "./lot_tracker";

const W = "wallet-equiv-test";

/** Build LotTracker через legacy build.ts pipeline. */
function viaLegacy(ops: ClassifiedOp[]): LotTracker {
  return buildLotTrackerFromOps(ops, { walletId: W, histPrices: new Map() });
}

/** Build LotTracker через canonical cross_protocol.ts pipeline. */
function viaCanonical(ops: ClassifiedOp[]): LotTracker {
  return buildLotsAndPositions(ops, W, {
    histPrices: new Map(),
    walletNameById: new Map([[W, "EquivWallet"]]),
  }).lots;
}

function op(args: {
  hash: string;
  type: string;
  time: number;
  chain?: string;
  protocol?: { id: string; name: string; category: string } | null;
  movements: Array<{
    direction: "in" | "out";
    symbol: string;
    amount: number;
    usd?: number | null;
    tokenId?: string;
    isStable?: boolean;
    isProtocolToken?: boolean;
  }>;
}): ClassifiedOp {
  return {
    hash: args.hash,
    type: args.type as never,
    time: args.time,
    chain: args.chain ?? "arb",
    status: "success",
    movement: args.movements.map((m) => ({
      direction: m.direction,
      symbol: m.symbol,
      amount: m.amount,
      usd: m.usd ?? null,
      tokenId: m.tokenId ?? m.symbol.toLowerCase(),
      isStable: m.isStable ?? ["USDC", "USDT", "DAI"].includes(m.symbol),
      isProtocolToken: m.isProtocolToken ?? false,
    })),
    protocol: args.protocol ?? null,
    netUsd: 0,
    gasUsd: null,
    counterparty: null,
    feePayer: null,
    fnName: null,
    approveSpender: null,
    approveSymbol: null,
    notes: [],
  } as ClassifiedOp;
}

/**
 * Assert that both pipelines compute the same wacAt(symbol, time) value.
 * Tolerance: 1e-6 (FP noise).
 */
function assertWacEquivalent(
  ops: ClassifiedOp[],
  symbol: string,
  time: number,
  label?: string,
) {
  const legacy = viaLegacy(ops).wacAt(W, symbol, time);
  const canonical = viaCanonical(ops).wacAt(W, symbol, time);
  const tag = label ? ` [${label}]` : "";
  if (legacy === null && canonical === null) return;
  if (legacy === null || canonical === null) {
    throw new Error(
      `wacAt(${symbol}, ${time})${tag}: legacy=${legacy} vs canonical=${canonical} (one is null)`,
    );
  }
  expect(canonical, `wacAt(${symbol}, ${time})${tag} divergence`).toBeCloseTo(
    legacy,
    6,
  );
}

describe("dual-pipeline equivalence: lots.build.ts ≡ positions/cross_protocol.ts", () => {
  // ─── Сценарий 1: простой swap ──────────────────────────────────────
  it("swap: USDC → WBTC — обе pipeline дают одинаковый WAC", () => {
    const ops = [
      op({
        hash: "0xswap",
        type: "swap",
        time: 1000,
        movements: [
          { direction: "out", symbol: "USDC", amount: 1000, usd: 1000, isStable: true },
          { direction: "in", symbol: "WBTC", amount: 0.01, usd: 1000 },
        ],
      }),
    ];
    assertWacEquivalent(ops, "WBTC", 2000, "WBTC after swap");
  });

  // ─── Сценарий 2: multi-swap accumulation ───────────────────────────
  it("multi-swap: 3 buys по разным ценам → WAC = average", () => {
    const ops = [
      op({
        hash: "0xb1", type: "swap", time: 1000,
        movements: [
          { direction: "out", symbol: "USDC", amount: 1000, usd: 1000, isStable: true },
          { direction: "in", symbol: "WBTC", amount: 0.01, usd: 1000 },
        ],
      }),
      op({
        hash: "0xb2", type: "swap", time: 2000,
        movements: [
          { direction: "out", symbol: "USDC", amount: 2000, usd: 2000, isStable: true },
          { direction: "in", symbol: "WBTC", amount: 0.02, usd: 2000 },
        ],
      }),
      op({
        hash: "0xb3", type: "swap", time: 3000,
        movements: [
          { direction: "out", symbol: "USDC", amount: 4000, usd: 4000, isStable: true },
          { direction: "in", symbol: "WBTC", amount: 0.04, usd: 4000 },
        ],
      }),
    ];
    assertWacEquivalent(ops, "WBTC", 4000, "WBTC after 3 buys");
  });

  // ─── Сценарий 3: self-loop borrow (C10) ────────────────────────────
  it("UCB C10: self-loop borrow inherits cost basis (Morpho receipt-less)", () => {
    const MORPHO = { id: "arb_morphoblue", name: "Morpho", category: "lending" as const };
    const ops = [
      op({
        hash: "0xbuy", type: "swap", time: 1000,
        movements: [
          { direction: "out", symbol: "USDC", amount: 20000, usd: 20000, isStable: true },
          { direction: "in", symbol: "WBTC", amount: 0.226, usd: 17648 },
        ],
      }),
      op({
        hash: "0xsupply", type: "lend_supply", time: 2000,
        protocol: MORPHO,
        movements: [{ direction: "out", symbol: "WBTC", amount: 0.226, usd: 17648 }],
      }),
      op({
        hash: "0xborrow", type: "borrow", time: 3000,
        protocol: MORPHO,
        movements: [{ direction: "in", symbol: "WBTC", amount: 0.226, usd: 17648 }],
      }),
    ];
    assertWacEquivalent(ops, "WBTC", 4000, "WBTC after self-loop borrow");
  });

  // ─── Сценарий 4: cross-asset borrow → $0 cost ──────────────────────
  it("cross-asset borrow (USDC vs WBTC collateral) → debt не inherits", () => {
    const MORPHO = { id: "arb_morphoblue", name: "Morpho", category: "lending" as const };
    const ops = [
      op({
        hash: "0xbuy", type: "swap", time: 1000,
        movements: [
          { direction: "out", symbol: "ETH", amount: 1, usd: 4000, tokenId: "eth" },
          { direction: "in", symbol: "WBTC", amount: 0.05, usd: 4000 },
        ],
      }),
      op({
        hash: "0xsupply", type: "lend_supply", time: 2000,
        protocol: MORPHO,
        movements: [{ direction: "out", symbol: "WBTC", amount: 0.05, usd: 4000 }],
      }),
      op({
        hash: "0xborrow", type: "borrow", time: 3000,
        protocol: MORPHO,
        movements: [{ direction: "in", symbol: "USDC", amount: 1000, usd: 1000, isStable: true }],
      }),
    ];
    assertWacEquivalent(ops, "USDC", 4000, "USDC borrowed (cross-asset)");
  });

  // ─── Сценарий 5: claim_rewards добавляет lot ───────────────────────
  it("claim_rewards: token in без out → создаётся lot с m.usd", () => {
    const GMX = { id: "arb_gmx_v2", name: "GMX V2", category: "perpetuals" as const };
    const ops = [
      op({
        hash: "0xclaim", type: "claim_rewards", time: 1000,
        protocol: GMX,
        movements: [
          { direction: "in", symbol: "ARB", amount: 10, usd: 8 },
        ],
      }),
    ];
    assertWacEquivalent(ops, "ARB", 2000, "ARB after claim");
  });

  // ─── Сценарий 6: transfer_in без USD → lot с null cost ─────────────
  it("transfer_in без usd → lot с derived/null cost", () => {
    const ops = [
      op({
        hash: "0xtransfer", type: "transfer_in", time: 1000,
        movements: [{ direction: "in", symbol: "ETH", amount: 0.5, usd: 1500 }],
      }),
    ];
    assertWacEquivalent(ops, "ETH", 2000, "ETH after transfer_in");
  });

  // ─── Сценарий 7: bridge_out → bridge_in (D5 cost basis inheritance) ─
  it("bridge_out → bridge_in: cost basis передаётся через chain (UCB D5)", () => {
    const ops = [
      // Buy on arb
      op({
        hash: "0xbuy", type: "swap", time: 1000, chain: "arb",
        movements: [
          { direction: "out", symbol: "USDC", amount: 1000, usd: 1000, isStable: true },
          { direction: "in", symbol: "WETH", amount: 0.3, usd: 1000 },
        ],
      }),
      // Bridge to eth
      op({
        hash: "0xbridge_out", type: "bridge_out", time: 2000, chain: "arb",
        movements: [{ direction: "out", symbol: "WETH", amount: 0.3, usd: 1000 }],
      }),
      op({
        hash: "0xbridge_in", type: "bridge_in", time: 2100, chain: "eth",
        movements: [{ direction: "in", symbol: "WETH", amount: 0.3, usd: 1000 }],
      }),
    ];
    assertWacEquivalent(ops, "WETH", 3000, "WETH after bridge");
  });

  // ─── Сценарий 8: empty ops → null wacAt ────────────────────────────
  it("empty ops: wacAt returns null in both pipelines", () => {
    assertWacEquivalent([], "WBTC", 1000, "empty");
  });
});
