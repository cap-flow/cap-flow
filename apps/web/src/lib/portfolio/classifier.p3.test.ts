import { describe, expect, it } from "vitest";

import type { DeBankHistoryItem, DeBankProject, DeBankToken } from "../debank";
import { classifyHistory } from "./classifier";

/**
 * Client-side mirror of apps/api/.../classifier.test.ts P3 cases: value-bearing
 * LP/bridge ops on protocols the catalog doesn't name (RAMSES/Jellyverse/ICHI/
 * King/deBridge). Section 12.5 classifies by LP/vault/BPT receipt token + exit/
 * join fnName + named-bridge. Real mmaksimuk operations.
 */

const SELF = "0xself0000000000000000000000000000000000aa";

function tok(id: string, symbol: string, price?: number): DeBankToken {
  return {
    id, chain: id.split(":")[0]!, name: symbol, symbol, decimals: 18, logo_url: null,
    ...(price !== undefined ? { price } : {}),
  };
}

const TOKENS: Record<string, DeBankToken> = {
  "arb:usdc": tok("arb:usdc", "USDC", 1),
  "arb:usdt0": tok("arb:usdt0", "USD₮0", 1),
  "arb:ram": tok("arb:ram", "RAM", 0.1),
  "arb:ram-v2-pos": tok("arb:ram-v2-pos", "RAM-V2-POS"),
  "arb:iv-ram": tok("arb:iv-ram", "IV-23-RAM", 1.42),
  "sei:bpt": tok("sei:bpt", "sfrxETH/frxETH/wETH", 183),
  "sei:frxeth": tok("sei:frxeth", "frxETH", 3000),
  "sei:weth": tok("sei:weth", "WETH", 3000),
  "eth:king": tok("eth:king", "KING", 1.31),
  "eth:eigen": tok("eth:eigen", "EIGEN", 3.5),
  "eth:ethfi": tok("eth:ethfi", "ETHFI", 2),
  "eth:wbtc": tok("eth:wbtc", "WBTC", 96000),
  "eth:eth": tok("eth:eth", "ETH", 3000),
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
  chain: string; projectId: string; fnName: string;
  sends: { token: string; amount: number }[];
  receives: { token: string; amount: number }[];
}): DeBankHistoryItem {
  return {
    id: "0x" + Math.random().toString(36).slice(2, 12),
    chain: opts.chain, cate_id: null, time_at: 1_700_000_000,
    project_id: opts.projectId, cex_id: null,
    sends: opts.sends.map((s) => ({ token_id: s.token, amount: s.amount })),
    receives: opts.receives.map((r) => ({ token_id: r.token, amount: r.amount })),
    token_approve: null,
    tx: { from_addr: SELF, to_addr: "0xext00000000000000000000000000000000000cc", status: 1, name: opts.fnName },
  };
}

describe("client classifier — P3 LP/bridge heuristic (unnamed protocols)", () => {
  it("RAMSES mint: IN RAM-V2-POS → lp_add", () => {
    const op = item({ chain: "arb", projectId: "arb_ramses", fnName: "mint",
      sends: [{ token: "arb:usdt0", amount: 10 }, { token: "arb:usdc", amount: 25 }],
      receives: [{ token: "arb:ram-v2-pos", amount: 1 }] });
    expect(classifyHistory([op], ctx())[0]!.type).toBe("lp_add");
  });

  it("RAMSES multicall: OUT RAM-V2-POS → lp_remove", () => {
    const op = item({ chain: "arb", projectId: "arb_ramses", fnName: "multicall",
      sends: [{ token: "arb:ram-v2-pos", amount: 1 }],
      receives: [{ token: "arb:usdt0", amount: 35 }, { token: "arb:ram", amount: 0.1 }] });
    expect(classifyHistory([op], ctx())[0]!.type).toBe("lp_remove");
  });

  it("Jellyverse exitPool: OUT BPT + multi underlying → lp_remove", () => {
    const op = item({ chain: "sei", projectId: "sei_jellyverse", fnName: "exitPool",
      sends: [{ token: "sei:bpt", amount: 1 }],
      receives: [{ token: "sei:frxeth", amount: 0.03 }, { token: "sei:weth", amount: 0.005 }] });
    expect(classifyHistory([op], ctx())[0]!.type).toBe("lp_remove");
  });

  it("ICHI withdraw: OUT IV-23-RAM → lp_remove", () => {
    const op = item({ chain: "arb", projectId: "arb_ichi", fnName: "withdraw",
      sends: [{ token: "arb:iv-ram", amount: 1 }],
      receives: [{ token: "arb:ram", amount: 0.29 }, { token: "arb:usdc", amount: 1.57 }] });
    expect(classifyHistory([op], ctx())[0]!.type).toBe("lp_remove");
  });

  it("King redeem: OUT KING + basket → lp_remove", () => {
    const op = item({ chain: "eth", projectId: "kingprotocol", fnName: "redeem",
      sends: [{ token: "eth:king", amount: 1 }],
      receives: [{ token: "eth:eigen", amount: 0.2 }, { token: "eth:ethfi", amount: 0.15 }] });
    expect(classifyHistory([op], ctx())[0]!.type).toBe("lp_remove");
  });

  it("deBridge strictlySwapAndCall (2 sends, net out) → bridge_out", () => {
    const op = item({ chain: "eth", projectId: "debridge", fnName: "strictlySwapAndCall",
      sends: [{ token: "eth:wbtc", amount: 0.01 }, { token: "eth:eth", amount: 0.0006 }],
      receives: [{ token: "arb:usdc", amount: 3.88 }] });
    expect(classifyHistory([op], ctx())[0]!.type).toBe("bridge_out");
  });
});
