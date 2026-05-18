/**
 * UCB A2: тесты server-side cross-chain matcher'а. Каноны:
 *   - Same-wallet bridges НЕ матчатся (`o.walletId === in.walletId`).
 *   - Tx_hash equality skip (L1 territory).
 *   - Time window ±60min строго.
 *   - Amount tolerance: 5% volatile, 10% stable.
 *   - tokenFamily: USDT0 ≡ USDT, WETH ≡ ETH.
 */
import { describe, expect, it } from "vitest";

import {
  detectSelfBridgeCycles,
  extractMovements,
  matchCrossChainPairs,
  tokenFamily,
  type MovementRow,
} from "./internal-transfer-matcher.js";

const t = (iso: string): number => Math.floor(new Date(iso).getTime() / 1000);

function mov(args: Partial<MovementRow> & {
  walletId: string;
  direction: "in" | "out";
  symbol: string;
  amount: number;
  opTimeSec?: number;
}): MovementRow {
  return {
    walletId: args.walletId,
    chain: args.chain ?? "eth",
    txHash: args.txHash ?? `0x${Math.random().toString(16).slice(2)}`,
    opType: args.opType ?? (args.direction === "in" ? "bridge_in" : "bridge_out"),
    opTimeSec: args.opTimeSec ?? t("2026-01-01T00:00:00Z"),
    direction: args.direction,
    symbol: args.symbol,
    amount: args.amount,
    usdPerUnit: args.usdPerUnit ?? null,
    raw: args.raw ?? {},
  };
}

describe("tokenFamily — normalization", () => {
  it("USDT0 / USD₮0 → USDT", () => {
    expect(tokenFamily("USDT0")).toBe("USDT");
    expect(tokenFamily("USD₮0")).toBe("USDT");
    expect(tokenFamily("USDC.E")).toBe("USDC");
  });

  it("WETH → ETH, WBTC → BTC, WSOL → SOL", () => {
    expect(tokenFamily("WETH")).toBe("ETH");
    expect(tokenFamily("WBTC")).toBe("BTC");
    expect(tokenFamily("WSOL")).toBe("SOL");
  });

  it("empty input → empty string", () => {
    expect(tokenFamily("")).toBe("");
  });
});

describe("extractMovements — JSONB raw → flat rows", () => {
  it("вытаскивает in/out с правильными полями", () => {
    const rows = [
      {
        walletId: "w1",
        chain: "eth",
        txHash: "0xabc",
        opType: "bridge_out",
        opTime: new Date("2026-01-01T00:00:00Z"),
        raw: {
          movement: [
            { direction: "out", symbol: "USDT", amount: 1000, usd: 1000 },
          ],
        },
      },
    ];
    const m = extractMovements(rows);
    expect(m).toHaveLength(1);
    expect(m[0]?.direction).toBe("out");
    expect(m[0]?.amount).toBe(1000);
    expect(m[0]?.usdPerUnit).toBe(1); // 1000 USD / 1000 amount
    expect(m[0]?.symbol).toBe("USDT");
  });

  it("пропускает movements с invalid amount или missing direction", () => {
    const rows = [
      {
        walletId: "w1",
        chain: "eth",
        txHash: "0x1",
        opType: "x",
        opTime: new Date(),
        raw: {
          movement: [
            { direction: "out", symbol: "USDT", amount: 0 }, // amount 0
            { direction: "x", symbol: "USDT", amount: 100 }, // bad direction
            { symbol: "USDT", amount: 100 }, // missing direction
            { direction: "in", symbol: "", amount: 100 }, // empty symbol
            { direction: "in", symbol: "USDT", amount: 50 }, // VALID
          ],
        },
      },
    ];
    const m = extractMovements(rows);
    expect(m).toHaveLength(1);
    expect(m[0]?.amount).toBe(50);
  });
});

