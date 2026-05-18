/**
 * UCB C2 (CEX-loop cost basis inheritance): TDD test для
 * `computeFiatHopCostBasisOverrides`.
 *
 * Сценарий: user покупает ETH на eth chain (cowswap 9646 USDC → 2.149 ETH
 * @ $4488/ETH), переводит на CEX (`withdraw_fiat`), потом возвращает на
 * arb chain (`deposit_fiat` 2.165 ETH через ~30 минут — CEX дал чуть
 * больше за счёт market making spread / yield). Реальный cost basis
 * новых 2.165 ETH = $4488/ETH (или близко с учётом fees), НЕ market
 * price на момент arb deposit.
 *
 * Это **same-wallet** случай (один UUID, разные chains), поэтому
 * существующий `findInternalTransferPairs` не матчит (он skip'аeт
 * same-wallet). Нужен отдельный детектор для CEX-loop pairs.
 *
 * UCB invariant: cost basis flows through CEX hops — actual paid amount
 * наследуется от source чрез CEX hop, не теряется на market m.usd.
 */
import { describe, expect, it } from "vitest";

import { computeFiatHopCostBasisOverrides } from "./fiat_hop_cost_basis";
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
      isStable: m.isStable ?? ["USDC", "USDT", "DAI", "USD₮0"].includes(m.symbol),
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

