import { describe, expect, it } from "vitest";

import { classifyHistory } from "./classifier.js";
import type {
  DeBankHistoryItem,
  DeBankProject,
  DeBankToken,
} from "./debank_types.js";

/* ------------------------- fixture builders -------------------------------- */

const TOKENS: Record<string, DeBankToken> = {
  // chain:address keys are the convention DeBank uses for token_id.
  "arb:usdc": tok("arb:usdc", "USDC", 1),
  "arb:usdt": tok("arb:usdt", "USDT", 1),
  "arb:dai": tok("arb:dai", "DAI", 1),
  "arb:weth": tok("arb:weth", "WETH", 3000),
  "arb:eth": tok("arb:eth", "ETH", 3000),
  "arb:aArbUSDC": tok("arb:aArbUSDC", "aArbUSDC", 1),
  "arb:aArbWETH": tok("arb:aArbWETH", "aArbWETH", 3000),
  "arb:vDebtArbUSDC": tok("arb:vDebtArbUSDC", "variableDebtArbUSDC", 1),
  "arb:gm": tok("arb:gm", "GM [ETH/USD]", 1.2),
  "arb:glv": tok("arb:glv", "GLV [WETH-USDC]", 1.05),
  "arb:fvlt": tok("arb:fvlt", "FVLT", 1),
  "eth:steth": tok("eth:steth", "stETH", 3000),
  "eth:arb": tok("eth:arb", "ARB", 1.5),
  "eth:uni-v2": tok("eth:uni-v2", "UNI-V2", 100),
  "eth:lib": tok("eth:lib", "LIBRARY.io", 0), // scam-ish, no price
};

const PROJECTS: Record<string, DeBankProject> = {
  "arb_aave3": proj("arb_aave3", "Aave V3"),
  "arb_morpho-blue": proj("arb_morpho-blue", "Morpho Blue"),
  "arb_uniswap3": proj("arb_uniswap3", "Uniswap V3"),
  "arb_gmx2": proj("arb_gmx2", "GMX V2"),
  "eth_lido": proj("eth_lido", "Lido"),
  "eth_etherfi": proj("eth_etherfi", "Ether.fi"),
  "eth_stargate": proj("eth_stargate", "Stargate"),
  "arb_pendle": proj("arb_pendle", "Pendle"),
};

const CEX = {
  binance: { id: "binance", name: "Binance" },
};

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

const SELF = "0xself0000000000000000000000000000000000aa";
const OTHER_OWN = "0xself0000000000000000000000000000000000bb";
const EXTERNAL = "0xexternal0000000000000000000000000000ccccc";

function ctx(extra: { ownAddresses?: string[] } = {}) {
  return {
    ownAddresses: new Set(
      [SELF, ...(extra.ownAddresses ?? [])].map((a) => a.toLowerCase())
    ),
    selfAddress: SELF.toLowerCase(),
    tokens: TOKENS,
    projects: PROJECTS,
    cex: CEX,
  };
}

interface BuildItemOpts {
  id?: string;
  chain?: string;
  time?: number;
  cateId?: string | null;
  projectId?: string | null;
  cexId?: string | null;
  sends?: Array<{ token: string; amount: number }>;
  receives?: Array<{ token: string; amount: number }>;
  tx?: Partial<DeBankHistoryItem["tx"]> | null;
  tokenApprove?: { tokenId: string; spender: string } | null;
}

function item(opts: BuildItemOpts = {}): DeBankHistoryItem {
  const tx: DeBankHistoryItem["tx"] = opts.tx === null
    ? null
    : {
        from_addr: SELF,
        to_addr: EXTERNAL,
        status: 1,
        usd_gas_fee: 0.5,
        ...opts.tx,
      };
  return {
    id: opts.id ?? "0xtx" + Math.random().toString(36).slice(2, 10),
    chain: opts.chain ?? "arb",
    cate_id: opts.cateId ?? null,
    time_at: opts.time ?? 1_700_000_000,
    project_id: opts.projectId ?? null,
    cex_id: opts.cexId ?? null,
    sends: (opts.sends ?? []).map((s) => ({
      token_id: s.token,
      amount: s.amount,
    })),
    receives: (opts.receives ?? []).map((r) => ({
      token_id: r.token,
      amount: r.amount,
    })),
    token_approve: opts.tokenApprove
      ? {
          token_id: opts.tokenApprove.tokenId,
          spender: opts.tokenApprove.spender,
          value: 0,
        }
      : null,
    tx,
  };
}

