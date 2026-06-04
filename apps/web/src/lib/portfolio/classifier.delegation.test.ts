import { describe, expect, it } from "vitest";

import type { DeBankHistoryItem, DeBankProject, DeBankToken } from "../debank";
import { classifyHistory } from "./classifier";

/**
 * Client-side mirror of apps/api/.../classifier.test.ts smart-account /
 * delegation wrapper cases (P0, mmaksimuk). Refresh classifies client-side and
 * POSTs via /chain-ops/:id/sync, so the production path must classify these
 * `unknown`-bucketed wrappers identically to the server. DeBank strips
 * project_id for EIP-7710 wrappers (redeemDelegations/execute); we classify by
 * MATERIAL token movement (sub-$1 dust ignored), not the opaque outer fnName.
 */

const SELF = "0xself0000000000000000000000000000000000aa";

function tok(id: string, symbol: string, price?: number): DeBankToken {
  return {
    id,
    chain: id.split(":")[0]!,
    name: symbol,
    symbol,
    decimals: 18,
    logo_url: null,
    ...(price !== undefined ? { price } : {}),
  };
}

const TOKENS: Record<string, DeBankToken> = {
  "arb:usdc": tok("arb:usdc", "USDC", 1),
  "arb:weth": tok("arb:weth", "WETH", 3000),
  "arb:eth": tok("arb:eth", "ETH", 3000),
  "arb:wbtc": tok("arb:wbtc", "WBTC", 120590),
  "arb:arb": tok("arb:arb", "ARB", 0.12),
  "arb:aArbWETH": tok("arb:aArbWETH", "aArbWETH", 3000),
  "arb:aArbUSDC": tok("arb:aArbUSDC", "aArbUSDC", 1),
  "arb:vDebtArbUSDC": tok("arb:vDebtArbUSDC", "variableDebtArbUSDC", 1),
  "arb:uni-v3-pos": tok("arb:uni-v3-pos", "UNI-V3-POS"),
  "arb:steth": tok("arb:steth", "stETH", 3000),
};

function ctx() {
  return {
    ownAddresses: new Set([SELF.toLowerCase()]),
    selfAddress: SELF.toLowerCase(),
    tokens: TOKENS,
    projects: {} as Record<string, DeBankProject>,
    cex: {},
  };
}

function item(opts: {
  sends?: { token: string; amount: number }[];
  receives?: { token: string; amount: number }[];
  txName?: string;
}): DeBankHistoryItem {
  return {
    id: "0x" + Math.random().toString(36).slice(2, 12),
    chain: "arb",
    cate_id: null,
    time_at: 1_700_000_000,
    project_id: null,
    cex_id: null,
    sends: (opts.sends ?? []).map((s) => ({ token_id: s.token, amount: s.amount })),
    receives: (opts.receives ?? []).map((r) => ({
      token_id: r.token,
      amount: r.amount,
    })),
    token_approve: null,
    tx: {
      from_addr: SELF,
      to_addr: "0xexternal000000000000000000000000000000cc",
      status: 1,
      ...(opts.txName !== undefined ? { name: opts.txName } : {}),
    },
  };
}

describe("client classifier — delegation/execute wrappers (no project_id)", () => {
  it("execute wrapper: send 2 underlying, receive UNI-V3-POS → lp_add", () => {
    const op = item({
      sends: [
        { token: "arb:weth", amount: 0.2 },
        { token: "arb:usdc", amount: 600 },
      ],
      receives: [{ token: "arb:uni-v3-pos", amount: 1 }],
      txName: "execute",
    });
    expect(classifyHistory([op], ctx())[0]!.type).toBe("lp_add");
  });

  it("redeemDelegations fee-collect c dust-send → claim_rewards", () => {
    const op = item({
      sends: [{ token: "arb:arb", amount: 0.25 }], // ≈ $0.03 dust
      receives: [
        { token: "arb:usdc", amount: 500 },
        { token: "arb:weth", amount: 0.1 },
      ],
      txName: "redeemDelegations",
    });
    const r = classifyHistory([op], ctx())[0]!;
    expect(r.type).toBe("claim_rewards");
    expect(r.notes ?? []).toContain("delegation-collect");
  });

  it("redeemDelegations Aave supply: receive aArbWETH receipt → lend_supply", () => {
    const op = item({
      sends: [
        { token: "arb:wbtc", amount: 0.0000002 }, // dust
        { token: "arb:eth", amount: 0.385 }, // ≈ $1155 material
      ],
      receives: [{ token: "arb:aArbWETH", amount: 0.39 }],
      txName: "redeemDelegations",
    });
    const r = classifyHistory([op], ctx())[0]!;
    expect(r.type).toBe("lend_supply");
    expect(r.notes ?? []).toContain("delegation-supply");
  });

  it("variableDebt receipt не классифицируется как lend_supply", () => {
    const op = item({
      sends: [{ token: "arb:eth", amount: 0.385 }],
      receives: [{ token: "arb:vDebtArbUSDC", amount: 1000 }],
      txName: "redeemDelegations",
    });
    expect(classifyHistory([op], ctx())[0]!.type).not.toBe("lend_supply");
  });

  // Section-9 ordering gap (workflow-верификация): одноногая wrapper-операция.
  it("одноногий execute mint (1 send + UNI-V3-POS) → lp_add, не swap", () => {
    const op = item({
      sends: [{ token: "arb:usdc", amount: 600 }],
      receives: [{ token: "arb:uni-v3-pos", amount: 1 }],
      txName: "execute",
    });
    expect(classifyHistory([op], ctx())[0]!.type).toBe("lp_add");
  });

  it("одноногий redeemDelegations supply (1 USDC + aArbUSDC) → lend_supply, не swap", () => {
    const op = item({
      sends: [{ token: "arb:usdc", amount: 1000 }],
      receives: [{ token: "arb:aArbUSDC", amount: 1000 }],
      txName: "redeemDelegations",
    });
    expect(classifyHistory([op], ctx())[0]!.type).toBe("lend_supply");
  });

  // Регрессия гарда: реальный 1-1 своп в LST остаётся swap.
  it("реальный своп WETH→stETH (LST, не deposit-receipt) остаётся swap", () => {
    const op = item({
      sends: [{ token: "arb:weth", amount: 1 }],
      receives: [{ token: "arb:steth", amount: 0.99 }],
    });
    expect(classifyHistory([op], ctx())[0]!.type).toBe("swap");
  });
});
