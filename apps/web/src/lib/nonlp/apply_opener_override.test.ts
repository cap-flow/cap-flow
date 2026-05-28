import { describe, expect, it } from "vitest";

import type { OpenPosition } from "../portfolio/open_positions";
import type { NonLpOpener } from "./opener_detector";
import { applyNonLpOpenerOverride } from "./apply_opener_override";
import { nonLpOpenerKey } from "./use_opener_detector";

const NOW = Date.now() / 1000;
const OCT_2025 = 1760606147; // 16.10.2025 (Lombard real date)
const RECEIPT = "0x5401b8620e5fb570064ca9114fd1e135fd77d57c";
const WALLET = "0x10b850c3abfca78d693c9cd6fce809c129109d1c";
const WALLET_MAP = new Map([["w1", WALLET]]);

function pos(args: {
  id: string;
  openedAt?: number | null;
  protoName?: string;
  startUsd?: number;
  feesUsd?: number | null;
  feesLifetimeUsd?: number;
  lpTokenId?: string | null;
}): OpenPosition {
  return {
    id: args.id,
    walletId: "w1",
    walletName: "main",
    walletChain: "evm",
    chain: "eth",
    protocol: { id: "lombard", name: args.protoName ?? "Lombard" } as OpenPosition["protocol"],
    kind: "yield" as OpenPosition["kind"],
    itemName: "Yield",
    openedAt: args.openedAt ?? null,
    openHash: null,
    ageDays: null,
    supplyTokens: [],
    debtTokens: [],
    openedInTokens: [],
    startUsd: args.startUsd ?? 522.74,
    netStartUsd: args.startUsd ?? 522.74,
    currentUsd: 522.74,
    currentDebtUsd: 0,
    healthRate: null,
    feesUsd: args.feesUsd ?? null,
    feesSource: null,
    feesClaimedUsd: 0,
    feesLifetimeUsd: args.feesLifetimeUsd ?? 0,
    feeApr: null,
    feeAprLifetime: null,
    feesClaimedHistory: [],
    feesByToken: [],
    creditFundedUsd: 0,
    ...(args.lpTokenId === null ? {} : { lpTokenId: args.lpTokenId ?? RECEIPT }),
  } as OpenPosition;
}

function opener(openedAt: number, startUsd: number | null = null): NonLpOpener {
  return {
    openedAt,
    openBlock: 23589271,
    txHash: "0x9de7baf4",
    receiptAmount: 0.00696635,
    openedInTokens: [],
    startUsd,
  };
}

/** Build opener Map keyed by stable key (chain=eth, RECEIPT, WALLET). */
function openerMap(openedAt: number): Map<string, NonLpOpener> {
  return new Map([[nonLpOpenerKey("eth", RECEIPT, WALLET), opener(openedAt)]]);
}

function openerMapWithStart(
  openedAt: number,
  startUsd: number,
): Map<string, NonLpOpener> {
  return new Map([
    [nonLpOpenerKey("eth", RECEIPT, WALLET), opener(openedAt, startUsd)],
  ]);
}

