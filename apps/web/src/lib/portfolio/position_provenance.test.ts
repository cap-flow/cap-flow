import { describe, expect, it } from "vitest";

import type { OpenPosition } from "./open_positions";
import type { ClassifiedOp } from "./types";
import {
  verifyPositionProvenance,
  verifyAllPositionsProvenance,
} from "./position_provenance";

function makeOp(args: {
  hash: string;
  time: number;
  type: ClassifiedOp["type"];
  protocolId?: string;
  protocolName?: string;
  chain?: string;
}): ClassifiedOp {
  return {
    hash: args.hash,
    type: args.type,
    time: args.time,
    chain: args.chain ?? "eth",
    status: "success",
    movement: [],
    protocol: args.protocolId
      ? {
          id: args.protocolId,
          name: args.protocolName ?? args.protocolId,
          category: "dex",
        }
      : null,
    netUsd: 0,
    gasUsd: null,
    counterparty: null,
    feePayer: null,
    fnName: null,
    approveSpender: null,
    approveSymbol: null,
    notes: [],
  } as ClassifiedOp;
}

function makePosition(overrides: Partial<OpenPosition>): OpenPosition {
  return {
    id: "POS-001",
    walletId: "w1",
    walletName: "test",
    walletChain: "evm",
    chain: "eth",
    protocol: { id: "uniswap_v3", name: "Uniswap V3", category: "dex" },
    kind: "lp",
    itemName: "Liquidity Pool",
    openedAt: 1_700_000_000,
    openHash: null,
    ageDays: 100,
    supplyTokens: [],
    debtTokens: [],
    openedInTokens: [],
    startUsd: 1000,
    netStartUsd: 1000,
    currentUsd: 1000,
    currentDebtUsd: 0,
    healthRate: null,
    feesUsd: 0,
    feesSource: null,
    feesClaimedUsd: 0,
    feesLifetimeUsd: 0,
    feeApr: null,
    feeAprLifetime: null,
    feesClaimedHistory: [],
    feesByToken: [],
    matchedV3TokenId: undefined,
    pricesSource: "historical",
    instanceId: undefined,
    ...overrides,
  } as OpenPosition;
}

