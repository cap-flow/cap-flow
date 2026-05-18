/**
 * UCB C2 S1: tests for `detectCexHopChains`.
 *
 * Хоп цепь = (CEX A withdrawal txA) → on-chain wallet W receives → W sends
 * → (CEX B deposit txB).
 *
 * Input: уже-связанные пары:
 *   - inboundFromCex: on-chain transfer_in whose tx_hash matches a CEX withdrawal
 *   - outboundToCex:  on-chain transfer_out whose tx_hash matches a CEX deposit
 *
 * Output: hop-chains, where inbound и outbound через ТОТ ЖЕ wallet, в окне ±30d,
 * того же token family. Cost basis chain: CEX A → wallet → CEX B.
 */
import { describe, expect, it } from "vitest";

import {
  detectCexHopChains,
  type CexHopInboundRow,
  type CexHopOutboundRow,
} from "./cex-hop-detector.js";

const t = (iso: string): number => Math.floor(new Date(iso).getTime() / 1000);

function inbound(args: Partial<CexHopInboundRow> & {
  walletId: string;
  txHash: string;
  symbol: string;
  amount: number;
  timeSec: number;
}): CexHopInboundRow {
  return {
    walletId: args.walletId,
    chain: args.chain ?? "eth",
    txHash: args.txHash,
    symbol: args.symbol,
    amount: args.amount,
    timeSec: args.timeSec,
    cexAccountId: args.cexAccountId ?? "cexA",
    cexExchange: args.cexExchange ?? "binance",
  };
}

function outbound(args: Partial<CexHopOutboundRow> & {
  walletId: string;
  txHash: string;
  symbol: string;
  amount: number;
  timeSec: number;
}): CexHopOutboundRow {
  return {
    walletId: args.walletId,
    chain: args.chain ?? "eth",
    txHash: args.txHash,
    symbol: args.symbol,
    amount: args.amount,
    timeSec: args.timeSec,
    cexAccountId: args.cexAccountId ?? "cexB",
    cexExchange: args.cexExchange ?? "bybit",
  };
}

