/**
 * UCB C3 — cross-wallet transfer/bridge cost basis inheritance.
 *
 * Дополняет fiat_hop_cost_basis (C2): когда user перевёл актив с одного
 * своего wallet'а на другой через прямой transfer / bridge (НЕ через
 * CEX), `transfer_in`/`bridge_in` сторона теряла cost basis trail.
 *
 * Existing A2 `findInternalTransferPairs` matches pairs но НЕ propagate
 * cost basis. D5 покрывает только same-wallet bridge_out → bridge_in.
 *
 * C3 closes the gap: cross-wallet `{transfer_out, bridge_out}` ↔
 * `{transfer_in, bridge_in}` cost basis inheritance.
 *
 * Same-wallet excluded — D5 уже handles same-wallet bridges; same-wallet
 * non-bridge transfers редки/spurious.
 */
import { describe, expect, it } from "vitest";

import { computeCrossWalletCostBasisOverrides } from "./cross_wallet_cost_basis";
import type { ClassifiedOp } from "../types";

function op(args: {
  hash: string;
  type: string;
  time: number;
  chain: string;
  movements: Array<{
    direction: "in" | "out";
    symbol: string;
    amount: number;
    usd?: number | null;
    tokenId?: string;
    isStable?: boolean;
  }>;
}): ClassifiedOp {
  return {
    hash: args.hash,
    type: args.type as never,
    time: args.time,
    chain: args.chain,
    status: "success",
    movement: args.movements.map((m) => ({
      direction: m.direction,
      symbol: m.symbol,
      amount: m.amount,
      usd: m.usd ?? null,
      tokenId: m.tokenId ?? `${m.symbol.toLowerCase()}-${args.chain}`,
      isStable: m.isStable ?? ["USDC", "USDT", "DAI"].includes(m.symbol),
      isProtocolToken: false,
    })),
    protocol: null,
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

describe("computeCrossWalletCostBasisOverrides — UCB C3", () => {
  it("cross-wallet bridge_out → bridge_in inherits cost basis", () => {
    const opsA: ClassifiedOp[] = [
      op({
        hash: "0xbuy_a",
        type: "swap",
        time: 1000,
        chain: "eth",
        movements: [
          { direction: "out", symbol: "USDC", amount: 5000, usd: 5000, isStable: true },
          { direction: "in", symbol: "USDT", amount: 5000, usd: 5000, tokenId: "eth-usdt", isStable: true },
        ],
      }),
      op({
        hash: "0xbridge_out_a",
        type: "bridge_out",
        time: 2000,
        chain: "eth",
        movements: [
          { direction: "out", symbol: "USDT", amount: 5000, usd: 5000, tokenId: "eth-usdt", isStable: true },
        ],
      }),
    ];
    const opsB: ClassifiedOp[] = [
      op({
        hash: "0xbridge_in_b",
        type: "bridge_in",
        time: 3000,
        chain: "arb",
        movements: [
          // m.usd $4950 (slight slippage during bridge)
          { direction: "in", symbol: "USDT", amount: 4950, usd: 4950, tokenId: "arb-usdt", isStable: true },
        ],
      }),
    ];
    const overrides = computeCrossWalletCostBasisOverrides(
      new Map([["wA", opsA], ["wB", opsB]]),
      new Map(),
    );
    expect(overrides.has("0xbridge_in_b")).toBe(true);
    // WAC of USDT on A = $5000/5000 = $1/USDT × 4950 = $4950
    expect(overrides.get("0xbridge_in_b")).toBeCloseTo(4950, 0);
  });

  it("cross-wallet transfer_out → transfer_in (no bridge classifier)", () => {
    const opsA: ClassifiedOp[] = [
      op({
        hash: "0xbuy_a",
        type: "swap",
        time: 1000,
        chain: "eth",
        movements: [
          { direction: "out", symbol: "USDC", amount: 3000, usd: 3000, isStable: true },
          { direction: "in", symbol: "ETH", amount: 1.0, usd: 1500, tokenId: "eth" },
        ],
      }),
      op({
        hash: "0xtout_a",
        type: "transfer_out",
        time: 2000,
        chain: "eth",
        movements: [{ direction: "out", symbol: "ETH", amount: 1.0, usd: 1500, tokenId: "eth" }],
      }),
    ];
    const opsB: ClassifiedOp[] = [
      op({
        hash: "0xtin_b",
        type: "transfer_in",
        time: 3000,
        chain: "eth", // same chain — EOA to EOA transfer
        movements: [{ direction: "in", symbol: "ETH", amount: 1.0, usd: 1500, tokenId: "eth" }],
      }),
    ];
    const overrides = computeCrossWalletCostBasisOverrides(
      new Map([["wA", opsA], ["wB", opsB]]),
      new Map(),
    );
    expect(overrides.has("0xtin_b")).toBe(true);
    // WAC = $3000/1 = $3000 (real cost, not market $1500)
    expect(overrides.get("0xtin_b")).toBeCloseTo(3000, 0);
  });

  it("skip same-wallet pairs (D5 territory)", () => {
    // Same wallet bridge — D5 inside buildLotTrackerFromOps уже handles.
    // C3 не должен пытаться override.
    const ops: ClassifiedOp[] = [
      op({
        hash: "0xbuy",
        type: "swap",
        time: 1000,
        chain: "eth",
        movements: [
          { direction: "out", symbol: "USDC", amount: 5000, usd: 5000, isStable: true },
          { direction: "in", symbol: "USDT", amount: 5000, usd: 5000, tokenId: "eth-usdt", isStable: true },
        ],
      }),
      op({
        hash: "0xbridge_out_same",
        type: "bridge_out",
        time: 2000,
        chain: "eth",
        movements: [
          { direction: "out", symbol: "USDT", amount: 5000, usd: 5000, tokenId: "eth-usdt", isStable: true },
        ],
      }),
      op({
        hash: "0xbridge_in_same",
        type: "bridge_in",
        time: 3000,
        chain: "arb",
        movements: [
          { direction: "in", symbol: "USDT", amount: 4950, usd: 4950, tokenId: "arb-usdt", isStable: true },
        ],
      }),
    ];
    const overrides = computeCrossWalletCostBasisOverrides(
      new Map([["wA", ops]]),
      new Map(),
    );
    // C3 не override same-wallet — D5 handles
    expect(overrides.has("0xbridge_in_same")).toBe(false);
  });

  it("mixed: transfer_out (wallet A) → deposit_fiat (wallet B) inherits", () => {
    // Если classifier помечает один side как transfer_out а другой как
    // deposit_fiat (e.g. адрес отправителя — CEX known, но получатель
    // не классифицирован) — это всё ещё валидный CEX hop, должно inherited.
    const opsA: ClassifiedOp[] = [
      op({
        hash: "0xbuy_a",
        type: "swap",
        time: 1000,
        chain: "eth",
        movements: [
          { direction: "out", symbol: "USDC", amount: 5000, usd: 5000, isStable: true },
          { direction: "in", symbol: "ETH", amount: 1.0, usd: 2000, tokenId: "eth" },
        ],
      }),
      op({
        hash: "0xtout_a",
        type: "transfer_out", // classifier не пометил как withdraw_fiat
        time: 2000,
        chain: "eth",
        movements: [{ direction: "out", symbol: "ETH", amount: 1.0, usd: 2000, tokenId: "eth" }],
      }),
    ];
    const opsB: ClassifiedOp[] = [
      op({
        hash: "0xdep_b",
        type: "deposit_fiat", // classifier пометил destination side
        time: 3000,
        chain: "arb",
        movements: [{ direction: "in", symbol: "ETH", amount: 1.0, usd: 2000, tokenId: "arb" }],
      }),
    ];
    const overrides = computeCrossWalletCostBasisOverrides(
      new Map([["wA", opsA], ["wB", opsB]]),
      new Map(),
    );
    expect(overrides.has("0xdep_b")).toBe(true);
    // WAC $5000/1 = $5000 × 1.0 = $5000
    expect(overrides.get("0xdep_b")).toBeCloseTo(5000, 0);
  });

  it("respects amount tolerance for bridges (±10% stable)", () => {
    // Bridge fees могут быть значительными для stable — допускаем ±10%.
    const opsA: ClassifiedOp[] = [
      op({
        hash: "0xbuy",
        type: "swap",
        time: 1000,
        chain: "eth",
        movements: [
          { direction: "out", symbol: "USDC", amount: 10000, usd: 10000, isStable: true },
          { direction: "in", symbol: "USDT", amount: 10000, usd: 10000, tokenId: "eth-usdt", isStable: true },
        ],
      }),
      op({
        hash: "0xbout",
        type: "bridge_out",
        time: 2000,
        chain: "eth",
        movements: [
          { direction: "out", symbol: "USDT", amount: 10000, usd: 10000, tokenId: "eth-usdt", isStable: true },
        ],
      }),
    ];
    const opsB: ClassifiedOp[] = [
      op({
        hash: "0xbin",
        type: "bridge_in",
        time: 3000,
        chain: "arb",
        movements: [
          // 9100 = 9% loss (within ±10% stable tolerance)
          { direction: "in", symbol: "USDT", amount: 9100, usd: 9100, tokenId: "arb-usdt", isStable: true },
        ],
      }),
    ];
    const overrides = computeCrossWalletCostBasisOverrides(
      new Map([["wA", opsA], ["wB", opsB]]),
      new Map(),
    );
    expect(overrides.has("0xbin")).toBe(true);
    expect(overrides.get("0xbin")).toBeCloseTo(9100, 0); // $1 × 9100
  });

  it("doesn't match across very large time gap (>6h)", () => {
    const opsA: ClassifiedOp[] = [
      op({
        hash: "0xbuy",
        type: "swap",
        time: 1000,
        chain: "eth",
        movements: [
          { direction: "out", symbol: "USDC", amount: 5000, usd: 5000, isStable: true },
          { direction: "in", symbol: "ETH", amount: 1.0, usd: 2000, tokenId: "eth" },
        ],
      }),
      op({
        hash: "0xtout",
        type: "transfer_out",
        time: 1500,
        chain: "eth",
        movements: [{ direction: "out", symbol: "ETH", amount: 1.0, usd: 2000, tokenId: "eth" }],
      }),
    ];
    const opsB: ClassifiedOp[] = [
      op({
        hash: "0xtin",
        type: "transfer_in",
        time: 1500 + 24 * 3600, // 24 hours later
        chain: "arb",
        movements: [{ direction: "in", symbol: "ETH", amount: 1.0, usd: 2000, tokenId: "arb" }],
      }),
    ];
    const overrides = computeCrossWalletCostBasisOverrides(
      new Map([["wA", opsA], ["wB", opsB]]),
      new Map(),
    );
    expect(overrides.has("0xtin")).toBe(false);
  });

  it("prefers nearest-time match when multiple candidates", () => {
    const opsA: ClassifiedOp[] = [
      op({
        hash: "0xbuy",
        type: "swap",
        time: 1000,
        chain: "eth",
        movements: [
          { direction: "out", symbol: "USDC", amount: 5000, usd: 5000, isStable: true },
          { direction: "in", symbol: "ETH", amount: 1.0, usd: 2000, tokenId: "eth" },
        ],
      }),
      op({
        hash: "0xtout_far",
        type: "transfer_out",
        time: 1500, // earlier
        chain: "eth",
        movements: [{ direction: "out", symbol: "ETH", amount: 1.0, usd: 2000, tokenId: "eth" }],
      }),
    ];
    const opsB: ClassifiedOp[] = [
      op({
        hash: "0xtin_close",
        type: "transfer_in",
        time: 1800, // 5min after far, but close
        chain: "arb",
        movements: [{ direction: "in", symbol: "ETH", amount: 1.0, usd: 2000, tokenId: "arb" }],
      }),
    ];
    const overrides = computeCrossWalletCostBasisOverrides(
      new Map([["wA", opsA], ["wB", opsB]]),
      new Map(),
    );
    expect(overrides.has("0xtin_close")).toBe(true);
    expect(overrides.get("0xtin_close")).toBeCloseTo(5000, 0);
  });
});