describe("computeFiatHopCostBasisOverrides — CEX-loop cost basis inheritance", () => {
  const WALLET = "w1";

  it("Vladimir POS-002 base case: withdraw_fiat (eth) → deposit_fiat (arb) same wallet", () => {
    // Реальная история via.irk Aug 12 2025:
    //   09:17 (eth)  swap 9646 USDC → 2.149 ETH (cost = $9646, WAC $4488/ETH)
    //   09:24 (eth)  withdraw_fiat -2.163 ETH (to CEX)
    //   09:45 (arb)  deposit_fiat  +2.165 ETH (from CEX)
    //
    // Expected: deposit_fiat должен получить cost basis ≈ WAC ($4488)
    //           × inAmount (2.165) = ~$9716. НЕ market $2114 × 2.165 = $4577.
    const ops: ClassifiedOp[] = [
      op({
        hash: "0xswap_eth",
        type: "swap",
        time: 1000,
        chain: "eth",
        movements: [
          { direction: "out", symbol: "USDC", amount: 9646, usd: 9646, isStable: true },
          { direction: "in", symbol: "ETH", amount: 2.149, usd: 4544, tokenId: "eth" },
        ],
      }),
      op({
        hash: "0xwithdraw_eth",
        type: "withdraw_fiat",
        time: 1420, // +7 min
        chain: "eth",
        movements: [
          { direction: "out", symbol: "ETH", amount: 2.163, usd: 4573, tokenId: "eth" },
        ],
      }),
      op({
        hash: "0xdeposit_arb",
        type: "deposit_fiat",
        time: 2680, // +21 min
        chain: "arb",
        movements: [
          // m.usd = market $2114 × 2.165 = $4578 (WRONG cost basis if used)
          { direction: "in", symbol: "ETH", amount: 2.165, usd: 4578, tokenId: "arb" },
        ],
      }),
    ];

    const opsByWallet = new Map([[WALLET, ops]]);
    const overrides = computeFiatHopCostBasisOverrides(opsByWallet, new Map());

    expect(overrides.has("0xdeposit_arb")).toBe(true);
    const cost = overrides.get("0xdeposit_arb")!;
    // Expected: WAC ($9646/2.149 = $4488.6) × 2.165 = ~$9718
    expect(cost).toBeGreaterThan(9500);
    expect(cost).toBeLessThan(9900);
  });

  it("cross-wallet case: withdraw_fiat (wallet A eth) → deposit_fiat (wallet B arb)", () => {
    const opsA: ClassifiedOp[] = [
      op({
        hash: "0xswap_a",
        type: "swap",
        time: 1000,
        chain: "eth",
        movements: [
          { direction: "out", symbol: "USDC", amount: 5000, usd: 5000, isStable: true },
          { direction: "in", symbol: "ETH", amount: 1.0, usd: 2500, tokenId: "eth" },
        ],
      }),
      op({
        hash: "0xwithdraw_a",
        type: "withdraw_fiat",
        time: 1500,
        chain: "eth",
        movements: [
          { direction: "out", symbol: "ETH", amount: 1.0, usd: 2500, tokenId: "eth" },
        ],
      }),
    ];
    const opsB: ClassifiedOp[] = [
      op({
        hash: "0xdeposit_b",
        type: "deposit_fiat",
        time: 2500,
        chain: "arb",
        movements: [
          { direction: "in", symbol: "ETH", amount: 1.0, usd: 2500, tokenId: "arb" },
        ],
      }),
    ];

    const opsByWallet = new Map([
      ["wA", opsA],
      ["wB", opsB],
    ]);
    const overrides = computeFiatHopCostBasisOverrides(opsByWallet, new Map());

    expect(overrides.has("0xdeposit_b")).toBe(true);
    // WAC = $5000/1.0 = $5000/ETH × 1.0 inAmount = $5000
    expect(overrides.get("0xdeposit_b")).toBeCloseTo(5000, 1);
  });

  it("не матчит withdraw без соответствующего deposit (вне окна по времени)", () => {
    const ops: ClassifiedOp[] = [
      op({
        hash: "0xswap_eth",
        type: "swap",
        time: 1000,
        chain: "eth",
        movements: [
          { direction: "out", symbol: "USDC", amount: 5000, usd: 5000, isStable: true },
          { direction: "in", symbol: "ETH", amount: 1.0, usd: 2500, tokenId: "eth" },
        ],
      }),
      op({
        hash: "0xwithdraw_eth",
        type: "withdraw_fiat",
        time: 1000,
        chain: "eth",
        movements: [{ direction: "out", symbol: "ETH", amount: 1.0, usd: 2500, tokenId: "eth" }],
      }),
      op({
        hash: "0xdeposit_arb",
        type: "deposit_fiat",
        time: 1000 + 86400 * 7, // 7 days later, beyond ±6h window
        chain: "arb",
        movements: [{ direction: "in", symbol: "ETH", amount: 1.0, usd: 2500, tokenId: "arb" }],
      }),
    ];
    const overrides = computeFiatHopCostBasisOverrides(
      new Map([["w1", ops]]),
      new Map(),
    );
    expect(overrides.has("0xdeposit_arb")).toBe(false);
  });

  it("не матчит при несовпадении amount tolerance (>5% для volatile)", () => {
    const ops: ClassifiedOp[] = [
      op({
        hash: "0xswap",
        type: "swap",
        time: 1000,
        chain: "eth",
        movements: [
          { direction: "out", symbol: "USDC", amount: 5000, usd: 5000, isStable: true },
          { direction: "in", symbol: "ETH", amount: 1.0, usd: 2500, tokenId: "eth" },
        ],
      }),
      op({
        hash: "0xwithdraw",
        type: "withdraw_fiat",
        time: 1500,
        chain: "eth",
        movements: [{ direction: "out", symbol: "ETH", amount: 1.0, usd: 2500, tokenId: "eth" }],
      }),
      op({
        // 1.5 ETH in vs 1.0 ETH out — 50% off, definitely not the same money
        hash: "0xdeposit_mismatch",
        type: "deposit_fiat",
        time: 2500,
        chain: "arb",
        movements: [{ direction: "in", symbol: "ETH", amount: 1.5, usd: 3750, tokenId: "arb" }],
      }),
    ];
    const overrides = computeFiatHopCostBasisOverrides(
      new Map([["w1", ops]]),
      new Map(),
    );
    expect(overrides.has("0xdeposit_mismatch")).toBe(false);
  });

  it("одна withdraw_fiat матчится с одним deposit_fiat — не дублируется", () => {
    // Если есть два deposit_fiat с одинаковой суммой, withdraw должен
    // привязаться только к ближайшему по времени.
    const ops: ClassifiedOp[] = [
      op({
        hash: "0xswap",
        type: "swap",
        time: 1000,
        chain: "eth",
        movements: [
          { direction: "out", symbol: "USDC", amount: 5000, usd: 5000, isStable: true },
          { direction: "in", symbol: "ETH", amount: 1.0, usd: 2500, tokenId: "eth" },
        ],
      }),
      op({
        hash: "0xwithdraw",
        type: "withdraw_fiat",
        time: 1500,
        chain: "eth",
        movements: [{ direction: "out", symbol: "ETH", amount: 1.0, usd: 2500, tokenId: "eth" }],
      }),
      op({
        hash: "0xdeposit1_close",
        type: "deposit_fiat",
        time: 2500, // closer match
        chain: "arb",
        movements: [{ direction: "in", symbol: "ETH", amount: 1.0, usd: 2500, tokenId: "arb" }],
      }),
      op({
        hash: "0xdeposit2_far",
        type: "deposit_fiat",
        time: 1500 + 86400, // 24h later
        chain: "arb",
        movements: [{ direction: "in", symbol: "ETH", amount: 1.0, usd: 2500, tokenId: "arb" }],
      }),
    ];
    const overrides = computeFiatHopCostBasisOverrides(
      new Map([["w1", ops]]),
      new Map(),
    );
    // Closer one gets the override, far one doesn't
    expect(overrides.has("0xdeposit1_close")).toBe(true);
    expect(overrides.has("0xdeposit2_far")).toBe(false);
  });

  it("WETH → ETH family normalisation (через CEX deposit/withdraw)", () => {
    const ops: ClassifiedOp[] = [
      op({
        hash: "0xswap_weth",
        type: "swap",
        time: 1000,
        chain: "eth",
        movements: [
          { direction: "out", symbol: "USDC", amount: 5000, usd: 5000, isStable: true },
          { direction: "in", symbol: "WETH", amount: 1.0, usd: 2500, tokenId: "eth-weth" },
        ],
      }),
      op({
        hash: "0xwithdraw_weth",
        type: "withdraw_fiat",
        time: 1500,
        chain: "eth",
        movements: [
          { direction: "out", symbol: "WETH", amount: 1.0, usd: 2500, tokenId: "eth-weth" },
        ],
      }),
      op({
        hash: "0xdeposit_eth",
        type: "deposit_fiat",
        time: 2500,
        chain: "arb",
        // CEX часто converts WETH → ETH at withdrawal
        movements: [{ direction: "in", symbol: "ETH", amount: 1.0, usd: 2500, tokenId: "arb" }],
      }),
    ];
    const overrides = computeFiatHopCostBasisOverrides(
      new Map([["w1", ops]]),
      new Map(),
    );
    expect(overrides.has("0xdeposit_eth")).toBe(true);
    expect(overrides.get("0xdeposit_eth")).toBeCloseTo(5000, 1);
  });

  it("респектит pre-existing A4 manual overrides на withdraw (не перезаписывает)", () => {
    // User manually пометил withdraw cost basis = $10000 (например через D3
    // CEX P2P trail). Это должно учитываться при расчёте WAC for the hop.
    const ops: ClassifiedOp[] = [
      op({
        hash: "0xtransfer_in_init",
        type: "transfer_in",
        time: 1000,
        chain: "eth",
        movements: [
          // m.usd = $2500 market, но real cost = $10000 (через manual annotation)
          { direction: "in", symbol: "ETH", amount: 1.0, usd: 2500, tokenId: "eth" },
        ],
      }),
      op({
        hash: "0xwithdraw",
        type: "withdraw_fiat",
        time: 1500,
        chain: "eth",
        movements: [{ direction: "out", symbol: "ETH", amount: 1.0, usd: 2500, tokenId: "eth" }],
      }),
      op({
        hash: "0xdeposit",
        type: "deposit_fiat",
        time: 2500,
        chain: "arb",
        movements: [{ direction: "in", symbol: "ETH", amount: 1.0, usd: 2500, tokenId: "arb" }],
      }),
    ];

    const preExisting = new Map([["0xtransfer_in_init", 10000]]);
    const overrides = computeFiatHopCostBasisOverrides(
      new Map([["w1", ops]]),
      preExisting,
    );
    expect(overrides.has("0xdeposit")).toBe(true);
    // WAC должен быть $10000 (от manual override) → 1.0 × $10000 = $10000
    expect(overrides.get("0xdeposit")).toBeCloseTo(10000, 1);
  });
});
