import { describe, expect, it } from "vitest";

import { classifyJunk, isJunkOp, junkReason } from "./junk_filter.js";
import type { ClassifiedOp, OpType, TokenMovement } from "./types.js";

/** Test helper — build a minimal ClassifiedOp. */
function op(partial: Partial<ClassifiedOp> & { type: OpType }): ClassifiedOp {
  return {
    seq: 0,
    hash: "0xtest",
    chain: "eth",
    time: 1_700_000_000_000,
    status: "ok",
    protocol: null,
    movement: [],
    netUsd: 0,
    gasUsd: null,
    counterparty: null,
    feePayer: null,
    fnName: null,
    approveSpender: null,
    approveSymbol: null,
    ...partial,
  };
}

function mv(
  direction: "in" | "out",
  symbol: string,
  amount: number,
  usd: number | null
): TokenMovement {
  return {
    direction,
    symbol,
    tokenId: `id-${symbol}`,
    amount,
    usd,
    isStable: false,
    isProtocolToken: false,
  };
}

describe("classifyJunk — failed tx handling", () => {
  it("tags mev_failure when failed tx burned real gas (> $0.01)", () => {
    const tags = classifyJunk(
      op({ type: "failed", status: "failed", gasUsd: 5 })
    );
    expect(tags).toEqual(["junk:mev_failure"]);
  });

  it("tags plain failed when gasUsd ≈ 0", () => {
    expect(
      classifyJunk(op({ type: "failed", status: "failed", gasUsd: 0 }))
    ).toEqual(["junk:failed"]);
    expect(
      classifyJunk(op({ type: "failed", status: "failed", gasUsd: null }))
    ).toEqual(["junk:failed"]);
    expect(
      classifyJunk(op({ type: "failed", status: "failed", gasUsd: 0.005 }))
    ).toEqual(["junk:failed"]);
  });

  it("failed tx short-circuits — does not also tag dust/scam", () => {
    const tags = classifyJunk(
      op({
        type: "failed",
        status: "failed",
        gasUsd: 2,
        movement: [mv("in", "SCAM.io", 100, 0)],
      })
    );
    expect(tags).toEqual(["junk:mev_failure"]);
  });
});

describe("classifyJunk — empty/dust", () => {
  it("tags empty_movement when movement is empty (and not approve/failed)", () => {
    const tags = classifyJunk(op({ type: "unknown", movement: [] }));
    expect(tags).toContain("junk:empty_movement");
  });

  it("does NOT tag empty_movement for approve ops", () => {
    expect(classifyJunk(op({ type: "approve", movement: [] }))).not.toContain(
      "junk:empty_movement"
    );
  });

  it("tags dust when all movements are < $0.50", () => {
    const tags = classifyJunk(
      op({
        type: "swap",
        movement: [mv("in", "ETH", 0.0001, 0.3), mv("out", "USDC", 0.4, 0.4)],
      })
    );
    expect(tags).toContain("junk:dust");
  });

  it("does NOT tag dust when any movement is ≥ $0.50", () => {
    const tags = classifyJunk(
      op({
        type: "swap",
        movement: [mv("in", "ETH", 1, 1000), mv("out", "USDC", 0.4, 0.4)],
      })
    );
    expect(tags).not.toContain("junk:dust");
  });

  it("does NOT tag dust for transfer_in / transfer_out / approve", () => {
    const small = [mv("in", "USDC", 0.1, 0.1)];
    expect(
      classifyJunk(op({ type: "transfer_in", movement: small }))
    ).not.toContain("junk:dust");
    expect(
      classifyJunk(op({ type: "transfer_out", movement: small }))
    ).not.toContain("junk:dust");
    expect(
      classifyJunk(op({ type: "approve", movement: small }))
    ).not.toContain("junk:dust");
  });
});

