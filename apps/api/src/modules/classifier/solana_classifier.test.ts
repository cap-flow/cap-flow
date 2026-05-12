import { describe, expect, it } from "vitest";

import { classifyHeliusHistory } from "./solana_classifier.js";
import type { HeliusTransaction } from "./helius_types.js";

const SELF = "SelfWalletAddress1111111111111111111111111";
const OTHER_OWN = "OtherOwnAddress1111111111111111111111111111";
const EXTERNAL = "ExternalCounterparty11111111111111111111111";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDT_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const SOL_MINT = "So11111111111111111111111111111111111111112";
const JLP_MINT = "27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4";
const JITOSOL_MINT = "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn";
const BINANCE_SOL_ADDR = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

interface BuildOpts {
  signature?: string;
  timestamp?: number;
  type?: string;
  source?: string;
  error?: boolean;
  native?: Array<{ from: string; to: string; amount: number }>;
  spl?: Array<{ from: string; to: string; mint: string; amount: number }>;
  feePayer?: string;
}

function tx(o: BuildOpts = {}): HeliusTransaction {
  return {
    signature: o.signature ?? "sig" + Math.random().toString(36).slice(2),
    timestamp: o.timestamp ?? 1_700_000_000,
    type: o.type ?? "TRANSFER",
    source: o.source ?? "SYSTEM_PROGRAM",
    slot: 1,
    fee: 5000,
    feePayer: o.feePayer ?? SELF,
    transactionError: o.error ? { error: "x" } : null,
    nativeTransfers: (o.native ?? []).map((n) => ({
      fromUserAccount: n.from,
      toUserAccount: n.to,
      amount: n.amount,
    })),
    tokenTransfers: (o.spl ?? []).map((t) => ({
      fromUserAccount: t.from,
      toUserAccount: t.to,
      mint: t.mint,
      tokenAmount: t.amount,
    })),
  };
}

function ctx(extras: { ownAddresses?: string[] } = {}) {
  return {
    selfAddress: SELF,
    ownAddresses: new Set([SELF, ...(extras.ownAddresses ?? [])]),
  };
}

describe("classifyHeliusHistory — sort & dedupe", () => {
  it("dedupes by signature, sorts ascending by timestamp", () => {
    const a = tx({ signature: "A", timestamp: 200 });
    const b = tx({ signature: "B", timestamp: 100 });
    const dup = tx({ signature: "A", timestamp: 200 });
    const r = classifyHeliusHistory([a, b, dup], ctx());
    expect(r).toHaveLength(2);
    expect(r[0]!.hash).toBe("B");
    expect(r[1]!.hash).toBe("A");
    expect(r[0]!.seq).toBe(1);
    expect(r[1]!.seq).toBe(2);
  });
});

describe("classifyHeliusHistory — failed", () => {
  it("transactionError set → type=failed", () => {
    const r = classifyHeliusHistory(
      [tx({ error: true, type: "SWAP", source: "JUPITER" })],
      ctx()
    )[0]!;
    expect(r.type).toBe("failed");
    expect(r.status).toBe("failed");
  });
});

describe("classifyHeliusHistory — CEX", () => {
  it("incoming from Binance address → deposit_fiat", () => {
    const t = tx({
      spl: [
        { from: BINANCE_SOL_ADDR, to: SELF, mint: USDC_MINT, amount: 1000 },
      ],
    });
    const r = classifyHeliusHistory([t], ctx())[0]!;
    expect(r.type).toBe("deposit_fiat");
    expect(r.notes ?? []).toContain("from CEX: Binance");
  });

  it("outgoing to Binance → withdraw_fiat", () => {
    const t = tx({
      spl: [
        { from: SELF, to: BINANCE_SOL_ADDR, mint: USDC_MINT, amount: 100 },
      ],
    });
    const r = classifyHeliusHistory([t], ctx())[0]!;
    expect(r.type).toBe("withdraw_fiat");
  });
});

describe("classifyHeliusHistory — internal transfers", () => {
  it("send to own wallet (no protocol) → transfer_out", () => {
    const t = tx({
      spl: [{ from: SELF, to: OTHER_OWN, mint: USDC_MINT, amount: 100 }],
    });
    const r = classifyHeliusHistory(
      [t],
      ctx({ ownAddresses: [OTHER_OWN] })
    )[0]!;
    expect(r.type).toBe("transfer_out");
  });

  it("receive from own wallet → transfer_in", () => {
    const t = tx({
      spl: [{ from: OTHER_OWN, to: SELF, mint: USDC_MINT, amount: 100 }],
    });
    const r = classifyHeliusHistory(
      [t],
      ctx({ ownAddresses: [OTHER_OWN] })
    )[0]!;
    expect(r.type).toBe("transfer_in");
  });
});

