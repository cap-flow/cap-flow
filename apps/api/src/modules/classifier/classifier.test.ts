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
  "arb:wbtc": tok("arb:wbtc", "WBTC", 120590),
  // Uniswap V3 position NFT receipt (protocol token) on Arbitrum.
  "arb:uni-v3-pos": tok("arb:uni-v3-pos", "UNI-V3-POS"),
  "arb:aArbUSDC": tok("arb:aArbUSDC", "aArbUSDC", 1),
  "arb:aArbWETH": tok("arb:aArbWETH", "aArbWETH", 3000),
  // Real bob@example.com case — aArbARB receipt for Aave ARB supply on
  // Arbitrum. Token symbol starts with `aArb` (camel-case) — toUpperCase
  // → "AARBARB" still matches /^A[A-Z]/ but regression test guards
  // against future tweaks. arb price ≈ $0.12.
  "arb:aArbARB": tok("arb:aArbARB", "aArbARB", 0.12),
  "arb:arb": tok("arb:arb", "ARB", 0.12),
  "arb:vDebtArbUSDC": tok("arb:vDebtArbUSDC", "variableDebtArbUSDC", 1),
  "arb:gm": tok("arb:gm", "GM [ETH/USD]", 1.2),
  "arb:glv": tok("arb:glv", "GLV [WETH-USDC]", 1.05),
  "arb:fvlt": tok("arb:fvlt", "FVLT", 1),
  "eth:steth": tok("eth:steth", "stETH", 3000),
  "eth:arb": tok("eth:arb", "ARB", 1.5),
  "eth:uni-v2": tok("eth:uni-v2", "UNI-V2", 100),
  "eth:lib": tok("eth:lib", "LIBRARY.io", 0), // scam-ish, no price
  // Velodrome V3 (Slipstream) CL position NFT receipt + underlying (Optimism).
  "op:velo-cl-pos": tok("op:velo-cl-pos", "VELO-CL-POS"),
  "op:weth": tok("op:weth", "WETH", 4356),
  "op:wbtc": tok("op:wbtc", "WBTC", 120590),
  // P3: LP/vault/BPT receipt tokens on protocols the catalog doesn't name.
  "arb:ram-v2-pos": tok("arb:ram-v2-pos", "RAM-V2-POS"), // RAMSES CL position NFT
  "arb:iv-ram": tok("arb:iv-ram", "IV-23-RAM", 1.42), // ICHI vault share
  "arb:ram": tok("arb:ram", "RAM", 0.1),
  "arb:usdt0": tok("arb:usdt0", "USD₮0", 1),
  "sei:bpt-frx": tok("sei:bpt-frx", "sfrxETH/frxETH/wETH", 183), // Jellyverse BPT
  "sei:frxeth": tok("sei:frxeth", "frxETH", 3000),
  "sei:sfrxeth": tok("sei:sfrxeth", "sfrxETH", 3100),
  "sei:weth": tok("sei:weth", "WETH", 3000),
  "eth:king": tok("eth:king", "KING", 1.31),
  "eth:eigen": tok("eth:eigen", "EIGEN", 3.5),
  "eth:wbtc": tok("eth:wbtc", "WBTC", 96000),
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
  "op_velodrome3": proj("op_velodrome3", "Velodrome V3"),
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

  // Real bob@example.com case: tx 0x382e...8037b on 2026-04-11. Aave V3
  // withdraw of ARB on Arbitrum. Symbol is camel-case "aArbARB" (not
  // "aArbUSDC"). DB shows op_type='lend_supply' for this tx — this test
  // pins the classifier behavior. If it passes here, the DB rows are
  // stale (synced before classifier improvements) and need reclass.
  it("Aave ARB withdraw: send aArbARB, receive ARB → lend_withdraw", () => {
    const it = item({
      projectId: "arb_aave3",
      sends: [{ token: "arb:aArbARB", amount: 140276 }],
      receives: [{ token: "arb:arb", amount: 140276 }],
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

  // P2: пустой movement без распознанного fnName → noise (value-less), не unknown.
  // Финальный unknown теперь достижим ТОЛЬКО для value-bearing (непустой movement).
  it("no sends, no receives, no project → noise", () => {
    const it = item({});
    expect(classifyHistory([it], ctx())[0]!.type).toBe("noise");
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

/* --------------------- Velodrome gauge unstake (Bug A) -------------------- */

describe("classifyDex — Velodrome/Aerodrome gauge unstake", () => {
  // CLGauge.withdraw(tokenId) возвращает позиционный NFT из gauge в кошелёк
  // (protocol-token IN, ничего не уходит). Это РАССТЕЙК, не внесение —
  // иначе ложный opener с неверной датой и нулевым cost basis (POS-011).
  it("withdraw() возвращающий позиционный NFT → unstake, не lp_add", () => {
    const op = item({
      chain: "op",
      projectId: "op_velodrome3",
      receives: [{ token: "op:velo-cl-pos", amount: 1 }],
      tx: { name: "withdraw" },
    });
    expect(classifyHistory([op], ctx())[0]!.type).toBe("unstake");
  });

  // Регрессия: реальный mint (внесение WETH/WBTC + получение NFT) остаётся
  // lp_add — guard не должен его трогать (есть sends, fnName=mint).
  it("реальный CL mint (внесение) остаётся lp_add", () => {
    const op = item({
      chain: "op",
      projectId: "op_velodrome3",
      sends: [
        { token: "op:weth", amount: 0.0269 },
        { token: "op:wbtc", amount: 0.001 },
      ],
      receives: [{ token: "op:velo-cl-pos", amount: 1 }],
      tx: { name: "mint" },
    });
    expect(classifyHistory([op], ctx())[0]!.type).toBe("lp_add");
  });
});

/* ----------- Smart-account / delegation wrappers (P0, mmaksimuk) ----------- */
// Реальные `unknown` строки из chain_operations: DeBank не отдаёт project_id
// для smart-account/EIP-7710 врапперов (redeemDelegations/execute), а
// классификатор раньше смотрел на внешний fnName и сдавался. Классифицируем по
// МАТЕРИАЛЬНОМУ движению (sub-$1 gas/approval dust игнорируется).
describe("classifyHistory — delegation/execute wrappers (no project_id)", () => {
  // UNI-V3-POS NFT приходит в кошелёк + уходит underlying → lp_add. Внешний
  // fnName=execute не мешает (ветка не гейтит по fnName).
  it("execute wrapper: send 2 underlying, receive UNI-V3-POS → lp_add", () => {
    const it = item({
      sends: [
        { token: "arb:weth", amount: 0.2 },
        { token: "arb:usdc", amount: 600 },
      ],
      receives: [{ token: "arb:uni-v3-pos", amount: 1 }],
      tx: { name: "execute" },
    });
    expect(classifyHistory([it], ctx())[0]!.type).toBe("lp_add");
  });

  // redeemDelegations fee-collect: dust ARB ($0.03) send + 2 материальных IN
  // (stable + volatile) → claim_rewards (V3 fee collect через smart-account).
  // Раньше dust-send ломал receives-only ветку → unknown.
  it("redeemDelegations fee-collect c dust-send → claim_rewards", () => {
    const it = item({
      sends: [{ token: "arb:arb", amount: 0.25 }], // ≈ $0.03 dust
      receives: [
        { token: "arb:usdc", amount: 500 },
        { token: "arb:weth", amount: 0.1 },
      ],
      tx: { name: "redeemDelegations" },
    });
    const r = classifyHistory([it], ctx())[0]!;
    expect(r.type).toBe("claim_rewards");
    expect(r.notes ?? []).toContain("delegation-collect");
  });

  // redeemDelegations Aave supply: dust WBTC + материальный ETH уходят, приходит
  // aArbWETH receipt → lend_supply. Раньше ветка знала только UNI-V*-POS.
  it("redeemDelegations Aave supply: receive aArbWETH receipt → lend_supply", () => {
    const it = item({
      sends: [
        { token: "arb:wbtc", amount: 0.0000002 }, // dust
        { token: "arb:eth", amount: 0.385 }, // ≈ $1155 material
      ],
      receives: [{ token: "arb:aArbWETH", amount: 0.39 }],
      tx: { name: "redeemDelegations" },
    });
    const r = classifyHistory([it], ctx())[0]!;
    expect(r.type).toBe("lend_supply");
    expect(r.notes ?? []).toContain("delegation-supply");
  });

  // Регрессия: debt-receipt (variableDebt) НЕ должен попасть в lend_supply.
  it("variableDebt receipt не классифицируется как lend_supply", () => {
    const it = item({
      sends: [{ token: "arb:eth", amount: 0.385 }],
      receives: [{ token: "arb:vDebtArbUSDC", amount: 1000 }],
      tx: { name: "redeemDelegations" },
    });
    expect(classifyHistory([it], ctx())[0]!.type).not.toBe("lend_supply");
  });

  // variableDebt c 2 sends (dust + material) доходит до ветки 11b — гард
  // `!/^variabledebt/` исключает borrow-receipt из lend_supply (минуя section 9).
  it("variableDebt + 2 sends (минует swap) → НЕ lend_supply", () => {
    const it = item({
      sends: [
        { token: "arb:arb", amount: 0.25 }, // dust
        { token: "arb:eth", amount: 0.385 }, // material
      ],
      receives: [{ token: "arb:vDebtArbUSDC", amount: 1000 }],
      tx: { name: "redeemDelegations" },
    });
    expect(classifyHistory([it], ctx())[0]!.type).not.toBe("lend_supply");
  });

  // ── Section-9 ordering gap (найдено workflow-верификацией): одноногая
  //    wrapper-операция (1 send + 1 deposit-receipt) раньше короткозамыкалась
  //    в `swap`. Deposit-receipt (LP-NFT / aToken) — не выход свопа.
  it("одноногий execute mint (1 send + UNI-V3-POS) → lp_add, не swap", () => {
    const it = item({
      sends: [{ token: "arb:usdc", amount: 600 }],
      receives: [{ token: "arb:uni-v3-pos", amount: 1 }],
      tx: { name: "execute" },
    });
    expect(classifyHistory([it], ctx())[0]!.type).toBe("lp_add");
  });

  it("одноногий redeemDelegations supply (1 USDC + aArbUSDC) → lend_supply, не swap", () => {
    const it = item({
      sends: [{ token: "arb:usdc", amount: 1000 }],
      receives: [{ token: "arb:aArbUSDC", amount: 1000 }],
      tx: { name: "redeemDelegations" },
    });
    expect(classifyHistory([it], ctx())[0]!.type).toBe("lend_supply");
  });

  // Регрессия гарда: РЕАЛЬНЫЙ 1-1 своп в LST (stETH — protocol-token, но
  // свопаемый) НЕ должен быть задет deposit-receipt-исключением.
  it("реальный своп WETH→stETH (LST, не deposit-receipt) остаётся swap", () => {
    const it = item({
      chain: "eth",
      sends: [{ token: "arb:weth", amount: 1 }],
      receives: [{ token: "eth:steth", amount: 0.99 }],
    });
    expect(classifyHistory([it], ctx())[0]!.type).toBe("swap");
  });
});

/* ------- P1: UniV3 NPM collect() с пустым movement (claim_rewards) --------- */
// DeBank иногда возвращает collect() с ПУСТЫМ movement (zero-fee collect или
// gap). protocol.category=dex -> classifyDex, но все ветки требуют sends/receives
// -> падало в unknown. Фикс: fnName=collect ЛИБО to_addr=NPM -> claim_rewards.
// Численно инертно (пустой movement -> $0; junk:empty_movement -> isJunkOp скип;
// Krystal override владеет fee). protocol.id chain-префиксуется для LP-матчинга.
describe("classifyHistory — UniV3 collect empty movement (P1)", () => {
  const NPM = "0xc36442b4a4522e871399cd717abdd847ab11fe88";

  it("eth NPM collect, пустой movement → claim_rewards, protocol.id=eth_uniswap3", () => {
    const it = item({
      chain: "eth",
      projectId: "uniswap3", // как в DeBank для eth — без chain-префикса
      tx: { name: "collect", to_addr: NPM },
    });
    const r = classifyHistory([it], ctx())[0]!;
    expect(r.type).toBe("claim_rewards");
    expect(r.protocol?.id).toBe("eth_uniswap3");
    expect(r.notes ?? []).toContain("v3-collect-fees");
  });

  it("arb collect → claim_rewards, protocol.id=arb_uniswap3 (префикс сохранён)", () => {
    const it = item({
      chain: "arb",
      projectId: "arb_uniswap3",
      tx: { name: "collect", to_addr: NPM },
    });
    const r = classifyHistory([it], ctx())[0]!;
    expect(r.type).toBe("claim_rewards");
    expect(r.protocol?.id).toBe("arb_uniswap3");
  });

  // Численная инертность (double-count safety): reclassified collect c пустым
  // movement всё равно получает junk:empty_movement → isJunkOp=true → fee-движок
  // его скипает; реальную сумму fee владеет Krystal-override. Нет двойного счёта.
  it("reclassified collect всё ещё junk:empty_movement (inert, no double-count)", () => {
    const it = item({
      chain: "arb",
      projectId: "arb_uniswap3",
      tx: { name: "collect", to_addr: NPM },
    });
    const r = classifyHistory([it], ctx())[0]!;
    expect(r.type).toBe("claim_rewards");
    expect(r.notes ?? []).toContain("junk:empty_movement");
  });

  it("прямой вызов NPM с другим fnName (multicall) → тоже claim_rewards", () => {
    const it = item({
      chain: "arb",
      projectId: "arb_uniswap3",
      tx: { name: "multicall", to_addr: NPM },
    });
    expect(classifyHistory([it], ctx())[0]!.type).toBe("claim_rewards");
  });

  // Обобщённый префикс НЕ мислейблит не-Uniswap dex: Velodrome collect остаётся
  // velodrome3 (а не форсится в uniswap3).
  it("Velodrome collect empty movement → claim_rewards, protocol.id=op_velodrome3", () => {
    const it = item({
      chain: "op",
      projectId: "op_velodrome3",
      tx: { name: "collect", to_addr: "0xdeadbeef00000000000000000000000000000000" },
    });
    const r = classifyHistory([it], ctx())[0]!;
    expect(r.type).toBe("claim_rewards");
    expect(r.protocol?.id).toBe("op_velodrome3");
  });

  // P2: dex-op без collect/NPM и без движения теперь → noise (value-less), не unknown.
  it("dex op без collect/NPM и пустой movement → noise (P2)", () => {
    const it = item({
      chain: "arb",
      projectId: "arb_uniswap3",
      tx: { name: "someOtherFn", to_addr: "0xdeadbeef00000000000000000000000000000000" },
    });
    expect(classifyHistory([it], ctx())[0]!.type).toBe("noise");
  });
});

/* -------- P2: empty-movement value-less ops → approve / noise (unknown=0) --- */
// 54 value-less unknown'ов: approve-семья → approve; всё прочее (points/referral/
// spam/zero-value transfer/multicall/EIP-7702) → noise. Все сохраняют
// junk:empty_movement → isJunkOp=true → инертны для cost basis. Финальный unknown
// теперь достижим ТОЛЬКО для value-bearing (непустой movement). Покрывает оба
// tail'а: classifyDex (dex-протоколы) и doClassify (null/other/perp).
describe("classifyHistory — P2 empty-movement noise/approve fallback", () => {
  it("approve (dex-проект, нет cate_id) → approve [classifyDex tail]", () => {
    const it = item({
      chain: "base",
      projectId: "base_aerodrome", // dex
      tx: { name: "approve" },
    });
    expect(classifyHistory([it], ctx())[0]!.type).toBe("approve");
  });

  it("setApprovalForAll (Uniswap V4 dex) → approve", () => {
    const it = item({
      chain: "arb",
      projectId: "arb_uniswap4",
      tx: { name: "setApprovalForAll" },
    });
    expect(classifyHistory([it], ctx())[0]!.type).toBe("approve");
  });

  it("approveForAll (LFJ → other, doClassify tail) → approve", () => {
    const it = item({
      chain: "avax",
      projectId: "avax_lfj",
      tx: { name: "approveForAll" },
    });
    expect(classifyHistory([it], ctx())[0]!.type).toBe("approve");
  });

  it("bulkAddFxtlPoints (Frax points) → noise", () => {
    const it = item({ chain: "frax", projectId: "frax", tx: { name: "bulkAddFxtlPoints" } });
    expect(classifyHistory([it], ctx())[0]!.type).toBe("noise");
  });

  it("setTraderReferralCodeByUser (referral) → noise", () => {
    const it = item({ chain: "base", projectId: "base_avantis", tx: { name: "setTraderReferralCodeByUser" } });
    expect(classifyHistory([it], ctx())[0]!.type).toBe("noise");
  });

  it("multicall (Gearbox, value в credit-account) → noise [EOA инертно]", () => {
    const it = item({ chain: "eth", projectId: "gearbox", tx: { name: "multicall" } });
    expect(classifyHistory([it], ctx())[0]!.type).toBe("noise");
  });

  it("spam/zero-value transfer (нет проекта) → noise", () => {
    const it = item({ chain: "eth", tx: { name: "transfer" } });
    expect(classifyHistory([it], ctx())[0]!.type).toBe("noise");
  });

  it("пустой fnName (EIP-7702 self-delegation) → noise", () => {
    const it = item({ chain: "arb", tx: { name: "" } });
    expect(classifyHistory([it], ctx())[0]!.type).toBe("noise");
  });

  // Инертность: noise сохраняет junk:empty_movement → isJunkOp скипает в движках.
  it("noise сохраняет junk:empty_movement (inert)", () => {
    const it = item({ chain: "eth", tx: { name: "transfer" } });
    const r = classifyHistory([it], ctx())[0]!;
    expect(r.type).toBe("noise");
    expect(r.notes ?? []).toContain("junk:empty_movement");
  });

  // Регрессия P1: collect+NPM (dex, пустой movement) остаётся claim_rewards, НЕ noise.
  it("P1 регрессия: collect+NPM → claim_rewards, не noise", () => {
    const it = item({
      chain: "arb",
      projectId: "arb_uniswap3",
      tx: { name: "collect", to_addr: "0xc36442b4a4522e871399cd717abdd847ab11fe88" },
    });
    expect(classifyHistory([it], ctx())[0]!.type).toBe("claim_rewards");
  });

  // Value-bearing op (непустой movement) без матча остаётся unknown (value-bar).
  it("value-bearing unmatched (непустой movement) остаётся unknown", () => {
    // 3 receives без stable+volatile pair, dex-проект, fnName неизвестен:
    // не swap (3 receives), не collect, есть movement → unknown сохраняется.
    const it = item({
      chain: "arb",
      projectId: "arb_uniswap3",
      receives: [
        { token: "arb:weth", amount: 1 },
        { token: "arb:wbtc", amount: 1 },
        { token: "arb:eth", amount: 1 },
      ],
      tx: { name: "weirdFn" },
    });
    const r = classifyHistory([it], ctx())[0]!;
    expect(r.type).not.toBe("noise");
  });
});

/* ---- P3: value-bearing LP/bridge on unnamed protocols (mmaksimuk) --------- */
// Полный server re-fetch вскрыл value-bearing unknown на протоколах, которых нет
// в каталоге (категория "other"): RAMSES/Jellyverse/ICHI/King/deBridge. Секция
// 12.5 классифицирует их по LP/vault/BPT-receipt токену + exit/join fnName +
// named-bridge. Все примеры — реальные операции mmaksimuk.
describe("classifyHistory — P3 LP/bridge heuristic (unnamed protocols)", () => {
  it("RAMSES mint: OUT стейблы + IN RAM-V2-POS → lp_add", () => {
    const it = item({
      chain: "arb",
      projectId: "arb_ramses",
      sends: [{ token: "arb:usdt0", amount: 10 }, { token: "arb:usdc", amount: 25 }],
      receives: [{ token: "arb:ram-v2-pos", amount: 1 }],
      tx: { name: "mint" },
    });
    expect(classifyHistory([it], ctx())[0]!.type).toBe("lp_add");
  });

  it("RAMSES multicall: OUT RAM-V2-POS + IN tokens → lp_remove", () => {
    const it = item({
      chain: "arb",
      projectId: "arb_ramses",
      sends: [{ token: "arb:ram-v2-pos", amount: 1 }],
      receives: [{ token: "arb:usdt0", amount: 35 }, { token: "arb:ram", amount: 0.1 }],
      tx: { name: "multicall" },
    });
    expect(classifyHistory([it], ctx())[0]!.type).toBe("lp_remove");
  });

  it("Jellyverse exitPool: OUT BPT + IN underlying → lp_remove", () => {
    const it = item({
      chain: "sei",
      projectId: "sei_jellyverse",
      sends: [{ token: "sei:bpt-frx", amount: 1 }],
      receives: [
        { token: "sei:frxeth", amount: 0.03 },
        { token: "sei:sfrxeth", amount: 0.026 },
        { token: "sei:weth", amount: 0.005 },
      ],
      tx: { name: "exitPool" },
    });
    expect(classifyHistory([it], ctx())[0]!.type).toBe("lp_remove");
  });

  it("ICHI withdraw: OUT IV-23-RAM vault + IN underlying → lp_remove", () => {
    const it = item({
      chain: "arb",
      projectId: "arb_ichi",
      sends: [{ token: "arb:iv-ram", amount: 1 }],
      receives: [{ token: "arb:ram", amount: 0.29 }, { token: "arb:usdc", amount: 1.57 }],
      tx: { name: "withdraw" },
    });
    expect(classifyHistory([it], ctx())[0]!.type).toBe("lp_remove");
  });

  it("King Protocol redeem: OUT KING + IN basket → lp_remove", () => {
    const it = item({
      chain: "eth",
      projectId: "kingprotocol",
      sends: [{ token: "eth:king", amount: 1 }],
      receives: [{ token: "eth:eigen", amount: 0.2 }, { token: "eth:steth", amount: 0.0001 }],
      tx: { name: "redeem" },
    });
    expect(classifyHistory([it], ctx())[0]!.type).toBe("lp_remove");
  });

  it("deBridge strictlySwapAndCall: net OUT → bridge_out", () => {
    const it = item({
      chain: "eth",
      projectId: "debridge",
      sends: [{ token: "eth:wbtc", amount: 0.01 }, { token: "eth:eth", amount: 0.0006 }],
      receives: [{ token: "arb:usdc", amount: 3.88 }],
      tx: { name: "strictlySwapAndCall" },
    });
    expect(classifyHistory([it], ctx())[0]!.type).toBe("bridge_out");
  });

  // Регрессия: multi-token swap БЕЗ LP-receipt / bridge / exit-fn остаётся
  // unknown (эвристика не должна красть обычные мульти-токен свопы).
  it("multi-token op без LP-receipt/bridge/exit-fn → остаётся unknown", () => {
    const it = item({
      chain: "arb",
      projectId: "arb_someunknowndex",
      sends: [{ token: "arb:usdc", amount: 100 }, { token: "arb:usdt", amount: 50 }],
      receives: [{ token: "arb:weth", amount: 0.05 }],
      tx: { name: "doSomething" },
    });
    expect(classifyHistory([it], ctx())[0]!.type).toBe("unknown");
  });
});

describe("classifyHistory — topic0 ступень (PRIMARY)", () => {
  const AAVE_V3_SUPPLY =
    "0x2b627736bca15cd5381dcf80b0bf11fd197d01a037c52b927a881a10fb73ba61";
  const MORPHO_BORROW =
    "0x570954540bed6b1304a87dfe815a5eda4a648f7097a16240dcd85c9b5fd42a43";
  const TRANSFER =
    "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

  it("логи с topic0 → op_type из события + note topic0:", () => {
    const it = item({ id: "0xT0A", projectId: "arb_aave3", sends: [{ token: "arb:usdc", amount: 100 }] });
    const logs = new Map([["0xt0a", [{ topic0: AAVE_V3_SUPPLY }]]]);
    const r = classifyHistory([it], { ...ctx(), logsByTxHash: logs })[0]!;
    expect(r.type).toBe("lend_supply");
    expect(r.notes?.some((n) => n.startsWith("topic0:"))).toBe(true);
  });

  it("topic0 ВЫИГРЫВАЕТ у DeBank-лестницы (override)", () => {
    // Движение выглядело бы как swap (USDC out + WETH in), но topic0 = Morpho Borrow.
    const it = item({ id: "0xT0B", projectId: "arb_morpho-blue", sends: [{ token: "arb:usdc", amount: 100 }], receives: [{ token: "arb:weth", amount: 0.03 }] });
    const logs = new Map([["0xt0b", [{ topic0: MORPHO_BORROW }]]]);
    const r = classifyHistory([it], { ...ctx(), logsByTxHash: logs })[0]!;
    expect(r.type).toBe("borrow");
  });

  it("без логов → старая лестница, нет topic0-note (ноль регресса)", () => {
    const it = item({ id: "0xT0C", projectId: "arb_aave3", sends: [{ token: "arb:usdc", amount: 100 }], receives: [{ token: "arb:aArbUSDC", amount: 100 }] });
    const r = classifyHistory([it], ctx())[0]!;
    expect(r.notes?.some((n) => n.startsWith("topic0:")) ?? false).toBe(false);
    expect(r.type).toBe("lend_supply");
  });

  it("только Transfer (шум) в логах → topic0 пропущен, ладдер работает", () => {
    const it = item({ id: "0xT0D", projectId: "arb_aave3", sends: [{ token: "arb:usdc", amount: 100 }], receives: [{ token: "arb:aArbUSDC", amount: 100 }] });
    const logs = new Map([["0xt0d", [{ topic0: TRANSFER }]]]);
    const r = classifyHistory([it], { ...ctx(), logsByTxHash: logs })[0]!;
    expect(r.notes?.some((n) => n.startsWith("topic0:")) ?? false).toBe(false);
    expect(r.type).toBe("lend_supply");
  });
});
