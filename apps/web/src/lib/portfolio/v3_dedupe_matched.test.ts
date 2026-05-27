/**
 * Unit tests для dedupeMatchedV3TokenIds — post-process реассайнмент
 * дублирующихся matchedV3TokenId на sibling NFT'ы в том же пуле.
 *
 * MMaksimuk POS-019/020 — основной case: 2 nearly-identical NFT в одном
 * пуле USDT/SLVon, оба получили matchedV3TokenId=#1220776, после dedup
 * один остаётся #1220776, второй переходит на #1220777.
 */

import { describe, expect, it } from "vitest";

import type { KrystalV3Summary } from "../krystal/adapter";
import type { OpenPosition } from "./open_positions";
import { dedupeMatchedV3TokenIds } from "./v3_dedupe_matched";

function pos(args: {
  id: string;
  matchedV3TokenId?: string;
  walletId?: string;
}): OpenPosition {
  return {
    id: args.id,
    walletId: args.walletId ?? "w1",
    walletName: "main",
    walletChain: "evm",
    chain: "eth",
    protocol: { id: "uniswap3", name: "Uniswap V3" } as OpenPosition["protocol"],
    kind: "lp" as OpenPosition["kind"],
    itemName: "Liquidity Pool",
    openedAt: 1770000000,
    openHash: "0xhash",
    ageDays: 100,
    supplyTokens: [],
    debtTokens: [],
    openedInTokens: [],
    startUsd: 250,
    netStartUsd: 250,
    currentUsd: 240,
    currentDebtUsd: 0,
    healthRate: null,
    feesUsd: 10,
    feesSource: "v3_rewards" as const,
    feesClaimedUsd: 0,
    feesLifetimeUsd: 10,
    feeApr: 12.0,
    feeAprLifetime: 12.0,
    feesClaimedHistory: [],
    feesByToken: [],
    creditFundedUsd: 0,
    ...(args.matchedV3TokenId ? { matchedV3TokenId: args.matchedV3TokenId } : {}),
  } as OpenPosition;
}

function k(args: {
  tokenId: string;
  poolAddress?: string;
  ownerAddress?: string;
  chainCode?: string;
  status?: KrystalV3Summary["status"];
}): KrystalV3Summary {
  return {
    tokenId: args.tokenId,
    chainCode: args.chainCode ?? "eth",
    protocolKey: "uniswapv3",
    pair: ["USDT", "SLVon"] as [string, string],
    status: args.status ?? "IN_RANGE",
    ownerAddress: (args.ownerAddress ?? "0xmaks").toLowerCase(),
    poolAddress: (args.poolAddress ?? "0xpool").toLowerCase(),
    npmAddress: "0xnpm",
    currentUsd: 240,
    currentTokens: [],
    pendingFeeUsd: 0,
    pendingFeeTokens: [],
    claimedFeeUsd: 0,
    claimedFeeTokens: [],
    providedTokens: [],
    openedTime: 1770000000,
    totalDepositValue: 250,
    totalWithdrawValue: 0,
  };
}