describe("verifyPositionProvenance — ghost fee detection", () => {
  it("flags fee event with op.time < openedAt as error", () => {
    const openedAt = 1_700_000_000;
    const fakeFeeTime = openedAt - 3600; // hour BEFORE position open
    const op = makeOp({
      hash: "0xghost",
      time: fakeFeeTime,
      type: "claim_rewards",
      protocolId: "uniswap_v3",
    });
    const p = makePosition({
      openedAt,
      feesClaimedUsd: 100,
      feesClaimedHistory: [
        {
          time: fakeFeeTime,
          hash: "0xghost",
          usd: 100,
          tokensReceived: [],
          positionUsdAtClaim: null,
          aprPeriod: null,
          daysSincePrev: null,
          pnlSincePrev: null,
          pnlSincePrevPct: null,
        },
      ],
    });
    const report = verifyPositionProvenance(p, [op]);
    expect(report.ok).toBe(false);
    expect(
      report.issues.some(
        (i) => i.severity === "error" && /предшествует openedAt/.test(i.message),
      ),
    ).toBe(true);
  });

  it("accepts fee event with op.time >= openedAt", () => {
    const openedAt = 1_700_000_000;
    const op = makeOp({
      hash: "0xok",
      time: openedAt + 86_400,
      type: "claim_rewards",
      protocolId: "uniswap_v3",
    });
    const p = makePosition({
      openedAt,
      feesClaimedUsd: 50,
      feesClaimedHistory: [
        {
          time: op.time,
          hash: "0xok",
          usd: 50,
          tokensReceived: [],
          positionUsdAtClaim: null,
          aprPeriod: null,
          daysSincePrev: null,
          pnlSincePrev: null,
          pnlSincePrevPct: null,
        },
      ],
    });
    const report = verifyPositionProvenance(p, [op]);
    expect(report.ok).toBe(true);
    expect(report.issues.length).toBe(0);
  });

  it("flags fee event whose hash not in wallet ops", () => {
    const p = makePosition({
      openedAt: 1_700_000_000,
      feesClaimedUsd: 100,
      feesClaimedHistory: [
        {
          time: 1_700_000_100,
          hash: "0xphantom",
          usd: 100,
          tokensReceived: [],
          positionUsdAtClaim: null,
          aprPeriod: null,
          daysSincePrev: null,
          pnlSincePrev: null,
          pnlSincePrevPct: null,
        },
      ],
    });
    const report = verifyPositionProvenance(p, []);
    expect(report.ok).toBe(false);
    expect(report.issues.some((i) => /не найден в wallet ops/.test(i.message))).toBe(
      true,
    );
  });

  it("flags wrong op type (transfer_in masquerading as claim)", () => {
    const op = makeOp({
      hash: "0xmis",
      time: 1_700_000_100,
      type: "transfer_in",
      protocolId: "uniswap_v3",
    });
    const p = makePosition({
      openedAt: 1_700_000_000,
      feesClaimedUsd: 50,
      feesClaimedHistory: [
        {
          time: 1_700_000_100,
          hash: "0xmis",
          usd: 50,
          tokensReceived: [],
          positionUsdAtClaim: null,
          aprPeriod: null,
          daysSincePrev: null,
          pnlSincePrev: null,
          pnlSincePrevPct: null,
        },
      ],
    });
    const report = verifyPositionProvenance(p, [op]);
    expect(report.ok).toBe(false);
    expect(
      report.issues.some(
        (i) => i.severity === "error" && /ожидалось claim_rewards/.test(i.message),
      ),
    ).toBe(true);
  });

  it("flags protocol mismatch", () => {
    const op = makeOp({
      hash: "0xpm",
      time: 1_700_000_100,
      type: "claim_rewards",
      protocolId: "sushiswap",
    });
    const p = makePosition({
      openedAt: 1_700_000_000,
      protocol: { id: "uniswap_v3", name: "Uniswap V3", category: "dex" },
      feesClaimedUsd: 50,
      feesClaimedHistory: [
        {
          time: 1_700_000_100,
          hash: "0xpm",
          usd: 50,
          tokensReceived: [],
          positionUsdAtClaim: null,
          aprPeriod: null,
          daysSincePrev: null,
          pnlSincePrev: null,
          pnlSincePrevPct: null,
        },
      ],
    });
    const report = verifyPositionProvenance(p, [op]);
    expect(report.ok).toBe(false);
    expect(report.issues.some((i) => /protocol mismatch/.test(i.message))).toBe(true);
  });

  it("flags chain mismatch", () => {
    const op = makeOp({
      hash: "0xcm",
      time: 1_700_000_100,
      type: "claim_rewards",
      protocolId: "uniswap_v3",
      chain: "arb",
    });
    const p = makePosition({
      openedAt: 1_700_000_000,
      chain: "eth",
      feesClaimedUsd: 10,
      feesClaimedHistory: [
        {
          time: 1_700_000_100,
          hash: "0xcm",
          usd: 10,
          tokensReceived: [],
          positionUsdAtClaim: null,
          aprPeriod: null,
          daysSincePrev: null,
          pnlSincePrev: null,
          pnlSincePrevPct: null,
        },
      ],
    });
    const report = verifyPositionProvenance(p, [op]);
    expect(report.ok).toBe(false);
    expect(report.issues.some((i) => /chain mismatch/.test(i.message))).toBe(true);
  });
});

describe("verifyPositionProvenance — supplyTokens sum", () => {
  it("flags large startUsd vs Σ supplyTokens.startUsd divergence", () => {
    const p = makePosition({
      startUsd: 1000,
      supplyTokens: [
        { symbol: "WETH", amount: 1, startUsd: 500, currentUsd: 500, avgBuyUsd: 500 },
      ],
    });
    const report = verifyPositionProvenance(p, []);
    expect(
      report.issues.some(
        (i) => i.field === "supplyTokens" && /Σ supplyTokens/.test(i.message),
      ),
    ).toBe(true);
  });

  it("accepts within tolerance", () => {
    const p = makePosition({
      startUsd: 1000,
      supplyTokens: [
        { symbol: "WETH", amount: 1, startUsd: 999.5, currentUsd: 999.5, avgBuyUsd: 999.5 },
      ],
    });
    const report = verifyPositionProvenance(p, []);
    expect(report.issues.filter((i) => i.field === "supplyTokens").length).toBe(0);
  });
});