describe("matchCrossChainPairs — L2 heuristic", () => {
  it("матчит cross-chain cross-wallet pair (USDT eth → arb)", () => {
    const out = mov({
      walletId: "w1",
      chain: "eth",
      txHash: "0xout",
      direction: "out",
      symbol: "USDT",
      amount: 1000,
      opTimeSec: t("2026-01-01T12:00:00Z"),
    });
    const inn = mov({
      walletId: "w2",
      chain: "arb",
      txHash: "0xin",
      direction: "in",
      symbol: "USDT",
      amount: 998, // ±0.2%
      opTimeSec: t("2026-01-01T12:05:00Z"), // +5min
    });
    const pairs = matchCrossChainPairs([out, inn]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]?.outChain).toBe("eth");
    expect(pairs[0]?.inChain).toBe("arb");
    expect(pairs[0]?.outWalletId).toBe("w1");
    expect(pairs[0]?.inWalletId).toBe("w2");
  });

  it("матчит USDT ↔ USD₮0 через token family", () => {
    const out = mov({
      walletId: "w1",
      direction: "out",
      symbol: "USDT",
      amount: 500,
    });
    const inn = mov({
      walletId: "w2",
      direction: "in",
      symbol: "USD₮0", // unicode-T суффикс 0
      amount: 495,
    });
    const pairs = matchCrossChainPairs([out, inn]);
    expect(pairs).toHaveLength(1);
  });

  it("матчит WETH → ETH через family", () => {
    const out = mov({
      walletId: "w1",
      direction: "out",
      symbol: "WETH",
      amount: 1.0,
    });
    const inn = mov({
      walletId: "w2",
      direction: "in",
      symbol: "ETH",
      amount: 0.99,
    });
    const pairs = matchCrossChainPairs([out, inn]);
    expect(pairs).toHaveLength(1);
  });

  it("НЕ матчит same-wallet (это classifier territory, не cross-wallet)", () => {
    const out = mov({
      walletId: "w1",
      direction: "out",
      symbol: "USDT",
      amount: 100,
    });
    const inn = mov({
      walletId: "w1", // SAME wallet
      direction: "in",
      symbol: "USDT",
      amount: 99,
    });
    expect(matchCrossChainPairs([out, inn])).toHaveLength(0);
  });

  it("НЕ матчит tx_hash equality (L1 уже покрыл)", () => {
    const out = mov({
      walletId: "w1",
      direction: "out",
      symbol: "USDT",
      amount: 100,
      txHash: "0xsame",
    });
    const inn = mov({
      walletId: "w2",
      direction: "in",
      symbol: "USDT",
      amount: 99,
      txHash: "0xsame", // L1 case
    });
    expect(matchCrossChainPairs([out, inn])).toHaveLength(0);
  });

  it("НЕ матчит за пределами ±60min", () => {
    const out = mov({
      walletId: "w1",
      direction: "out",
      symbol: "USDT",
      amount: 100,
      opTimeSec: t("2026-01-01T00:00:00Z"),
    });
    const inn = mov({
      walletId: "w2",
      direction: "in",
      symbol: "USDT",
      amount: 99,
      opTimeSec: t("2026-01-01T02:00:00Z"), // +2h
    });
    expect(matchCrossChainPairs([out, inn])).toHaveLength(0);
  });

  it("волатильный токен: ±5% tolerance", () => {
    const out = mov({
      walletId: "w1",
      direction: "out",
      symbol: "ETH",
      amount: 1.0,
    });
    // 4% diff — должен матчить
    const inOk = mov({
      walletId: "w2",
      direction: "in",
      symbol: "ETH",
      amount: 0.96,
    });
    expect(matchCrossChainPairs([out, inOk])).toHaveLength(1);

    // 6% diff — НЕ матчит
    const inFail = mov({
      walletId: "w2",
      direction: "in",
      symbol: "ETH",
      amount: 0.94,
      txHash: "0xdiff",
    });
    const out2 = mov({
      walletId: "w1",
      direction: "out",
      symbol: "ETH",
      amount: 1.0,
      txHash: "0xout2",
    });
    expect(matchCrossChainPairs([out2, inFail])).toHaveLength(0);
  });

  it("стейбл-токен: ±10% tolerance (учитывает большие bridge fees)", () => {
    const out = mov({
      walletId: "w1",
      direction: "out",
      symbol: "USDC",
      amount: 1000,
    });
    // 8% diff — НЕ матчит для volatile, но для stable должен
    const inn = mov({
      walletId: "w2",
      direction: "in",
      symbol: "USDC",
      amount: 920,
    });
    expect(matchCrossChainPairs([out, inn])).toHaveLength(1);
  });

  it("один out пэйрит только с одной in (нет дублей)", () => {
    const out = mov({
      walletId: "w1",
      direction: "out",
      symbol: "USDT",
      amount: 100,
      txHash: "0xout1",
    });
    const in1 = mov({
      walletId: "w2",
      direction: "in",
      symbol: "USDT",
      amount: 99,
      txHash: "0xin1",
      opTimeSec: t("2026-01-01T00:00:00Z"),
    });
    const in2 = mov({
      walletId: "w3",
      direction: "in",
      symbol: "USDT",
      amount: 100,
      txHash: "0xin2",
      opTimeSec: t("2026-01-01T00:10:00Z"),
    });
    // Оба IN валидны по window/amount → но out возьмётся только одной
    const pairs = matchCrossChainPairs([out, in1, in2]);
    expect(pairs).toHaveLength(1);
  });

  it("fee рассчитывается через usdPerUnit", () => {
    const out = mov({
      walletId: "w1",
      direction: "out",
      symbol: "USDT",
      amount: 1000,
      usdPerUnit: 1.0,
    });
    const inn = mov({
      walletId: "w2",
      direction: "in",
      symbol: "USDT",
      amount: 985, // bridge "съел" 15 USDT
    });
    const pairs = matchCrossChainPairs([out, inn]);
    expect(pairs[0]?.feeUsd).toBeCloseTo(15, 1);
  });
});

