/**
 * UCB Bob-test fix #4: tests for `detectUntrackedDestinations`.
 *
 * Pure function: input — list of CEX withdrawals (with tx_hash) + Set
 * of on-chain hashes the user has в connected wallets. Output —
 * withdrawals чьи tx_hashes НЕ tracked в любом wallet.
 *
 * Use case: user видит "27 of your 41 CEX withdrawals went to addresses
 * НЕ tracked here. Connect cold wallet to follow cost basis through them."
 */
import { describe, expect, it } from "vitest";

import {
  detectUntrackedDestinations,
  type WithdrawalRow,
} from "./untracked-destinations.js";

function wd(args: {
  txHash: string;
  asset: string;
  amount?: number;
  exchange?: string;
  executedAt?: Date;
}): WithdrawalRow {
  return {
    txHash: args.txHash,
    asset: args.asset,
    amount: args.amount ?? 1,
    exchange: args.exchange ?? "bingx",
    executedAt: args.executedAt ?? new Date("2026-01-01"),
  };
}

describe("detectUntrackedDestinations — UCB Bob-test fix #4", () => {
  it("empty → empty", () => {
    expect(detectUntrackedDestinations([], new Set())).toEqual([]);
  });

  it("all withdrawals tracked on-chain → empty result", () => {
    const wds = [
      wd({ txHash: "0xaaa", asset: "ETH" }),
      wd({ txHash: "0xbbb", asset: "BTC" }),
    ];
    const tracked = new Set(["0xaaa", "0xbbb"]);
    expect(detectUntrackedDestinations(wds, tracked)).toEqual([]);
  });

  it("all withdrawals untracked → returns all", () => {
    const wds = [
      wd({ txHash: "0xaaa", asset: "ETH" }),
      wd({ txHash: "0xbbb", asset: "BTC" }),
    ];
    expect(detectUntrackedDestinations(wds, new Set())).toHaveLength(2);
  });

  it("partial tracking: only untracked returned", () => {
    const wds = [
      wd({ txHash: "0xaaa", asset: "ETH" }),
      wd({ txHash: "0xbbb", asset: "BTC" }),
      wd({ txHash: "0xccc", asset: "LTC" }),
    ];
    const tracked = new Set(["0xaaa"]);
    const out = detectUntrackedDestinations(wds, tracked);
    expect(out).toHaveLength(2);
    expect(out.map((w) => w.txHash).sort()).toEqual(["0xbbb", "0xccc"]);
  });

  it("hash normalization: tracked set uppercase, withdrawal lowercase → match", () => {
    const wds = [wd({ txHash: "0xABC", asset: "ETH" })];
    const tracked = new Set(["0xabc"]);
    expect(detectUntrackedDestinations(wds, tracked)).toEqual([]);
  });

  it("hash normalization: withdrawal uppercase, tracked lowercase → match", () => {
    const wds = [wd({ txHash: "0xabc", asset: "ETH" })];
    const tracked = new Set(["0xABC"]);
    expect(detectUntrackedDestinations(wds, tracked)).toEqual([]);
  });

  it("withdrawals without txHash skipped (cannot match anything)", () => {
    const wds: WithdrawalRow[] = [
      { ...wd({ txHash: "", asset: "ETH" }), txHash: "" as unknown as string },
    ];
    expect(detectUntrackedDestinations(wds, new Set())).toEqual([]);
  });

  it("Bob scenario: 41 wds, 14 matched → 27 untracked", () => {
    const tracked = new Set(
      Array.from({ length: 14 }, (_, i) => `0xtracked${i}`),
    );
    const wds: WithdrawalRow[] = [
      ...Array.from({ length: 14 }, (_, i) =>
        wd({ txHash: `0xtracked${i}`, asset: "USDT" }),
      ),
      ...Array.from({ length: 27 }, (_, i) =>
        wd({ txHash: `0xexternal${i}`, asset: "USDT" }),
      ),
    ];
    expect(detectUntrackedDestinations(wds, tracked)).toHaveLength(27);
  });

  it("sorted: newest first", () => {
    const wds = [
      wd({ txHash: "0xa", asset: "ETH", executedAt: new Date("2026-01-01") }),
      wd({ txHash: "0xb", asset: "ETH", executedAt: new Date("2026-03-01") }),
      wd({ txHash: "0xc", asset: "ETH", executedAt: new Date("2026-02-01") }),
    ];
    const out = detectUntrackedDestinations(wds, new Set());
    expect(out.map((w) => w.txHash)).toEqual(["0xb", "0xc", "0xa"]);
  });
});