describe("verifyPositionProvenance — lending APR sanity", () => {
  it("flags WBTC supply yield > 3% APR as missing-supply suspect (POS-008 case)", () => {
    // POS-008 case: 0.06896 WBTC accrued / 0.17662 deposited / 232 days = ~61% APR
    const p = makePosition({
      id: "POS-008",
      protocol: { id: "aave3", name: "Aave V3", category: "lending" },
      feesSource: "supply_yield",
      feesUsd: 5282,
      feesByToken: [
        {
          symbol: "WBTC",
          amount: 0.068959,
          usd: 5282,
          nativeApr: 61.4,
        },
      ],
    });
    const report = verifyPositionProvenance(p, []);
    expect(report.ok).toBe(false);
    const yieldIssue = report.issues.find((i) => i.field === "lendingYieldApr");
    expect(yieldIssue).toBeDefined();
    expect(yieldIssue?.severity).toBe("error");
    expect(yieldIssue?.message).toMatch(/WBTC.*61\.4%.*max 3%/);
    expect(yieldIssue?.message).toMatch(/пропустил supply tx/);
  });

  it("accepts WBTC supply yield within 0.3% APR (normal)", () => {
    const p = makePosition({
      id: "POS-008-normal",
      protocol: { id: "aave3", name: "Aave V3", category: "lending" },
      feesSource: "supply_yield",
      feesUsd: 0.7,
      feesByToken: [
        { symbol: "WBTC", amount: 0.00001, usd: 0.7, nativeApr: 0.3 },
      ],
    });
    const report = verifyPositionProvenance(p, []);
    expect(report.issues.filter((i) => i.field === "lendingYieldApr")).toHaveLength(
      0,
    );
  });

  it("accepts WETH supply yield up to 8% APR", () => {
    const p = makePosition({
      protocol: { id: "aave3", name: "Aave V3", category: "lending" },
      feesSource: "supply_yield",
      feesUsd: 100,
      feesByToken: [{ symbol: "WETH", amount: 0.05, usd: 100, nativeApr: 5 }],
    });
    const report = verifyPositionProvenance(p, []);
    expect(report.issues.filter((i) => i.field === "lendingYieldApr")).toHaveLength(
      0,
    );
  });

  it("flags WETH supply yield > 8% APR", () => {
    const p = makePosition({
      protocol: { id: "aave3", name: "Aave V3", category: "lending" },
      feesSource: "supply_yield",
      feesUsd: 200,
      feesByToken: [
        { symbol: "WETH", amount: 0.1, usd: 200, nativeApr: 15 },
      ],
    });
    const report = verifyPositionProvenance(p, []);
    expect(
      report.issues.some(
        (i) => i.field === "lendingYieldApr" && /WETH/.test(i.message),
      ),
    ).toBe(true);
  });

  it("does NOT apply APR check to V3 LP (feesSource = v3_rewards)", () => {
    // V3 LP fees can legitimately have very high APR (it's trading fee, not yield)
    const p = makePosition({
      protocol: { id: "uniswap_v3", name: "Uniswap V3", category: "dex" },
      feesSource: "v3_rewards",
      feesUsd: 800,
      feesByToken: [{ symbol: "WETH", amount: 0.3, usd: 800, nativeApr: 300 }],
    });
    const report = verifyPositionProvenance(p, []);
    expect(report.issues.filter((i) => i.field === "lendingYieldApr")).toHaveLength(
      0,
    );
  });
});

describe("verifyAllPositionsProvenance — aggregated report", () => {
  it("counts ok / errors / warns correctly", () => {
    const openedAt = 1_700_000_000;
    const goodOp = makeOp({
      hash: "0xok",
      time: openedAt + 100,
      type: "claim_rewards",
      protocolId: "uniswap_v3",
    });
    const ghostOp = makeOp({
      hash: "0xghost",
      time: openedAt - 100,
      type: "claim_rewards",
      protocolId: "uniswap_v3",
    });
    const positions: OpenPosition[] = [
      makePosition({
        id: "POS-001",
        walletId: "w1",
        openedAt,
        feesClaimedUsd: 100,
        feesClaimedHistory: [
          {
            time: goodOp.time,
            hash: "0xok",
            usd: 100,
            tokensReceived: [],
            positionUsdAtClaim: null,
            aprPeriod: null,
            daysSincePrev: null,
            pnlSincePrev: null,
            pnlSincePrevPct: null,
          },
        ],
      }),
      makePosition({
        id: "POS-002",
        walletId: "w1",
        openedAt,
        feesClaimedUsd: 50,
        feesClaimedHistory: [
          {
            time: ghostOp.time,
            hash: "0xghost",
            usd: 50,
            tokensReceived: [],
            positionUsdAtClaim: null,
            aprPeriod: null,
            daysSincePrev: null,
            pnlSincePrev: null,
            pnlSincePrevPct: null,
          },
        ],
      }),
    ];
    const opsByWalletId = new Map([["w1", [goodOp, ghostOp]]]);
    const r = verifyAllPositionsProvenance(positions, opsByWalletId);
    expect(r.totalPositions).toBe(2);
    expect(r.positionsOk).toBe(1);
    expect(r.errorCount).toBeGreaterThan(0);
  });
});