describe("detectCexHopChains — UCB C2 S1", () => {
  it("empty input → empty output", () => {
    expect(detectCexHopChains([], [])).toEqual([]);
  });

  it("базовая цепь: CEX A wd → wallet receives → wallet sends → CEX B deposit", () => {
    const inb = inbound({
      walletId: "w1",
      txHash: "0xfromA",
      symbol: "BTC",
      amount: 1,
      timeSec: t("2026-01-01T00:00:00Z"),
      cexAccountId: "accA",
      cexExchange: "binance",
    });
    const out = outbound({
      walletId: "w1",
      txHash: "0xtoB",
      symbol: "BTC",
      amount: 0.99,
      timeSec: t("2026-01-02T00:00:00Z"),
      cexAccountId: "accB",
      cexExchange: "bybit",
    });
    const chains = detectCexHopChains([inb], [out]);
    expect(chains).toHaveLength(1);
    const c = chains[0]!;
    expect(c.walletId).toBe("w1");
    expect(c.fromCex.cexAccountId).toBe("accA");
    expect(c.toCex.cexAccountId).toBe("accB");
    expect(c.inboundTxHash).toBe("0xfromA");
    expect(c.outboundTxHash).toBe("0xtoB");
    expect(c.family).toBe("BTC");
    expect(c.durationSec).toBe(24 * 60 * 60);
  });

  it("разные wallets — НЕ цепь", () => {
    const inb = inbound({
      walletId: "w1",
      txHash: "0xfromA",
      symbol: "BTC",
      amount: 1,
      timeSec: t("2026-01-01T00:00:00Z"),
    });
    const out = outbound({
      walletId: "w2", // другой wallet
      txHash: "0xtoB",
      symbol: "BTC",
      amount: 0.99,
      timeSec: t("2026-01-02T00:00:00Z"),
    });
    expect(detectCexHopChains([inb], [out])).toEqual([]);
  });

  it("разные families — НЕ цепь", () => {
    const inb = inbound({
      walletId: "w1",
      txHash: "0xfromA",
      symbol: "BTC",
      amount: 1,
      timeSec: t("2026-01-01T00:00:00Z"),
    });
    const out = outbound({
      walletId: "w1",
      txHash: "0xtoB",
      symbol: "ETH",
      amount: 5,
      timeSec: t("2026-01-02T00:00:00Z"),
    });
    expect(detectCexHopChains([inb], [out])).toEqual([]);
  });

  it("WETH ↔ ETH через family — есть цепь", () => {
    const inb = inbound({
      walletId: "w1",
      txHash: "0xfromA",
      symbol: "ETH",
      amount: 1,
      timeSec: t("2026-01-01T00:00:00Z"),
    });
    const out = outbound({
      walletId: "w1",
      txHash: "0xtoB",
      symbol: "WETH", // wrapped same family
      amount: 0.99,
      timeSec: t("2026-01-02T00:00:00Z"),
    });
    const chains = detectCexHopChains([inb], [out]);
    expect(chains).toHaveLength(1);
    expect(chains[0]?.family).toBe("ETH");
  });

  it("outbound ДО inbound — НЕ цепь (нелогичный порядок)", () => {
    const inb = inbound({
      walletId: "w1",
      txHash: "0xfromA",
      symbol: "BTC",
      amount: 1,
      timeSec: t("2026-01-05T00:00:00Z"),
    });
    const out = outbound({
      walletId: "w1",
      txHash: "0xtoB",
      symbol: "BTC",
      amount: 0.99,
      timeSec: t("2026-01-01T00:00:00Z"), // ДО inbound
    });
    expect(detectCexHopChains([inb], [out])).toEqual([]);
  });

  it("окно > 30 дней — НЕ цепь", () => {
    const inb = inbound({
      walletId: "w1",
      txHash: "0xfromA",
      symbol: "BTC",
      amount: 1,
      timeSec: t("2026-01-01T00:00:00Z"),
    });
    const out = outbound({
      walletId: "w1",
      txHash: "0xtoB",
      symbol: "BTC",
      amount: 0.99,
      timeSec: t("2026-02-05T00:00:00Z"), // +35 дней
    });
    expect(detectCexHopChains([inb], [out])).toEqual([]);
  });

  it("multiple chains: каждая inbound пэйрит с earliest matching outbound", () => {
    // inb1 @ day 1, inb2 @ day 5 (one wallet w1)
    // out1 @ day 3, out2 @ day 7
    // greedy chronological: inb1 → out1, inb2 → out2
    const inb1 = inbound({
      walletId: "w1",
      txHash: "0xinb1",
      symbol: "BTC",
      amount: 1,
      timeSec: t("2026-01-01T00:00:00Z"),
    });
    const inb2 = inbound({
      walletId: "w1",
      txHash: "0xinb2",
      symbol: "BTC",
      amount: 2,
      timeSec: t("2026-01-05T00:00:00Z"),
    });
    const out1 = outbound({
      walletId: "w1",
      txHash: "0xout1",
      symbol: "BTC",
      amount: 0.99,
      timeSec: t("2026-01-03T00:00:00Z"),
    });
    const out2 = outbound({
      walletId: "w1",
      txHash: "0xout2",
      symbol: "BTC",
      amount: 1.95,
      timeSec: t("2026-01-07T00:00:00Z"),
    });
    const chains = detectCexHopChains([inb1, inb2], [out1, out2]);
    expect(chains).toHaveLength(2);
    expect(chains.map((c) => c.inboundTxHash).sort()).toEqual([
      "0xinb1",
      "0xinb2",
    ]);
  });

  it("один outbound матчит только одну inbound (greedy, no double-use)", () => {
    const inb1 = inbound({
      walletId: "w1",
      txHash: "0xinb1",
      symbol: "BTC",
      amount: 1,
      timeSec: t("2026-01-01T00:00:00Z"),
    });
    const inb2 = inbound({
      walletId: "w1",
      txHash: "0xinb2",
      symbol: "BTC",
      amount: 1,
      timeSec: t("2026-01-02T00:00:00Z"),
    });
    const out1 = outbound({
      walletId: "w1",
      txHash: "0xout1",
      symbol: "BTC",
      amount: 0.99,
      timeSec: t("2026-01-03T00:00:00Z"),
    });
    const chains = detectCexHopChains([inb1, inb2], [out1]);
    // inb1 paired (earliest), inb2 без пары
    expect(chains).toHaveLength(1);
    expect(chains[0]?.inboundTxHash).toBe("0xinb1");
  });

  it("idempotent: повторный вызов даёт тот же результат", () => {
    const inb = inbound({
      walletId: "w1",
      txHash: "0xfromA",
      symbol: "BTC",
      amount: 1,
      timeSec: t("2026-01-01T00:00:00Z"),
    });
    const out = outbound({
      walletId: "w1",
      txHash: "0xtoB",
      symbol: "BTC",
      amount: 0.99,
      timeSec: t("2026-01-02T00:00:00Z"),
    });
    const a = detectCexHopChains([inb], [out]);
    const b = detectCexHopChains([inb], [out]);
    expect(a).toEqual(b);
  });
});