describe("dedupeMatchedV3TokenIds", () => {
  it("MMaksimuk POS-019/020: 2 positions с одинаковым tokenId → реассайн на sibling", () => {
    const positions = [
      pos({ id: "POS-019", matchedV3TokenId: "1220776" }),
      pos({ id: "POS-020", matchedV3TokenId: "1220776" }),
    ];
    const krystal = new Map<string, KrystalV3Summary>([
      ["1220776", k({ tokenId: "1220776", poolAddress: "0xpool", ownerAddress: "0xmaks", chainCode: "eth" })],
      ["1220777", k({ tokenId: "1220777", poolAddress: "0xpool", ownerAddress: "0xmaks", chainCode: "eth" })],
    ]);
    const out = dedupeMatchedV3TokenIds(positions, krystal);
    expect(out.reassignedCount).toBe(1);
    expect(out.positions[0]!.matchedV3TokenId).toBe("1220776");
    expect(out.positions[1]!.matchedV3TokenId).toBe("1220777");
    expect(out.warnings).toHaveLength(1);
    expect(out.warnings[0]).toMatch(/POS-020.*1220776.*1220777/);
  });

  it("нет дубликатов — no-op", () => {
    const positions = [
      pos({ id: "POS-A", matchedV3TokenId: "1" }),
      pos({ id: "POS-B", matchedV3TokenId: "2" }),
    ];
    const krystal = new Map<string, KrystalV3Summary>([
      ["1", k({ tokenId: "1" })],
      ["2", k({ tokenId: "2" })],
    ]);
    const out = dedupeMatchedV3TokenIds(positions, krystal);
    expect(out.reassignedCount).toBe(0);
    expect(out.positions[0]!.matchedV3TokenId).toBe("1");
    expect(out.positions[1]!.matchedV3TokenId).toBe("2");
  });

  it("дубль есть, но sibling в Krystal Map отсутствует → silent no-op", () => {
    const positions = [
      pos({ id: "POS-019", matchedV3TokenId: "1220776" }),
      pos({ id: "POS-020", matchedV3TokenId: "1220776" }),
    ];
    // Krystal знает только один NFT в этом пуле — sibling'ов нет
    const krystal = new Map<string, KrystalV3Summary>([
      ["1220776", k({ tokenId: "1220776" })],
    ]);
    const out = dedupeMatchedV3TokenIds(positions, krystal);
    expect(out.reassignedCount).toBe(0);
    expect(out.positions[0]!.matchedV3TokenId).toBe("1220776");
    expect(out.positions[1]!.matchedV3TokenId).toBe("1220776");
  });

  it("sibling в другом пуле — НЕ берётся (только same pool)", () => {
    const positions = [
      pos({ id: "POS-A", matchedV3TokenId: "X" }),
      pos({ id: "POS-B", matchedV3TokenId: "X" }),
    ];
    const krystal = new Map<string, KrystalV3Summary>([
      ["X", k({ tokenId: "X", poolAddress: "0xpoolA" })],
      ["Y", k({ tokenId: "Y", poolAddress: "0xpoolB" })], // другой pool!
    ]);
    const out = dedupeMatchedV3TokenIds(positions, krystal);
    expect(out.reassignedCount).toBe(0);
    expect(out.positions[1]!.matchedV3TokenId).toBe("X");
  });

  it("sibling в другом wallet — НЕ берётся", () => {
    const positions = [
      pos({ id: "POS-A", matchedV3TokenId: "X" }),
      pos({ id: "POS-B", matchedV3TokenId: "X" }),
    ];
    const krystal = new Map<string, KrystalV3Summary>([
      ["X", k({ tokenId: "X", ownerAddress: "0xa" })],
      ["Y", k({ tokenId: "Y", ownerAddress: "0xb" })], // другой owner!
    ]);
    const out = dedupeMatchedV3TokenIds(positions, krystal);
    expect(out.reassignedCount).toBe(0);
  });

  it("CLOSED sibling не используется (только OPEN)", () => {
    const positions = [
      pos({ id: "POS-A", matchedV3TokenId: "X" }),
      pos({ id: "POS-B", matchedV3TokenId: "X" }),
    ];
    const krystal = new Map<string, KrystalV3Summary>([
      ["X", k({ tokenId: "X" })],
      ["Y", k({ tokenId: "Y", status: "CLOSED" })],
    ]);
    const out = dedupeMatchedV3TokenIds(positions, krystal);
    expect(out.reassignedCount).toBe(0);
  });

  it("3 дубликата + 2 sibling'а → реассайнятся 2, третий остаётся с original", () => {
    const positions = [
      pos({ id: "POS-A", matchedV3TokenId: "X" }),
      pos({ id: "POS-B", matchedV3TokenId: "X" }),
      pos({ id: "POS-C", matchedV3TokenId: "X" }),
    ];
    const krystal = new Map<string, KrystalV3Summary>([
      ["X", k({ tokenId: "X" })],
      ["Y", k({ tokenId: "Y" })],
      ["Z", k({ tokenId: "Z" })],
    ]);
    const out = dedupeMatchedV3TokenIds(positions, krystal);
    expect(out.reassignedCount).toBe(2);
    const ids = out.positions.map((p) => p.matchedV3TokenId);
    // Первая остаётся X, остальные получают Y и Z (sorted by index)
    expect(ids[0]).toBe("X");
    expect(new Set(ids).size).toBe(3); // все три разные
  });

  it("4 дубликата + 1 sibling → один реассайнен, два остаются с дублем (degradation OK)", () => {
    const positions = [
      pos({ id: "POS-A", matchedV3TokenId: "X" }),
      pos({ id: "POS-B", matchedV3TokenId: "X" }),
      pos({ id: "POS-C", matchedV3TokenId: "X" }),
    ];
    const krystal = new Map<string, KrystalV3Summary>([
      ["X", k({ tokenId: "X" })],
      ["Y", k({ tokenId: "Y" })],
    ]);
    const out = dedupeMatchedV3TokenIds(positions, krystal);
    expect(out.reassignedCount).toBe(1);
    expect(out.positions[0]!.matchedV3TokenId).toBe("X");
    expect(out.positions[1]!.matchedV3TokenId).toBe("Y");
    expect(out.positions[2]!.matchedV3TokenId).toBe("X"); // degradation OK
  });

  it("positions без matchedV3TokenId не трогаются", () => {
    const positions = [
      pos({ id: "POS-A", matchedV3TokenId: "X" }),
      pos({ id: "POS-B", matchedV3TokenId: "X" }),
      pos({ id: "POS-C" }), // нет matchedV3TokenId
    ];
    const krystal = new Map<string, KrystalV3Summary>([
      ["X", k({ tokenId: "X" })],
      ["Y", k({ tokenId: "Y" })],
    ]);
    const out = dedupeMatchedV3TokenIds(positions, krystal);
    expect(out.reassignedCount).toBe(1);
    expect(out.positions[2]!.matchedV3TokenId).toBeUndefined();
  });

  it("empty Krystal Map → no-op", () => {
    const positions = [pos({ id: "POS-A", matchedV3TokenId: "X" })];
    const out = dedupeMatchedV3TokenIds(positions, new Map());
    expect(out.reassignedCount).toBe(0);
    expect(out.positions).toEqual(positions);
  });

  it("sibling уже используется другой position — не забираем (нельзя сделать новый дубль)", () => {
    const positions = [
      pos({ id: "POS-A", matchedV3TokenId: "X" }),
      pos({ id: "POS-B", matchedV3TokenId: "X" }),
      pos({ id: "POS-C", matchedV3TokenId: "Y" }), // Y уже используется
    ];
    const krystal = new Map<string, KrystalV3Summary>([
      ["X", k({ tokenId: "X" })],
      ["Y", k({ tokenId: "Y" })],
    ]);
    const out = dedupeMatchedV3TokenIds(positions, krystal);
    // POS-A.X, POS-B хотел бы Y но Y занят → остаётся X (degradation)
    expect(out.reassignedCount).toBe(0);
    expect(out.positions[0]!.matchedV3TokenId).toBe("X");
    expect(out.positions[1]!.matchedV3TokenId).toBe("X");
    expect(out.positions[2]!.matchedV3TokenId).toBe("Y");
  });

  it("разные chains: дубль на ETH не подцепит sibling на ARB", () => {
    const positions = [
      pos({ id: "POS-A", matchedV3TokenId: "X" }),
      pos({ id: "POS-B", matchedV3TokenId: "X" }),
    ];
    const krystal = new Map<string, KrystalV3Summary>([
      ["X", k({ tokenId: "X", chainCode: "eth" })],
      ["Y", k({ tokenId: "Y", chainCode: "arb" })],
    ]);
    const out = dedupeMatchedV3TokenIds(positions, krystal);
    expect(out.reassignedCount).toBe(0);
  });
});
