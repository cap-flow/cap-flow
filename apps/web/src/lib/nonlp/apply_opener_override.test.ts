import { describe, expect, it } from "vitest";

import type { OpenPosition } from "../portfolio/open_positions";
import type { NonLpOpener } from "./opener_detector";
import { applyNonLpOpenerOverride } from "./apply_opener_override";

const NOW = Date.now() / 1000;
const OCT_2025 = 1760606147; // 16.10.2025 (Lombard real date)

function pos(args: {
  id: string;
  openedAt?: number | null;
  protoName?: string;
  startUsd?: number;
  feesUsd?: number | null;
  feesLifetimeUsd?: number;
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
  } as OpenPosition;
}

function opener(openedAt: number): NonLpOpener {
  return { openedAt, openBlock: 23589271, txHash: "0x9de7baf4", receiptAmount: 0.00696635 };
}

describe("applyNonLpOpenerOverride", () => {
  it("проставляет openedAt + ageDays для позиции без даты", () => {
    const out = applyNonLpOpenerOverride(
      [pos({ id: "POS-017", openedAt: null })],
      new Map([["POS-017", opener(OCT_2025)]]),
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
      new Map([["POS-X", opener(OCT_2025)]]),
    );
    expect(out.overriddenCount).toBe(0);
    expect(out.positions[0]!.openedAt).toBe(existing);
  });

  it("НЕ трогает V3 LP позиции (guard — у них Krystal источник)", () => {
    const out = applyNonLpOpenerOverride(
      [pos({ id: "POS-V3", openedAt: null, protoName: "Uniswap V3" })],
      new Map([["POS-V3", opener(OCT_2025)]]),
    );
    expect(out.overriddenCount).toBe(0);
    expect(out.positions[0]!.openedAt).toBeNull();
  });

  it("пересчитывает feeApr когда появился ageDays", () => {
    const out = applyNonLpOpenerOverride(
      [pos({ id: "POS-F", openedAt: null, startUsd: 1000, feesUsd: 50, feesLifetimeUsd: 50 })],
      new Map([["POS-F", opener(NOW - 365 * 86400)]]), // ровно 1 год назад
    );
    const p = out.positions[0]!;
    // feeApr = 50/1000 × 365/365 × 100 = 5%
    expect(p.feeApr).toBeCloseTo(5, 0);
    expect(p.feeAprLifetime).toBeCloseTo(5, 0);
  });

  it("startUsd НЕ меняется (Stage 1 scope)", () => {
    const out = applyNonLpOpenerOverride(
      [pos({ id: "POS-S", openedAt: null, startUsd: 522.74 })],
      new Map([["POS-S", opener(OCT_2025)]]),
    );
    expect(out.positions[0]!.startUsd).toBe(522.74);
  });

  it("отклоняет невалидный timestamp (в будущем)", () => {
    const future = NOW + 86400 * 30;
    const out = applyNonLpOpenerOverride(
      [pos({ id: "POS-FUT", openedAt: null })],
      new Map([["POS-FUT", opener(future)]]),
    );
    expect(out.overriddenCount).toBe(0);
    expect(out.positions[0]!.openedAt).toBeNull();
  });

  it("отклоняет openedAt = 0", () => {
    const out = applyNonLpOpenerOverride(
      [pos({ id: "POS-Z", openedAt: null })],
      new Map([["POS-Z", opener(0)]]),
    );
    expect(out.overriddenCount).toBe(0);
  });

  it("позиция без opener в Map не трогается", () => {
    const out = applyNonLpOpenerOverride(
      [pos({ id: "POS-A", openedAt: null }), pos({ id: "POS-B", openedAt: null })],
      new Map([["POS-A", opener(OCT_2025)]]),
    );
    expect(out.overriddenCount).toBe(1);
    expect(out.positions[0]!.openedAt).toBe(OCT_2025);
    expect(out.positions[1]!.openedAt).toBeNull();
  });

  it("пустой opener Map → no-op", () => {
    const positions = [pos({ id: "POS-A", openedAt: null })];
    const out = applyNonLpOpenerOverride(positions, new Map());
    expect(out.overriddenCount).toBe(0);
    expect(out.positions).toEqual(positions);
  });

  it("ageDays округляется до 0.1", () => {
    const out = applyNonLpOpenerOverride(
      [pos({ id: "POS-R", openedAt: null })],
      new Map([["POS-R", opener(NOW - 100.567 * 86400)]]),
    );
    const age = out.positions[0]!.ageDays!;
    expect(age).toBe(Math.round(age * 10) / 10);
  });
});