describe("classifyHeliusHistory — Helius type dispatch", () => {
  it("type=SWAP → swap (with default DEX if source unknown)", () => {
    const t = tx({
      type: "SWAP",
      source: "JUPITER",
      spl: [
        { from: SELF, to: EXTERNAL, mint: USDC_MINT, amount: 100 },
        { from: EXTERNAL, to: SELF, mint: JITOSOL_MINT, amount: 0.6 },
      ],
    });
    const r = classifyHeliusHistory([t], ctx())[0]!;
    expect(r.type).toBe("swap");
    expect(r.protocol?.name).toBe("Jupiter");
  });

  it("type=STAKE_SOL → stake", () => {
    const t = tx({
      type: "STAKE_SOL",
      source: "MARINADE_FINANCE",
      native: [{ from: SELF, to: EXTERNAL, amount: 1_000_000_000 }],
    });
    expect(classifyHeliusHistory([t], ctx())[0]!.type).toBe("stake");
  });

  it("type=DEPOSIT in lending source → lend_supply", () => {
    const t = tx({
      type: "DEPOSIT",
      source: "KAMINO",
      spl: [{ from: SELF, to: EXTERNAL, mint: USDC_MINT, amount: 100 }],
    });
    expect(classifyHeliusHistory([t], ctx())[0]!.type).toBe("lend_supply");
  });

  it("type=DEPOSIT in non-lending source → lp_add", () => {
    const t = tx({
      type: "DEPOSIT",
      source: "FLASH_TRADE",
      spl: [{ from: SELF, to: EXTERNAL, mint: USDC_MINT, amount: 100 }],
    });
    expect(classifyHeliusHistory([t], ctx())[0]!.type).toBe("lp_add");
  });

  it("type=WITHDRAW in lending source → lend_withdraw", () => {
    const t = tx({
      type: "WITHDRAW",
      source: "KAMINO",
      spl: [{ from: EXTERNAL, to: SELF, mint: USDC_MINT, amount: 100 }],
    });
    expect(classifyHeliusHistory([t], ctx())[0]!.type).toBe("lend_withdraw");
  });

  it("type=WITHDRAW in non-lending → unstake", () => {
    const t = tx({
      type: "WITHDRAW",
      source: "MARINADE_FINANCE",
      spl: [{ from: EXTERNAL, to: SELF, mint: SOL_MINT, amount: 0.5 }],
    });
    expect(classifyHeliusHistory([t], ctx())[0]!.type).toBe("unstake");
  });

  it("type=BORROW → borrow", () => {
    const t = tx({
      type: "BORROW",
      source: "KAMINO",
      spl: [{ from: EXTERNAL, to: SELF, mint: USDC_MINT, amount: 500 }],
    });
    expect(classifyHeliusHistory([t], ctx())[0]!.type).toBe("borrow");
  });

  it("type=REPAY / REPAY_LOAN → repay", () => {
    const t = tx({
      type: "REPAY_LOAN",
      source: "SOLEND",
      spl: [{ from: SELF, to: EXTERNAL, mint: USDC_MINT, amount: 100 }],
    });
    expect(classifyHeliusHistory([t], ctx())[0]!.type).toBe("repay");
  });

  it("type=ADD_LIQUIDITY / REMOVE_LIQUIDITY", () => {
    const add = tx({
      type: "ADD_LIQUIDITY",
      source: "ORCA",
      spl: [{ from: SELF, to: EXTERNAL, mint: USDC_MINT, amount: 100 }],
    });
    expect(classifyHeliusHistory([add], ctx())[0]!.type).toBe("lp_add");
    const remove = tx({
      type: "REMOVE_LIQUIDITY",
      source: "ORCA",
      spl: [{ from: EXTERNAL, to: SELF, mint: USDC_MINT, amount: 100 }],
    });
    expect(classifyHeliusHistory([remove], ctx())[0]!.type).toBe("lp_remove");
  });

  it.each(["CLAIM_REWARDS", "CLAIM", "CLAIM_TOKEN", "REWARD_CANCELED"])(
    "type=%s → claim_rewards",
    (type) => {
      const t = tx({
        type,
        source: "JITO",
        spl: [{ from: EXTERNAL, to: SELF, mint: USDC_MINT, amount: 1 }],
      });
      expect(classifyHeliusHistory([t], ctx())[0]!.type).toBe("claim_rewards");
    }
  );
});

describe("classifyHeliusHistory — movement heuristics fallback", () => {
  it("lending source + receives-only (no Helius type) → borrow", () => {
    const t = tx({
      type: "UNKNOWN",
      source: "SOLEND",
      spl: [{ from: EXTERNAL, to: SELF, mint: USDC_MINT, amount: 500 }],
    });
    expect(classifyHeliusHistory([t], ctx())[0]!.type).toBe("borrow");
  });

  it("lending source + sends-only → repay", () => {
    const t = tx({
      type: "UNKNOWN",
      source: "SOLEND",
      spl: [{ from: SELF, to: EXTERNAL, mint: USDC_MINT, amount: 100 }],
    });
    expect(classifyHeliusHistory([t], ctx())[0]!.type).toBe("repay");
  });

  it("perp source + sends-only → lp_add", () => {
    const t = tx({
      type: "UNKNOWN",
      source: "DRIFT",
      spl: [{ from: SELF, to: EXTERNAL, mint: USDC_MINT, amount: 100 }],
    });
    expect(classifyHeliusHistory([t], ctx())[0]!.type).toBe("lp_add");
  });

  it("bridge source + sends-only → bridge_out", () => {
    const t = tx({
      type: "UNKNOWN",
      source: "WORMHOLE",
      spl: [{ from: SELF, to: EXTERNAL, mint: USDC_MINT, amount: 100 }],
    });
    expect(classifyHeliusHistory([t], ctx())[0]!.type).toBe("bridge_out");
  });
});

