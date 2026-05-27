/**
 * Tests for block timestamp → block number estimation.
 *
 * Не тестируем `getCurrentBlockNumber` (RPC call) — это integration.
 * Тестируем pure `estimateBlockAtTimestamp` logic.
 */

import { describe, expect, it } from "vitest";

import { estimateBlockAtTimestamp } from "./block_estimation";

describe("estimateBlockAtTimestamp", () => {
  it("BASE chain: 1 час назад → ~1800 блоков назад + safety margin", () => {
    const nowSec = 1779853000;
    const oneHourAgo = nowSec - 3600;
    const currentBlock = 10_000_000n;
    const result = estimateBlockAtTimestamp({
      chainCode: "base",
      currentBlock,
      targetTimestampSec: oneHourAgo,
      nowSec,
    });
    // 3600 sec / 2 sec per block = 1800 blocks ago + 1800 safety margin
    // = currentBlock - 1800 - 1800 = 9,996,400
    expect(result).toBe(9_996_400n);
  });

  it("ETH chain: 1 час назад → ~300 блоков", () => {
    const nowSec = 1779853000;
    const oneHourAgo = nowSec - 3600;
    const currentBlock = 20_000_000n;
    const result = estimateBlockAtTimestamp({
      chainCode: "eth",
      currentBlock,
      targetTimestampSec: oneHourAgo,
      nowSec,
    });
    // 3600 / 12 = 300 blocks ago + 300 safety margin = 19,999,400
    expect(result).toBe(19_999_400n);
  });

  it("ARB chain: 1 минута назад → ~240 блоков (4 blocks/sec)", () => {
    const nowSec = 1779853000;
    const oneMinAgo = nowSec - 60;
    const currentBlock = 300_000_000n;
    const result = estimateBlockAtTimestamp({
      chainCode: "arb",
      currentBlock,
      targetTimestampSec: oneMinAgo,
      nowSec,
    });
    // 60 / 0.25 = 240 blocks + 14400 safety margin = 299,985,360
    expect(result).toBe(299_985_360n);
  });

  it("VolnyySanya POS-001 (BASE, openedTime=1776443737)", () => {
    // openedTime 1776443737 = 2026-04-17 16:35 UTC
    // nowSec 1779850000 = 2026-05-27 ~04:00 UTC
    // 39.5 days = 3,406,263 sec → 1,703,131 blocks @ 2sec/block + 1800 margin
    // = currentBlock - 1,704,931
    const nowSec = 1779850000;
    const currentBlock = 31_000_000n;
    const result = estimateBlockAtTimestamp({
      chainCode: "base",
      currentBlock,
      targetTimestampSec: 1776443737,
      nowSec,
    });
    expect(result).toBe(31_000_000n - 1_703_131n - 1800n);
    // Range ≈ 1.7M blocks. At chunked 10 blocks per call = 170K calls.
    // Still a lot but better than 31M from earliest. Practically:
    // chunked queries with this fromBlock complete in ~30 минут.
    // For instant result needs Alchemy PAYG.
  });

  it("targetTimestamp в будущем → null", () => {
    const nowSec = 1779853000;
    const future = nowSec + 1000;
    const currentBlock = 10_000_000n;
    expect(
      estimateBlockAtTimestamp({
        chainCode: "base",
        currentBlock,
        targetTimestampSec: future,
        nowSec,
      }),
    ).toBeNull();
  });

  it("Unknown chain code → null", () => {
    expect(
      estimateBlockAtTimestamp({
        chainCode: "unknown_chain",
        currentBlock: 1000n,
        targetTimestampSec: 1779000000,
      }),
    ).toBeNull();
  });

  it("targetTimestamp <= 0 → null", () => {
    expect(
      estimateBlockAtTimestamp({
        chainCode: "base",
        currentBlock: 1000n,
        targetTimestampSec: 0,
      }),
    ).toBeNull();
  });

  it("result clamped to >= 1n (когда estimate отрицательный)", () => {
    // very old timestamp + small currentBlock → estimate goes negative
    const result = estimateBlockAtTimestamp({
      chainCode: "base",
      currentBlock: 100n,
      targetTimestampSec: 1000000, // far in past
      nowSec: 1779853000,
    });
    expect(result).toBe(1n);
  });

  it("case-insensitive chain code", () => {
    const nowSec = 1779853000;
    const result1 = estimateBlockAtTimestamp({
      chainCode: "BASE",
      currentBlock: 10_000_000n,
      targetTimestampSec: nowSec - 3600,
      nowSec,
    });
    const result2 = estimateBlockAtTimestamp({
      chainCode: "base",
      currentBlock: 10_000_000n,
      targetTimestampSec: nowSec - 3600,
      nowSec,
    });
    expect(result1).toBe(result2);
  });
});