/* ----------------------------- sort & dedupe ------------------------------- */

describe("classifyHistory — sorting and dedupe", () => {
  it("dedupes by chain:id and sorts ascending by time", () => {
    const a = item({ id: "0xA", time: 200 });
    const b = item({ id: "0xB", time: 100 });
    const dup = item({ id: "0xA", time: 200 });
    const result = classifyHistory([a, b, dup], ctx());
    expect(result).toHaveLength(2);
    expect(result[0]!.hash).toBe("0xB");
    expect(result[1]!.hash).toBe("0xA");
    // seq is 1-indexed in time order.
    expect(result[0]!.seq).toBe(1);
    expect(result[1]!.seq).toBe(2);
  });
});

/* ---------------------------- failed / approve ----------------------------- */

describe("classifyHistory — failed tx", () => {
  it("status=0 → type=failed regardless of movement", () => {
    const it = item({
      sends: [{ token: "arb:usdc", amount: 100 }],
      tx: { status: 0 },
    });
    expect(classifyHistory([it], ctx())[0]!.type).toBe("failed");
  });

  it("failed tx is also tagged with junk:mev_failure or junk:failed", () => {
    const it = item({
      tx: { status: 0, usd_gas_fee: 5 },
    });
    const r = classifyHistory([it], ctx())[0]!;
    expect(r.notes).toContain("junk:mev_failure");
  });
});

describe("classifyHistory — approve", () => {
  it("real approve (no movement) → type=approve", () => {
    const it = item({
      cateId: "approve",
      tokenApprove: { tokenId: "arb:usdc", spender: EXTERNAL },
    });
    expect(classifyHistory([it], ctx())[0]!.type).toBe("approve");
  });

  it("DOES NOT treat 1inch swap with cate_id=approve as approve (real movement)", () => {
    const it = item({
      cateId: "approve",
      sends: [{ token: "arb:usdc", amount: 100 }],
      receives: [{ token: "arb:weth", amount: 0.033 }],
    });
    // Has real in+out → falls through to swap.
    const r = classifyHistory([it], ctx())[0]!;
    expect(r.type).toBe("swap");
  });
});

/* --------------------------- CEX deposit/withdraw -------------------------- */

describe("classifyHistory — CEX", () => {
  it("CEX → wallet (receives only) is deposit_fiat", () => {
    const it = item({
      cexId: "binance",
      receives: [{ token: "arb:usdc", amount: 5000 }],
    });
    const r = classifyHistory([it], ctx())[0]!;
    expect(r.type).toBe("deposit_fiat");
    expect(r.notes ?? []).toContain("from CEX: Binance");
  });

  it("wallet → CEX (sends only) is withdraw_fiat", () => {
    const it = item({
      cexId: "binance",
      sends: [{ token: "arb:usdc", amount: 1000 }],
    });
    const r = classifyHistory([it], ctx())[0]!;
    expect(r.type).toBe("withdraw_fiat");
  });
});

/* ----------------------- transfers between own wallets --------------------- */

describe("classifyHistory — internal transfers", () => {
  it("sends to another own wallet → transfer_out", () => {
    const it = item({
      sends: [{ token: "arb:usdc", amount: 100 }],
      tx: { from_addr: SELF, to_addr: OTHER_OWN },
    });
    const r = classifyHistory([it], ctx({ ownAddresses: [OTHER_OWN] }))[0]!;
    expect(r.type).toBe("transfer_out");
  });

  it("receives from another own wallet → transfer_in", () => {
    const it = item({
      receives: [{ token: "arb:usdc", amount: 100 }],
      tx: { from_addr: OTHER_OWN, to_addr: SELF },
    });
    const r = classifyHistory([it], ctx({ ownAddresses: [OTHER_OWN] }))[0]!;
    expect(r.type).toBe("transfer_in");
  });

  it("NOT marked as transfer when a protocol is involved", () => {
    const it = item({
      projectId: "arb_aave3",
      sends: [{ token: "arb:usdc", amount: 100 }],
      receives: [{ token: "arb:aArbUSDC", amount: 100 }],
      tx: { from_addr: SELF, to_addr: OTHER_OWN },
    });
    const r = classifyHistory([it], ctx({ ownAddresses: [OTHER_OWN] }))[0]!;
    expect(r.type).toBe("lend_supply");
  });
});

