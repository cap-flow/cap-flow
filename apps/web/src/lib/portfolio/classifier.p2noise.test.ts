import { describe, expect, it } from "vitest";

import type { DeBankHistoryItem, DeBankProject, DeBankToken } from "../debank";
import { classifyHistory } from "./classifier";

/**
 * Client-side mirror of apps/api/.../classifier.test.ts P2 cases: value-less
 * empty-movement ops → approve / noise (cosmetic unknown=0). Refresh classifies
 * client-side and POSTs to /chain-ops/:walletId/sync, so the production path
 * must match the server. approve-family → 'approve'; points/referral/spam-
 * transfer/multicall/EIP-7702 → 'noise' (kept junk:empty_movement, inert).
 */

const SELF = "0xself0000000000000000000000000000000000aa";

function ctx() {
  return {
    ownAddresses: new Set([SELF.toLowerCase()]),
    selfAddress: SELF.toLowerCase(),
    tokens: {} as Record<string, DeBankToken>,
    projects: {} as Record<string, DeBankProject>,
    cex: {},
  };
}

function item(opts: { chain: string; projectId?: string; fnName: string }): DeBankHistoryItem {
  return {
    id: "0x" + Math.random().toString(36).slice(2, 12),
    chain: opts.chain,
    cate_id: null,
    time_at: 1_700_000_000,
    project_id: opts.projectId ?? null,
    cex_id: null,
    sends: [],
    receives: [],
    token_approve: null,
    tx: {
      from_addr: SELF,
      to_addr: "0xexternal000000000000000000000000000000cc",
      status: 1,
      name: opts.fnName,
    },
  };
}

describe("client classifier — P2 empty-movement noise/approve fallback", () => {
  it("approve (dex-проект) → approve [classifyDex tail]", () => {
    expect(classifyHistory([item({ chain: "base", projectId: "base_aerodrome", fnName: "approve" })], ctx())[0]!.type).toBe("approve");
  });

  it("setApprovalForAll (Uniswap V4 dex) → approve", () => {
    expect(classifyHistory([item({ chain: "arb", projectId: "arb_uniswap4", fnName: "setApprovalForAll" })], ctx())[0]!.type).toBe("approve");
  });

  it("approveForAll (LFJ → other, doClassify tail) → approve", () => {
    expect(classifyHistory([item({ chain: "avax", projectId: "avax_lfj", fnName: "approveForAll" })], ctx())[0]!.type).toBe("approve");
  });

  it("bulkAddFxtlPoints (Frax points) → noise", () => {
    expect(classifyHistory([item({ chain: "frax", projectId: "frax", fnName: "bulkAddFxtlPoints" })], ctx())[0]!.type).toBe("noise");
  });

  it("setTraderReferralCodeByUser (referral) → noise", () => {
    expect(classifyHistory([item({ chain: "base", projectId: "base_avantis", fnName: "setTraderReferralCodeByUser" })], ctx())[0]!.type).toBe("noise");
  });

  it("multicall (Gearbox) → noise [EOA инертно]", () => {
    expect(classifyHistory([item({ chain: "eth", projectId: "gearbox", fnName: "multicall" })], ctx())[0]!.type).toBe("noise");
  });

  it("spam/zero-value transfer (нет проекта) → noise", () => {
    expect(classifyHistory([item({ chain: "eth", fnName: "transfer" })], ctx())[0]!.type).toBe("noise");
  });

  it("пустой fnName (EIP-7702) → noise", () => {
    expect(classifyHistory([item({ chain: "arb", fnName: "" })], ctx())[0]!.type).toBe("noise");
  });

  it("noise сохраняет junk:empty_movement (inert)", () => {
    const r = classifyHistory([item({ chain: "eth", fnName: "transfer" })], ctx())[0]!;
    expect(r.type).toBe("noise");
    expect(r.notes ?? []).toContain("junk:empty_movement");
  });

  it("P1 регрессия: collect+NPM → claim_rewards, не noise", () => {
    const op: DeBankHistoryItem = {
      ...item({ chain: "arb", projectId: "arb_uniswap3", fnName: "collect" }),
      tx: {
        from_addr: SELF,
        to_addr: "0xc36442b4a4522e871399cd717abdd847ab11fe88",
        status: 1,
        name: "collect",
      },
    };
    expect(classifyHistory([op], ctx())[0]!.type).toBe("claim_rewards");
  });
});
