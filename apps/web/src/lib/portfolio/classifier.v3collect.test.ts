import { describe, expect, it } from "vitest";

import type { DeBankHistoryItem, DeBankProject, DeBankToken } from "../debank";
import { classifyHistory } from "./classifier";

/**
 * Client-side mirror of apps/api/.../classifier.test.ts P1 cases: UniV3 NPM
 * collect() with EMPTY DeBank movement. Refresh classifies client-side and
 * POSTs to /chain-ops/:walletId/sync, so the production path must classify
 * these identically to the server (divergence corrupts sync). A `collect` on a
 * DEX — or any direct call to the Uniswap V3 NonfungiblePositionManager —
 * becomes claim_rewards; numerically inert (empty movement → $0, junk-tagged).
 */

const SELF = "0xself0000000000000000000000000000000000aa";
const NPM = "0xc36442b4a4522e871399cd717abdd847ab11fe88";

function proj(id: string, name: string): DeBankProject {
  return { id, chain: id.split("_")[0]!, name, logo_url: null };
}

function ctx() {
  return {
    ownAddresses: new Set([SELF.toLowerCase()]),
    selfAddress: SELF.toLowerCase(),
    tokens: {} as Record<string, DeBankToken>,
    projects: {} as Record<string, DeBankProject>,
    cex: {},
  };
}

function item(opts: {
  chain: string;
  projectId: string;
  fnName: string;
  toAddr: string;
}): DeBankHistoryItem {
  return {
    id: "0x" + Math.random().toString(36).slice(2, 12),
    chain: opts.chain,
    cate_id: null,
    time_at: 1_700_000_000,
    project_id: opts.projectId,
    cex_id: null,
    sends: [],
    receives: [],
    token_approve: null,
    tx: {
      from_addr: SELF,
      to_addr: opts.toAddr,
      status: 1,
      name: opts.fnName,
    },
  };
}

describe("client classifier — UniV3 collect empty movement (P1)", () => {
  it("eth NPM collect, пустой movement → claim_rewards, protocol.id=eth_uniswap3", () => {
    const op = item({ chain: "eth", projectId: "uniswap3", fnName: "collect", toAddr: NPM });
    const r = classifyHistory([op], ctx())[0]!;
    expect(r.type).toBe("claim_rewards");
    expect(r.protocol?.id).toBe("eth_uniswap3");
    expect(r.notes ?? []).toContain("v3-collect-fees");
  });

  it("arb collect → claim_rewards, protocol.id=arb_uniswap3 (префикс сохранён)", () => {
    const op = item({ chain: "arb", projectId: "arb_uniswap3", fnName: "collect", toAddr: NPM });
    const r = classifyHistory([op], ctx())[0]!;
    expect(r.type).toBe("claim_rewards");
    expect(r.protocol?.id).toBe("arb_uniswap3");
  });

  it("прямой вызов NPM с другим fnName (multicall) → claim_rewards", () => {
    const op = item({ chain: "arb", projectId: "arb_uniswap3", fnName: "multicall", toAddr: NPM });
    expect(classifyHistory([op], ctx())[0]!.type).toBe("claim_rewards");
  });

  it("Velodrome collect empty movement → claim_rewards, protocol.id=op_velodrome3", () => {
    const op = item({
      chain: "op",
      projectId: "op_velodrome3",
      fnName: "collect",
      toAddr: "0xdeadbeef00000000000000000000000000000000",
    });
    const r = classifyHistory([op], ctx())[0]!;
    expect(r.type).toBe("claim_rewards");
    expect(r.protocol?.id).toBe("op_velodrome3");
  });

  it("dex op без collect/NPM и пустой movement → остаётся unknown", () => {
    const op = item({
      chain: "arb",
      projectId: "arb_uniswap3",
      fnName: "someOtherFn",
      toAddr: "0xdeadbeef00000000000000000000000000000000",
    });
    expect(classifyHistory([op], ctx())[0]!.type).toBe("unknown");
  });
});