/* --------------------------------- bridge ---------------------------------- */

describe("classifyHistory — bridge", () => {
  it("Stargate sends only → bridge_out", () => {
    const it = item({
      projectId: "eth_stargate",
      sends: [{ token: "arb:usdc", amount: 500 }],
    });
    expect(classifyHistory([it], ctx())[0]!.type).toBe("bridge_out");
  });

  it("Stargate receives only → bridge_in", () => {
    const it = item({
      projectId: "eth_stargate",
      receives: [{ token: "arb:usdc", amount: 500 }],
    });
    expect(classifyHistory([it], ctx())[0]!.type).toBe("bridge_in");
  });
});

/* -------------------------------- lending ---------------------------------- */

describe("classifyHistory — Aave (receipt-based)", () => {
  it("send USDC, receive aArbUSDC → lend_supply", () => {
    const it = item({
      projectId: "arb_aave3",
      sends: [{ token: "arb:usdc", amount: 1000 }],
      receives: [{ token: "arb:aArbUSDC", amount: 1000 }],
    });
    expect(classifyHistory([it], ctx())[0]!.type).toBe("lend_supply");
  });

  it("send aArbUSDC, receive USDC → lend_withdraw", () => {
    const it = item({
      projectId: "arb_aave3",
      sends: [{ token: "arb:aArbUSDC", amount: 1000 }],
      receives: [{ token: "arb:usdc", amount: 1000 }],
    });
    expect(classifyHistory([it], ctx())[0]!.type).toBe("lend_withdraw");
  });

  it("receive variableDebtUSDC + USDC → borrow", () => {
    const it = item({
      projectId: "arb_aave3",
      receives: [
        { token: "arb:vDebtArbUSDC", amount: 500 },
        { token: "arb:usdc", amount: 500 },
      ],
    });
    expect(classifyHistory([it], ctx())[0]!.type).toBe("borrow");
  });

  it("send variableDebtUSDC + USDC → repay", () => {
    const it = item({
      projectId: "arb_aave3",
      sends: [
        { token: "arb:vDebtArbUSDC", amount: 100 },
        { token: "arb:usdc", amount: 100 },
      ],
    });
    expect(classifyHistory([it], ctx())[0]!.type).toBe("repay");
  });

  it("combined supply+borrow (Fluid-style): receive aToken + USDC → lend_supply with note", () => {
    const it = item({
      projectId: "arb_aave3",
      sends: [{ token: "arb:weth", amount: 1 }],
      receives: [
        { token: "arb:aArbWETH", amount: 1 },
        { token: "arb:usdc", amount: 1500 },
      ],
    });
    const r = classifyHistory([it], ctx())[0]!;
    expect(r.type).toBe("lend_supply");
    expect(r.notes ?? []).toContain("combined-supply-borrow");
  });

  it("combined withdraw+repay: send aToken + USDC, receive WETH → lend_withdraw with note", () => {
    const it = item({
      projectId: "arb_aave3",
      sends: [
        { token: "arb:aArbWETH", amount: 1 },
        { token: "arb:usdc", amount: 1500 },
      ],
      receives: [{ token: "arb:weth", amount: 1 }],
    });
    const r = classifyHistory([it], ctx())[0]!;
    expect(r.type).toBe("lend_withdraw");
    expect(r.notes ?? []).toContain("combined-withdraw-repay");
  });
});

describe("classifyHistory — Morpho Blue (receipt-less)", () => {
  it("receives-only → borrow", () => {
    const it = item({
      projectId: "arb_morpho-blue",
      receives: [{ token: "arb:usdc", amount: 1000 }],
    });
    expect(classifyHistory([it], ctx())[0]!.type).toBe("borrow");
  });

  it("sends-only all-stables → repay", () => {
    const it = item({
      projectId: "arb_morpho-blue",
      sends: [{ token: "arb:usdc", amount: 500 }],
    });
    expect(classifyHistory([it], ctx())[0]!.type).toBe("repay");
  });

  it("sends-only non-stable (collateral deposit like GLV) → lend_supply", () => {
    const it = item({
      projectId: "arb_morpho-blue",
      sends: [{ token: "arb:glv", amount: 10 }],
    });
    expect(classifyHistory([it], ctx())[0]!.type).toBe("lend_supply");
  });

  it("sends+receives → lend_supply with compound-supply-borrow note", () => {
    const it = item({
      projectId: "arb_morpho-blue",
      sends: [{ token: "arb:weth", amount: 1 }],
      receives: [{ token: "arb:usdc", amount: 1500 }],
    });
    const r = classifyHistory([it], ctx())[0]!;
    expect(r.type).toBe("lend_supply");
    expect(r.notes ?? []).toContain("compound-supply-borrow");
  });
});