describe("classifyHeliusHistory — multi-leg swap (Jupiter fees)", () => {
  it("net-balance reveals USDC→SOL swap despite SOL fee legs", () => {
    // -0.001 SOL fee + -0.002 SOL routing + +0.07 SOL output = +0.067 SOL net
    // -100 USDC out = -100 USDC net
    const t = tx({
      type: "UNKNOWN",
      source: "JUPITER",
      native: [
        { from: SELF, to: EXTERNAL, amount: 1_000_000 }, // 0.001 SOL fee
        { from: SELF, to: EXTERNAL, amount: 2_000_000 }, // 0.002 SOL fee
        { from: EXTERNAL, to: SELF, amount: 70_000_000 }, // 0.07 SOL output
      ],
      spl: [{ from: SELF, to: EXTERNAL, mint: USDC_MINT, amount: 100 }],
    });
    const r = classifyHeliusHistory([t], ctx())[0]!;
    expect(r.type).toBe("swap");
    expect(r.detection).toBe("auto");
  });
});

describe("classifyHeliusHistory — plain transfer / unknown", () => {
  it("send to external (no protocol) → transfer_out", () => {
    const t = tx({
      spl: [{ from: SELF, to: EXTERNAL, mint: USDC_MINT, amount: 100 }],
    });
    expect(classifyHeliusHistory([t], ctx())[0]!.type).toBe("transfer_out");
  });

  it("receive from external → transfer_in", () => {
    const t = tx({
      spl: [{ from: EXTERNAL, to: SELF, mint: USDC_MINT, amount: 100 }],
    });
    expect(classifyHeliusHistory([t], ctx())[0]!.type).toBe("transfer_in");
  });

  it("no movement at all → unknown", () => {
    const t = tx({});
    expect(classifyHeliusHistory([t], ctx())[0]!.type).toBe("unknown");
  });
});

describe("classifyHeliusHistory — movement enrichment", () => {
  it("native SOL transfers converted from lamports to SOL", () => {
    const t = tx({
      native: [{ from: SELF, to: EXTERNAL, amount: 1_000_000_000 }],
    });
    const r = classifyHeliusHistory([t], ctx())[0]!;
    const mv = r.movement.find((m) => m.symbol === "SOL");
    expect(mv?.amount).toBeCloseTo(1, 6);
  });

  it("stable mints (USDC) marked isStable=true with usd = amount × 1", () => {
    const t = tx({
      spl: [{ from: SELF, to: EXTERNAL, mint: USDC_MINT, amount: 500 }],
    });
    const r = classifyHeliusHistory([t], ctx())[0]!;
    const usdcMv = r.movement.find((m) => m.tokenId === USDC_MINT)!;
    expect(usdcMv.isStable).toBe(true);
    expect(usdcMv.usd).toBe(500);
  });

  it("JLP recognised by mint, non-stable, no price (unknown without oracle)", () => {
    const t = tx({
      spl: [{ from: SELF, to: EXTERNAL, mint: JLP_MINT, amount: 10 }],
    });
    const r = classifyHeliusHistory([t], ctx())[0]!;
    const jlpMv = r.movement.find((m) => m.tokenId === JLP_MINT)!;
    expect(jlpMv.symbol).toBe("JLP");
    expect(jlpMv.isStable).toBe(false);
    expect(jlpMv.usd).toBeNull();
  });
});

describe("classifyHeliusHistory — base fields", () => {
  it("hash = signature, chain = 'sol', feePayer carried, fnName from description", () => {
    const t = tx({
      signature: "SIG_X",
      feePayer: SELF,
      spl: [{ from: SELF, to: EXTERNAL, mint: USDC_MINT, amount: 100 }],
    });
    t.description = "Sample swap";
    const r = classifyHeliusHistory([t], ctx())[0]!;
    expect(r.hash).toBe("SIG_X");
    expect(r.chain).toBe("sol");
    expect(r.feePayer).toBe(SELF);
    expect(r.fnName).toBe("Sample swap");
  });
});

describe("classifyHeliusHistory — USDT/USDC stable swap via Jupiter", () => {
  it("type=SWAP between two stables → swap with Jupiter protocol", () => {
    const t = tx({
      type: "SWAP",
      source: "JUPITER",
      spl: [
        { from: SELF, to: EXTERNAL, mint: USDC_MINT, amount: 100 },
        { from: EXTERNAL, to: SELF, mint: USDT_MINT, amount: 99.95 },
      ],
    });
    const r = classifyHeliusHistory([t], ctx())[0]!;
    expect(r.type).toBe("swap");
    expect(r.protocol?.id).toBe("JUPITER");
  });
});