// ─── UCB A5: cycle-detection tests ─────────────────────────────────────

describe("detectSelfBridgeCycles — A→B→A self-bridge loops", () => {
  it("пустой input → пустой output", () => {
    expect(detectSelfBridgeCycles([])).toEqual([]);
  });

  it("один pair без обратного → не цикл", () => {
    const pairs = matchCrossChainPairs([
      mov({
        walletId: "w1",
        direction: "out",
        symbol: "ETH",
        amount: 1,
        opTimeSec: t("2026-01-01T00:00:00Z"),
        usdPerUnit: 3000,
      }),
      mov({
        walletId: "w2",
        direction: "in",
        symbol: "ETH",
        amount: 0.99,
        opTimeSec: t("2026-01-01T00:10:00Z"),
      }),
    ]);
    expect(detectSelfBridgeCycles(pairs)).toEqual([]);
  });

  it("A→B затем B→A в течение 7d → cycle detected", () => {
    const pairs = matchCrossChainPairs([
      // Leg A: w1 → w2 (ETH 1.0 → 0.99)
      mov({
        walletId: "w1",
        chain: "eth",
        direction: "out",
        symbol: "ETH",
        amount: 1.0,
        txHash: "0xa_out",
        opTimeSec: t("2026-01-01T00:00:00Z"),
        usdPerUnit: 3000,
      }),
      mov({
        walletId: "w2",
        chain: "arb",
        direction: "in",
        symbol: "ETH",
        amount: 0.99,
        txHash: "0xa_in",
        opTimeSec: t("2026-01-01T00:10:00Z"),
      }),
      // Leg B: w2 → w1 (ETH 0.5 → 0.495) через 3 дня
      mov({
        walletId: "w2",
        chain: "arb",
        direction: "out",
        symbol: "ETH",
        amount: 0.5,
        txHash: "0xb_out",
        opTimeSec: t("2026-01-04T00:00:00Z"),
        usdPerUnit: 3000,
      }),
      mov({
        walletId: "w1",
        chain: "eth",
        direction: "in",
        symbol: "ETH",
        amount: 0.495,
        txHash: "0xb_in",
        opTimeSec: t("2026-01-04T00:10:00Z"),
      }),
    ]);
    expect(pairs).toHaveLength(2);
    const cycles = detectSelfBridgeCycles(pairs);
    expect(cycles).toHaveLength(1);
    const c = cycles[0]!;
    expect(c.originWalletId).toBe("w1");
    expect(c.hopWalletId).toBe("w2");
    expect(c.family).toBe("ETH");
    expect(c.legA.outTxHash).toBe("0xa_out");
    expect(c.legB.outTxHash).toBe("0xb_out");
    // Fee A = (1 - 0.99) × 3000 = 30, Fee B = (0.5 - 0.495) × 3000 = 15. Sum=45
    expect(c.totalFeeUsd).toBeCloseTo(45, 1);
    // Duration: 3 days + 10 min
    expect(c.durationSec).toBeGreaterThan(3 * 24 * 60 * 60);
  });

  it("A→B затем B→A через >7d → НЕ cycle", () => {
    const pairs = matchCrossChainPairs([
      mov({
        walletId: "w1",
        direction: "out",
        symbol: "USDT",
        amount: 1000,
        txHash: "0xa_out",
        opTimeSec: t("2026-01-01T00:00:00Z"),
        usdPerUnit: 1,
      }),
      mov({
        walletId: "w2",
        direction: "in",
        symbol: "USDT",
        amount: 998,
        txHash: "0xa_in",
        opTimeSec: t("2026-01-01T00:10:00Z"),
      }),
      // Возврат через 10 дней — слишком поздно
      mov({
        walletId: "w2",
        direction: "out",
        symbol: "USDT",
        amount: 1000,
        txHash: "0xb_out",
        opTimeSec: t("2026-01-11T00:00:00Z"),
        usdPerUnit: 1,
      }),
      mov({
        walletId: "w1",
        direction: "in",
        symbol: "USDT",
        amount: 998,
        txHash: "0xb_in",
        opTimeSec: t("2026-01-11T00:10:00Z"),
      }),
    ]);
    expect(detectSelfBridgeCycles(pairs)).toEqual([]);
  });

  it("две независимые петли — обе detected", () => {
    const pairs = matchCrossChainPairs([
      // Cycle 1: w1 ⟷ w2 ETH
      mov({
        walletId: "w1",
        direction: "out",
        symbol: "ETH",
        amount: 1,
        txHash: "0x1a_out",
        opTimeSec: t("2026-01-01T00:00:00Z"),
        usdPerUnit: 3000,
      }),
      mov({
        walletId: "w2",
        direction: "in",
        symbol: "ETH",
        amount: 0.99,
        txHash: "0x1a_in",
        opTimeSec: t("2026-01-01T00:10:00Z"),
      }),
      mov({
        walletId: "w2",
        direction: "out",
        symbol: "ETH",
        amount: 0.5,
        txHash: "0x1b_out",
        opTimeSec: t("2026-01-02T00:00:00Z"),
        usdPerUnit: 3000,
      }),
      mov({
        walletId: "w1",
        direction: "in",
        symbol: "ETH",
        amount: 0.495,
        txHash: "0x1b_in",
        opTimeSec: t("2026-01-02T00:10:00Z"),
      }),
      // Cycle 2: w3 ⟷ w4 USDT
      mov({
        walletId: "w3",
        direction: "out",
        symbol: "USDT",
        amount: 1000,
        txHash: "0x2a_out",
        opTimeSec: t("2026-01-03T00:00:00Z"),
        usdPerUnit: 1,
      }),
      mov({
        walletId: "w4",
        direction: "in",
        symbol: "USDT",
        amount: 998,
        txHash: "0x2a_in",
        opTimeSec: t("2026-01-03T00:10:00Z"),
      }),
      mov({
        walletId: "w4",
        direction: "out",
        symbol: "USDT",
        amount: 500,
        txHash: "0x2b_out",
        opTimeSec: t("2026-01-05T00:00:00Z"),
        usdPerUnit: 1,
      }),
      mov({
        walletId: "w3",
        direction: "in",
        symbol: "USDT",
        amount: 499,
        txHash: "0x2b_in",
        opTimeSec: t("2026-01-05T00:10:00Z"),
      }),
    ]);
    const cycles = detectSelfBridgeCycles(pairs);
    expect(cycles).toHaveLength(2);
    expect(cycles.map((c) => c.family).sort()).toEqual(["ETH", "USDT"]);
  });

  it("A→B + A→B (два out того же направления, без возврата) → 0 cycles", () => {
    const pairs = matchCrossChainPairs([
      mov({
        walletId: "w1",
        direction: "out",
        symbol: "USDT",
        amount: 1000,
        txHash: "0x1_out",
        opTimeSec: t("2026-01-01T00:00:00Z"),
        usdPerUnit: 1,
      }),
      mov({
        walletId: "w2",
        direction: "in",
        symbol: "USDT",
        amount: 998,
        txHash: "0x1_in",
        opTimeSec: t("2026-01-01T00:10:00Z"),
      }),
      mov({
        walletId: "w1",
        direction: "out",
        symbol: "USDT",
        amount: 500,
        txHash: "0x2_out",
        opTimeSec: t("2026-01-02T00:00:00Z"),
        usdPerUnit: 1,
      }),
      mov({
        walletId: "w2",
        direction: "in",
        symbol: "USDT",
        amount: 499,
        txHash: "0x2_in",
        opTimeSec: t("2026-01-02T00:10:00Z"),
      }),
    ]);
    expect(pairs).toHaveLength(2);
    expect(detectSelfBridgeCycles(pairs)).toEqual([]);
  });

  it("greedy: legA уже used — НЕ матчится с следующим возможным legB", () => {
    // Cycle 1 consumes legB; subsequent matching не должен пытаться
    // переиспользовать legA или legB.
    const pairs = matchCrossChainPairs([
      mov({
        walletId: "w1",
        direction: "out",
        symbol: "ETH",
        amount: 1,
        txHash: "0xa_out",
        opTimeSec: t("2026-01-01T00:00:00Z"),
        usdPerUnit: 3000,
      }),
      mov({
        walletId: "w2",
        direction: "in",
        symbol: "ETH",
        amount: 0.99,
        txHash: "0xa_in",
        opTimeSec: t("2026-01-01T00:10:00Z"),
      }),
      mov({
        walletId: "w2",
        direction: "out",
        symbol: "ETH",
        amount: 0.5,
        txHash: "0xb_out",
        opTimeSec: t("2026-01-02T00:00:00Z"),
        usdPerUnit: 3000,
      }),
      mov({
        walletId: "w1",
        direction: "in",
        symbol: "ETH",
        amount: 0.495,
        txHash: "0xb_in",
        opTimeSec: t("2026-01-02T00:10:00Z"),
      }),
    ]);
    // Запускаем дважды — результаты идентичны (idempotency).
    const c1 = detectSelfBridgeCycles(pairs);
    const c2 = detectSelfBridgeCycles(pairs);
    expect(c1).toHaveLength(1);
    expect(c2).toHaveLength(1);
    expect(c1[0]?.legA.outTxHash).toBe(c2[0]?.legA.outTxHash);
  });
});