describe("applyNonLpOpenerOverride", () => {
  it("проставляет openedAt + ageDays для позиции без даты", () => {
    const out = applyNonLpOpenerOverride(
      [pos({ id: "POS-017", openedAt: null })],
      openerMap(OCT_2025),
      WALLET_MAP,
    );
    expect(out.overriddenCount).toBe(1);
    expect(out.positions[0]!.openedAt).toBe(OCT_2025);
    expect(out.positions[0]!.ageDays).toBeGreaterThan(0);
    expect(out.positions[0]!.openHash).toBe("0x9de7baf4");
  });

  it("НЕ перетирает существующую дату (guard)", () => {
    const existing = 1700000000;
    const out = applyNonLpOpenerOverride(
      [pos({ id: "POS-X", openedAt: existing })],
      openerMap(OCT_2025),
      WALLET_MAP,
    );
    expect(out.overriddenCount).toBe(0);
    expect(out.positions[0]!.openedAt).toBe(existing);
  });

  it("НЕ трогает V3 LP позиции (guard — у них Krystal источник)", () => {
    const out = applyNonLpOpenerOverride(
      [pos({ id: "POS-V3", openedAt: null, protoName: "Uniswap V3" })],
      openerMap(OCT_2025),
      WALLET_MAP,
    );
    expect(out.overriddenCount).toBe(0);
    expect(out.positions[0]!.openedAt).toBeNull();
  });

  it("НЕ трогает позицию без lpTokenId (нечем построить ключ)", () => {
    const out = applyNonLpOpenerOverride(
      [pos({ id: "POS-NL", openedAt: null, lpTokenId: null })],
      openerMap(OCT_2025),
      WALLET_MAP,
    );
    expect(out.overriddenCount).toBe(0);
    expect(out.positions[0]!.openedAt).toBeNull();
  });

  it("НЕ трогает если wallet не в walletAddressById", () => {
    const out = applyNonLpOpenerOverride(
      [pos({ id: "POS-NW", openedAt: null })],
      openerMap(OCT_2025),
      new Map(), // пустой wallet map
    );
    expect(out.overriddenCount).toBe(0);
  });

  it("пересчитывает feeApr когда появился ageDays", () => {
    const out = applyNonLpOpenerOverride(
      [pos({ id: "POS-F", openedAt: null, startUsd: 1000, feesUsd: 50, feesLifetimeUsd: 50 })],
      openerMap(NOW - 365 * 86400), // ровно 1 год назад
      WALLET_MAP,
    );
    const p = out.positions[0]!;
    // feeApr = 50/1000 × 365/365 × 100 = 5%
    expect(p.feeApr).toBeCloseTo(5, 0);
    expect(p.feeAprLifetime).toBeCloseTo(5, 0);
  });

  it("startUsd НЕ меняется когда opener.startUsd=null (Stage 1 path)", () => {
    const out = applyNonLpOpenerOverride(
      [pos({ id: "POS-S", openedAt: null, startUsd: 522.74 })],
      openerMap(OCT_2025), // startUsd=null
      WALLET_MAP,
    );
    expect(out.positions[0]!.startUsd).toBe(522.74);
  });

  it("Stage 2a: opener.startUsd (OUT-side stable) → перетирает startUsd + PnL", () => {
    // IPOR-like: position fallback startUsd=104.44 (=current), opener даёт
    // реальные $100 из OUT-side USDC.
    const out = applyNonLpOpenerOverride(
      [pos({ id: "POS-IPOR", openedAt: null, startUsd: 104.44 })],
      openerMapWithStart(OCT_2025, 100),
      WALLET_MAP,
    );
    const p = out.positions[0]!;
    expect(p.startUsd).toBe(100);
    expect(p.netStartUsd).toBe(100);
    // currentUsd в pos() = 522.74 (default). netPnl = 522.74 − 100.
    expect(p.netPnlUsd).toBeCloseTo(522.74 - 100, 2);
    expect(p.netPnlPct).toBeCloseTo(((522.74 - 100) / 100) * 100, 1);
  });

  it("Stage 2a: opener.startUsd=0 → НЕ перетирает (защита от валидного нуля)", () => {
    const out = applyNonLpOpenerOverride(
      [pos({ id: "POS-Z2", openedAt: null, startUsd: 50 })],
      openerMapWithStart(OCT_2025, 0),
      WALLET_MAP,
    );
    expect(out.positions[0]!.startUsd).toBe(50);
  });

  it("отклоняет невалидный timestamp (в будущем)", () => {
    const future = NOW + 86400 * 30;
    const out = applyNonLpOpenerOverride(
      [pos({ id: "POS-FUT", openedAt: null })],
      openerMap(future),
      WALLET_MAP,
    );
    expect(out.overriddenCount).toBe(0);
    expect(out.positions[0]!.openedAt).toBeNull();
  });

  it("отклоняет openedAt = 0", () => {
    const out = applyNonLpOpenerOverride(
      [pos({ id: "POS-Z", openedAt: null })],
      openerMap(0),
      WALLET_MAP,
    );
    expect(out.overriddenCount).toBe(0);
  });

  it("позиция без opener в Map не трогается", () => {
    // POS-A имеет дефолтный receipt (в Map), POS-B — другой receipt (нет в Map)
    const out = applyNonLpOpenerOverride(
      [
        pos({ id: "POS-A", openedAt: null }),
        pos({ id: "POS-B", openedAt: null, lpTokenId: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }),
      ],
      openerMap(OCT_2025),
      WALLET_MAP,
    );
    expect(out.overriddenCount).toBe(1);
    expect(out.positions[0]!.openedAt).toBe(OCT_2025);
    expect(out.positions[1]!.openedAt).toBeNull();
  });

  it("пустой opener Map → no-op", () => {
    const positions = [pos({ id: "POS-A", openedAt: null })];
    const out = applyNonLpOpenerOverride(positions, new Map(), WALLET_MAP);
    expect(out.overriddenCount).toBe(0);
    expect(out.positions).toEqual(positions);
  });

  it("ageDays округляется до 0.1", () => {
    const out = applyNonLpOpenerOverride(
      [pos({ id: "POS-R", openedAt: null })],
      openerMap(NOW - 100.567 * 86400),
      WALLET_MAP,
    );
    const age = out.positions[0]!.ageDays!;
    expect(age).toBe(Math.round(age * 10) / 10);
  });
});
