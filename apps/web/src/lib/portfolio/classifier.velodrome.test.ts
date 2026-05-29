import { describe, expect, it } from "vitest";

import type { DeBankHistoryItem, DeBankProject, DeBankToken } from "../debank";
import { classifyHistory } from "./classifier";

/**
 * Client-side classifier guard for Velodrome/Aerodrome CL gauge unstakes.
 * Mirrors apps/api/.../classifier.test.ts — this is the PRODUCTION path
 * (refresh classifies client-side and pushes via POST /chain-ops/:id/sync),
 * so the fix must live (and be tested) here too. See Bug A / POS-011.
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

function proj(id: string, name: string): DeBankProject {
  return { id, chain: id.split("_")[0]!, name, logo_url: null };
}

const TOKENS: Record<string, DeBankToken> = {
  "op:velo-cl-pos": tok("op:velo-cl-pos", "VELO-CL-POS"),
  "op:weth": tok("op:weth", "WETH", 4356),
  "op:wbtc": tok("op:wbtc", "WBTC", 120590),
};

const PROJECTS: Record<string, DeBankProject> = {
  op_velodrome3: proj("op_velodrome3", "Velodrome V3"),
};

function ctx() {
  return {
    ownAddresses: new Set([SELF.toLowerCase()]),
    selfAddress: SELF.toLowerCase(),
    tokens: TOKENS,
    projects: PROJECTS,
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
    chain: "op",
    cate_id: null,
    time_at: 1_700_000_000,
    project_id: "op_velodrome3",
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

describe("client classifyDex — Velodrome gauge unstake", () => {
  it("withdraw() возвращающий позиционный NFT → unstake, не lp_add", () => {
    const op = item({
      receives: [{ token: "op:velo-cl-pos", amount: 1 }],
      txName: "withdraw",
    });
    expect(classifyHistory([op], ctx())[0]!.type).toBe("unstake");
  });

  it("реальный CL mint (внесение) остаётся lp_add", () => {
    const op = item({
      sends: [
        { token: "op:weth", amount: 0.0269 },
        { token: "op:wbtc", amount: 0.001 },
      ],
      receives: [{ token: "op:velo-cl-pos", amount: 1 }],
      txName: "mint",
    });
    expect(classifyHistory([op], ctx())[0]!.type).toBe("lp_add");
  });
});
