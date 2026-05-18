/**
 * UCB C8: async-deposit cost basis inheritance.
 *
 * Protocols GMX V2 (GM/GLV), Adrena, GMSOL, Flash Trade использует
 * async-deposit pattern:
 *   Tx A: user отправляет USDC/ETH в deposit handler (sends only,
 *         notes ['yield-deposit'])
 *   Tx B: keeper в следующем блоке выдаёт receipt-token (receives
 *         only protocol-token, notes ['yield-deposit-fill'])
 *
 * `async_deposit_linker.ts` pair'ит эти ops через time window (±30s)
 * и notes-match, записывает `linkedCostBasisUsd = Σ outgoing.usd Tx A`
 * на Tx B (mint side).
 *
 * BUG (до C8): consumers (handleSupply, position_lot_cost_basis)
 * НЕ читали `linkedCostBasisUsd` → mint Tx B получала receipt с
 * cost = market m.usd при mint (зачастую сильно недосчёт за счёт
 * GMX fees + waiting period slippage).
 *
 * Example impact (vladimir GLV in Morpho):
 *   - Mint 14,055 GLV market value $17,063 (m.usd at mint)
 *   - Real USDC paid for 4 mints: $21,572
 *   - До C8: GLV lots have cost $17,063 (−26% underestimate)
 *   - После C8: GLV lots have cost $21,572 ✅
 *
 * Fix: handleSupply / handleLpAdd reads `op.linkedCostBasisUsd` first
 * (if set), uses it as authoritative totalCostUsd для receipt acquire.
 */
import { describe, expect, it } from "vitest";

import { buildLotTrackerFromOps } from "./build";
import type { ClassifiedOp } from "../types";

function op(args: {
  hash: string;
  type: string;
  time: number;
  chain?: string;
  protocol?: { id: string; name: string; category: string } | null;
  notes?: string[];
  linkedCostBasisUsd?: number;
  linkedLpTokenId?: string;
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
      isStable: m.isStable ?? ["USDC", "USDT"].includes(m.symbol),
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
    notes: args.notes ?? [],
    linkedCostBasisUsd: args.linkedCostBasisUsd,
    linkedLpTokenId: args.linkedLpTokenId,
  } as unknown as ClassifiedOp;
}