/* ------------------------ staking / restaking ------------------------------ */

describe("classifyHistory — staking", () => {
  it("Lido receive stETH for ETH → stake", () => {
    const it = item({
      chain: "eth",
      projectId: "eth_lido",
      sends: [{ token: "arb:eth", amount: 1 }],
      receives: [{ token: "eth:steth", amount: 1 }],
    });
    expect(classifyHistory([it], ctx())[0]!.type).toBe("stake");
  });

  it("Lido send stETH → unstake", () => {
    const it = item({
      chain: "eth",
      projectId: "eth_lido",
      sends: [{ token: "eth:steth", amount: 1 }],
    });
    expect(classifyHistory([it], ctx())[0]!.type).toBe("unstake");
  });

  it("Lido receives-only without protocol-token → claim_rewards", () => {
    const it = item({
      chain: "eth",
      projectId: "eth_lido",
      receives: [{ token: "arb:eth", amount: 0.01 }],
    });
    expect(classifyHistory([it], ctx())[0]!.type).toBe("claim_rewards");
  });
});

/* ------------------------------ yield / perp ------------------------------- */

describe("classifyHistory — yield/perp (GMX V2 async deposits)", () => {
  it("Tx A: send underlying, no protocol-token → lp_add (yield-deposit note)", () => {
    const it = item({
      projectId: "arb_gmx2",
      sends: [{ token: "arb:usdc", amount: 1000 }],
    });
    const r = classifyHistory([it], ctx())[0]!;
    expect(r.type).toBe("lp_add");
    expect(r.notes ?? []).toContain("yield-deposit");
  });

  it("Tx B: protocol-token arrives → lp_add (yield-deposit-fill note)", () => {
    const it = item({
      projectId: "arb_gmx2",
      receives: [{ token: "arb:gm", amount: 800 }],
    });
    const r = classifyHistory([it], ctx())[0]!;
    expect(r.type).toBe("lp_add");
    expect(r.notes ?? []).toContain("yield-deposit-fill");
  });

  it("Tx B of withdraw: protocol-token leaves → lp_remove", () => {
    const it = item({
      projectId: "arb_gmx2",
      sends: [{ token: "arb:gm", amount: 800 }],
    });
    expect(classifyHistory([it], ctx())[0]!.type).toBe("lp_remove");
  });

  it("Tx A of withdraw: underlying arrives → lp_remove", () => {
    const it = item({
      projectId: "arb_gmx2",
      receives: [{ token: "arb:usdc", amount: 1000 }],
    });
    expect(classifyHistory([it], ctx())[0]!.type).toBe("lp_remove");
  });

  it("internal protocol swap (sends + receives without LP movement) → swap", () => {
    const it = item({
      projectId: "arb_pendle",
      sends: [{ token: "arb:usdc", amount: 100 }],
      receives: [{ token: "arb:weth", amount: 0.033 }],
    });
    expect(classifyHistory([it], ctx())[0]!.type).toBe("swap");
  });
});

/* ------------------------------ DEX / LP ----------------------------------- */