describe("classifyJunk — scam airdrop", () => {
  it("tags scam_airdrop for receive-only transfer_in with suspicious symbol", () => {
    const tags = classifyJunk(
      op({
        type: "transfer_in",
        movement: [mv("in", "Claim at xyz.io", 1_000_000, null)],
      })
    );
    expect(tags).toContain("junk:scam_airdrop");
  });

  it.each([
    "xyz.io",
    "claim me",
    "visit foo",
    "voucher",
    "$BONK Reward",
    "https://scam.com",
    "www.spam.org",
    "ABCDEFGHIJKLMNOPQRSTUV",
  ])("scam pattern: %s", (sym) => {
    const tags = classifyJunk(
      op({
        type: "transfer_in",
        movement: [mv("in", sym, 1, null)],
      })
    );
    expect(tags).toContain("junk:scam_airdrop");
  });

  it("does NOT tag known legitimate airdrops", () => {
    for (const sym of ["LDO", "ARB", "OP", "JTO", "JUP", "ZK"]) {
      const tags = classifyJunk(
        op({
          type: "transfer_in",
          movement: [mv("in", sym, 100, 200)],
        })
      );
      expect(tags).not.toContain("junk:scam_airdrop");
    }
  });

  it("does NOT tag scam if op has outgoing legs (it was a swap, not an airdrop)", () => {
    const tags = classifyJunk(
      op({
        type: "swap",
        movement: [
          mv("in", "xyz.io", 1_000_000, null),
          mv("out", "ETH", 0.1, 200),
        ],
      })
    );
    expect(tags).not.toContain("junk:scam_airdrop");
  });

  it("does NOT tag stablecoins as scam even with weird symbols", () => {
    const tags = classifyJunk(
      op({
        type: "transfer_in",
        movement: [mv("in", "USDC", 1000, 1000)],
      })
    );
    expect(tags).not.toContain("junk:scam_airdrop");
  });

  it("does NOT tag when only some received tokens are suspicious", () => {
    const tags = classifyJunk(
      op({
        type: "transfer_in",
        movement: [
          mv("in", "claim.io", 1, null),
          mv("in", "ETH", 0.1, 200),
        ],
      })
    );
    expect(tags).not.toContain("junk:scam_airdrop");
  });
});

describe("classifyJunk — unknown_phantom", () => {
  it("tags phantom for receive-only unknown op with all receives at usd ≈ 0", () => {
    const tags = classifyJunk(
      op({
        type: "unknown",
        movement: [mv("in", "WEIRDTOKEN", 1, 0)],
      })
    );
    expect(tags).toContain("junk:unknown_phantom");
  });

  it("does NOT tag phantom when a stable is among receives", () => {
    const tags = classifyJunk(
      op({
        type: "unknown",
        movement: [mv("in", "USDC", 100, 0)],
      })
    );
    expect(tags).not.toContain("junk:unknown_phantom");
  });

  it("does NOT tag phantom if scam_airdrop was already tagged (no double tagging)", () => {
    const tags = classifyJunk(
      op({
        type: "unknown",
        movement: [mv("in", "xyz.io", 1, 0)],
      })
    );
    expect(tags).toContain("junk:scam_airdrop");
    expect(tags).not.toContain("junk:unknown_phantom");
  });

  it("does NOT tag phantom when op has outgoing legs", () => {
    const tags = classifyJunk(
      op({
        type: "unknown",
        movement: [mv("in", "X", 1, 0), mv("out", "ETH", 0.01, 20)],
      })
    );
    expect(tags).not.toContain("junk:unknown_phantom");
  });
});

describe("isJunkOp", () => {
  it("returns false for op without notes", () => {
    expect(isJunkOp(op({ type: "swap" }))).toBe(false);
  });

  it("returns false when notes have no junk prefix", () => {
    expect(isJunkOp(op({ type: "swap", notes: ["info:ok"] }))).toBe(false);
  });

  it("returns true when any note starts with junk:", () => {
    expect(isJunkOp(op({ type: "swap", notes: ["junk:dust"] }))).toBe(true);
    expect(
      isJunkOp(op({ type: "swap", notes: ["info:x", "junk:dust"] }))
    ).toBe(true);
  });
});

describe("junkReason", () => {
  it("returns null when not junk", () => {
    expect(junkReason(op({ type: "swap" }))).toBeNull();
    expect(junkReason(op({ type: "swap", notes: ["info:x"] }))).toBeNull();
  });

  it.each([
    ["junk:scam_airdrop", "Спам-airdrop от неизвестного протокола"],
    ["junk:dust", "Все движения < $0.50"],
    ["junk:mev_failure", "Failed tx с потерянным газом"],
    ["junk:failed", "Failed tx (газ ≈ $0)"],
    ["junk:unknown_phantom", "Получение токенов с USD-ценой ≈ $0"],
  ])("known tag %s → human reason", (tag, expected) => {
    expect(junkReason(op({ type: "swap", notes: [tag] }))).toBe(expected);
  });

  it("returns suffix for unknown junk: tags", () => {
    expect(
      junkReason(op({ type: "swap", notes: ["junk:custom_tag"] }))
    ).toBe("custom_tag");
  });
});