describe("UCB C8: async-deposit linkedCostBasisUsd inheritance", () => {
  const WALLET = "w1";
  const PROTO = { id: "arb_gmx2", name: "GMX V2", category: "yield" as const };

  it("GMX V2 GLV mint inherits real USDC paid (NOT market m.usd)", () => {
    // Vladimir scenario: user buys 1000 USDC for $1000, then GMX V2 deposit:
    //   Tx A: user sends 4700 USDC to GMX handler (no GLV yet)
    //   Tx B: keeper mints 2741 GLV @ market $3328 → user receives
    // Real cost: $4700 USDC paid. Market underestimates by $1372.
    const ops: ClassifiedOp[] = [
      // 1. User buys USDC (имеет stable pool)
      op({
        hash: "0xbuyUsdc",
        type: "swap",
        time: 1000,
        movements: [
          { direction: "out", symbol: "ETH", amount: 1.0, usd: 4700, tokenId: "eth" },
          { direction: "in", symbol: "USDC", amount: 4700, usd: 4700, isStable: true },
        ],
      }),
      // 2. Tx A: deposit (sends only USDC, no receipt yet)
      op({
        hash: "0xdeposit",
        type: "lp_add",
        time: 2000,
        protocol: PROTO,
        notes: ["yield-deposit"],
        movements: [
          { direction: "out", symbol: "USDC", amount: 4700, usd: 4700, isStable: true },
        ],
      }),
      // 3. Tx B: mint (receives only GLV, linked back to Tx A)
      op({
        hash: "0xmint",
        type: "lp_add",
        time: 2005, // +5 seconds
        protocol: PROTO,
        notes: ["yield-deposit-fill"],
        linkedCostBasisUsd: 4700, // ← async-linker wrote this from Tx A out
        linkedLpTokenId: "0xglv",
        movements: [
          // m.usd = $3328 market (underestimates real $4700 paid)
          {
            direction: "in", symbol: "GLV [WETH-USDC]",
            amount: 2740.97, usd: 3328,
            tokenId: "0xglv", isProtocolToken: true,
          },
        ],
      }),
    ];

    const tracker = buildLotTrackerFromOps(ops, {
      walletId: WALLET,
      histPrices: new Map(),
    });

    // GLV lot cost-per-unit should reflect REAL paid USDC ($4700/2741),
    // NOT market m.usd ($3328/2741).
    const glvWac = tracker.wacAt(WALLET, "GLV [WETH-USDC]", 3000);
    expect(glvWac).not.toBeNull();
    // Expected: $4700 / 2740.97 = $1.7147/GLV
    expect(glvWac).toBeCloseTo(4700 / 2740.97, 2);
    // BUG (before C8): market $3328 / 2741 = $1.2143/GLV would be returned
    expect(glvWac).toBeGreaterThan(1.5); // tighter than market
  });

  it("без linkedCostBasisUsd: fallback to market m.usd (no double-error)", () => {
    // Standalone mint без linker pairing — fallback на m.usd.
    const ops: ClassifiedOp[] = [
      op({
        hash: "0xstandalone_mint",
        type: "lp_add",
        time: 1000,
        protocol: PROTO,
        // No notes, no linkedCostBasisUsd
        movements: [
          { direction: "in", symbol: "GLV [WETH-USDC]",
            amount: 1000, usd: 1100,
            tokenId: "0xglv", isProtocolToken: true,
          },
        ],
      }),
    ];

    const tracker = buildLotTrackerFromOps(ops, {
      walletId: WALLET,
      histPrices: new Map(),
    });

    const glvWac = tracker.wacAt(WALLET, "GLV [WETH-USDC]", 2000);
    // Standalone mint defaults to market — that's expected без linker info
    expect(glvWac).toBeCloseTo(1100 / 1000, 2);
  });

  it("multi-mint chain: каждый mint наследует свой linkedCostBasisUsd", () => {
    // Vladimir 4 mints — каждая со своей real cost
    const ops: ClassifiedOp[] = [
      // Acquire USDC pool
      op({
        hash: "0xseed",
        type: "swap",
        time: 100,
        movements: [
          { direction: "out", symbol: "ETH", amount: 10, usd: 30000, tokenId: "eth" },
          { direction: "in", symbol: "USDC", amount: 30000, usd: 30000, isStable: true },
        ],
      }),
      // Mint 1: 4700 USDC → 2741 GLV
      op({ hash: "0xdep1", type: "lp_add", time: 1000, protocol: PROTO, notes: ["yield-deposit"],
        movements: [{ direction: "out", symbol: "USDC", amount: 4700, usd: 4700, isStable: true }] }),
      op({ hash: "0xmint1", type: "lp_add", time: 1005, protocol: PROTO, notes: ["yield-deposit-fill"],
        linkedCostBasisUsd: 4700, linkedLpTokenId: "0xglv",
        movements: [{ direction: "in", symbol: "GLV", amount: 2741, usd: 3328, tokenId: "0xglv", isProtocolToken: true }] }),
      // Mint 2: 8117 USDC → 5015 GLV
      op({ hash: "0xdep2", type: "lp_add", time: 2000, protocol: PROTO, notes: ["yield-deposit"],
        movements: [{ direction: "out", symbol: "USDC", amount: 8117, usd: 8117, isStable: true }] }),
      op({ hash: "0xmint2", type: "lp_add", time: 2005, protocol: PROTO, notes: ["yield-deposit-fill"],
        linkedCostBasisUsd: 8117, linkedLpTokenId: "0xglv",
        movements: [{ direction: "in", symbol: "GLV", amount: 5015, usd: 6088, tokenId: "0xglv", isProtocolToken: true }] }),
    ];

    const tracker = buildLotTrackerFromOps(ops, {
      walletId: WALLET,
      histPrices: new Map(),
    });

    // Total GLV cost basis = 4700 + 8117 = $12,817 for 7756 GLV
    // WAC = $12817 / 7756 = $1.6525/GLV (real cost based)
    const wac = tracker.wacAt(WALLET, "GLV", 3000);
    expect(wac).toBeCloseTo((4700 + 8117) / (2741 + 5015), 2);
    // Market would give: ($3328 + $6088) / 7756 = $1.2138 — WAY LOWER
    expect(wac).toBeGreaterThan(1.5);
  });

  it("linkedCostBasisUsd works для symbol-different mints (e.g. GM vs GLV)", () => {
    // Same vault address но different symbol — mint should still get cost
    const ops: ClassifiedOp[] = [
      op({ hash: "0xseed", type: "swap", time: 100,
        movements: [
          { direction: "out", symbol: "ETH", amount: 5, usd: 15000, tokenId: "eth" },
          { direction: "in", symbol: "USDC", amount: 15000, usd: 15000, isStable: true },
        ] }),
      op({ hash: "0xdep_gm", type: "lp_add", time: 1000, protocol: PROTO, notes: ["yield-deposit"],
        movements: [{ direction: "out", symbol: "USDC", amount: 5000, usd: 5000, isStable: true }] }),
      op({ hash: "0xmint_gm", type: "lp_add", time: 1005, protocol: PROTO, notes: ["yield-deposit-fill"],
        linkedCostBasisUsd: 5000,
        movements: [{ direction: "in", symbol: "GM [BTC]", amount: 4000, usd: 4500, tokenId: "0xgm", isProtocolToken: true }] }),
    ];

    const tracker = buildLotTrackerFromOps(ops, { walletId: WALLET, histPrices: new Map() });
    const wac = tracker.wacAt(WALLET, "GM [BTC]", 2000);
    expect(wac).toBeCloseTo(5000 / 4000, 2); // real cost = $1.25/GM
    // Not market $4500/4000 = $1.125
  });
});