describe("classifyHistory — DEX/LP", () => {
  it("Uniswap V3 send + receive different tokens → swap", () => {
    const it = item({
      projectId: "arb_uniswap3",
      sends: [{ token: "arb:usdc", amount: 100 }],
      receives: [{ token: "arb:weth", amount: 0.033 }],
    });
    expect(classifyHistory([it], ctx())[0]!.type).toBe("swap");
  });

  it("Uniswap receive UNI-V2 LP token → lp_add", () => {
    const it = item({
      chain: "eth",
      projectId: "arb_uniswap3",
      sends: [{ token: "arb:weth", amount: 1 }],
      receives: [{ token: "eth:uni-v2", amount: 10 }],
    });
    expect(classifyHistory([it], ctx())[0]!.type).toBe("lp_add");
  });

  it("Uniswap send UNI-V2 LP token → lp_remove", () => {
    const it = item({
      chain: "eth",
      projectId: "arb_uniswap3",
      sends: [{ token: "eth:uni-v2", amount: 10 }],
      receives: [{ token: "arb:weth", amount: 1 }],
    });
    expect(classifyHistory([it], ctx())[0]!.type).toBe("lp_remove");
  });

  it("Uniswap V3 sends-only → lp_add with v3-increase-liquidity note", () => {
    const it = item({
      projectId: "arb_uniswap3",
      sends: [{ token: "arb:weth", amount: 0.1 }],
    });
    const r = classifyHistory([it], ctx())[0]!;
    expect(r.type).toBe("lp_add");
    expect(r.notes ?? []).toContain("v3-increase-liquidity");
  });

  it("Uniswap V3 receives-only → claim_rewards (v3-collect-fees)", () => {
    const it = item({
      projectId: "arb_uniswap3",
      receives: [{ token: "arb:weth", amount: 0.001 }],
    });
    const r = classifyHistory([it], ctx())[0]!;
    expect(r.type).toBe("claim_rewards");
    expect(r.notes ?? []).toContain("v3-collect-fees");
  });
});

/* ---------------- fallback swap / transfer / unknown ----------------------- */

describe("classifyHistory — fallbacks (no project)", () => {
  it("1 send + 1 receive different tokens, no project → swap", () => {
    const it = item({
      sends: [{ token: "arb:usdc", amount: 100 }],
      receives: [{ token: "arb:weth", amount: 0.033 }],
    });
    expect(classifyHistory([it], ctx())[0]!.type).toBe("swap");
  });

  it("plain send (external recipient) → transfer_out", () => {
    const it = item({
      sends: [{ token: "arb:usdc", amount: 100 }],
    });
    expect(classifyHistory([it], ctx())[0]!.type).toBe("transfer_out");
  });

  it("plain receive (external sender) → transfer_in", () => {
    const it = item({
      receives: [{ token: "arb:usdc", amount: 100 }],
    });
    expect(classifyHistory([it], ctx())[0]!.type).toBe("transfer_in");
  });

  it("no sends, no receives, no project → unknown", () => {
    const it = item({});
    expect(classifyHistory([it], ctx())[0]!.type).toBe("unknown");
  });
});

/* ---------------------------- counterparty -------------------------------- */

describe("classifyHistory — counterparty", () => {
  it("when self is from_addr, counterparty = to_addr", () => {
    const it = item({
      sends: [{ token: "arb:usdc", amount: 1 }],
      tx: { from_addr: SELF, to_addr: EXTERNAL },
    });
    const r = classifyHistory([it], ctx())[0]!;
    expect(r.counterparty?.toLowerCase()).toBe(EXTERNAL.toLowerCase());
  });

  it("when self is to_addr, counterparty = from_addr", () => {
    const it = item({
      receives: [{ token: "arb:usdc", amount: 1 }],
      tx: { from_addr: EXTERNAL, to_addr: SELF },
    });
    const r = classifyHistory([it], ctx())[0]!;
    expect(r.counterparty?.toLowerCase()).toBe(EXTERNAL.toLowerCase());
  });
});

/* ------------------------------ junk tags --------------------------------- */

describe("classifyHistory — junk filter integration", () => {
  it("scam airdrop is tagged junk:scam_airdrop", () => {
    const it = item({
      receives: [{ token: "eth:lib", amount: 1_000_000 }],
    });
    const r = classifyHistory([it], ctx())[0]!;
    expect(r.notes ?? []).toContain("junk:scam_airdrop");
  });
});

/* ------------------------------ movements --------------------------------- */

describe("classifyHistory — movement enrichment", () => {
  it("enriches movement with symbol, usd, isStable, isProtocolToken", () => {
    const it = item({
      projectId: "arb_aave3",
      sends: [{ token: "arb:usdc", amount: 1000 }],
      receives: [{ token: "arb:aArbUSDC", amount: 1000 }],
    });
    const r = classifyHistory([it], ctx())[0]!;
    const out = r.movement.find((m) => m.direction === "out")!;
    expect(out.symbol).toBe("USDC");
    expect(out.usd).toBe(1000);
    expect(out.isStable).toBe(true);
    expect(out.isProtocolToken).toBe(false);
    const inMv = r.movement.find((m) => m.direction === "in")!;
    expect(inMv.symbol).toBe("aArbUSDC");
    expect(inMv.isProtocolToken).toBe(true);
  });
});
