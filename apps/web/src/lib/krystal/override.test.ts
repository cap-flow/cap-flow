/**
 * PR-K3: Krystal V3 → OpenPosition override (current state only, cost basis
 * остаётся UCB).
 *
 * Логика: для каждой V3 LP OpenPosition с `matchedV3TokenId` set, если в
 * Krystal Map есть summary для этого tokenId — overrride:
 *   - `supplyTokens[].amount`     ← krystal.currentTokens[].amount
 *   - `supplyTokens[].currentUsd` ← krystal.currentTokens[].usd
 *   - `currentUsd`                ← krystal.currentUsd
 *   - `feesUsd`                   ← krystal.pendingFeeUsd
 *   - `feesByToken`               ← krystal.pendingFeeTokens
 *   - `feesClaimedUsd`            ← krystal.claimedFeeUsd
 *   - `feesClaimedByToken`        ← krystal.claimedFeeTokens
 *   - `feesLifetimeUsd`           ← pending + claimed (recompute)
 *
 * НЕ трогаем cost-basis side (Krystal's `providedAmounts` менее точный для
 * cross-wallet/cross-protocol attribution чем UCB lots):
 *   - `startUsd`
 *   - `netStartUsd`
 *   - `openedAt`, `openHash`, `ageDays`
 *   - `supplyTokens[].startUsd`
 *   - `openedInTokens`
 *
 * Per-position PnL re-derived: `currentUsd - startUsd`.
 * `feeApr` / `feeAprLifetime` recomputed с новыми fees.
 */

import { describe, expect, it } from "vitest";

import { applyKrystalV3Override } from "./override";
import type { KrystalV3Summary } from "./adapter";
import type { OpenPosition } from "../portfolio/open_positions";

function basePos(args: {
  id: string;
  matchedV3TokenId?: string;
  startUsd: number;
  currentUsd: number;
  ageDays?: number;
  supply: { symbol: string; amount: number; currentUsd: number; startUsd: number }[];
  feesUsd?: number | null;
  feesClaimedUsd?: number;
  feesByToken?: { symbol: string; amount: number; usd: number; nativeApr: number | null }[];
  feesSource?: "v3_rewards" | "supply_yield" | null;
  feesClaimedHistory?: { time: number; hash: string; usd: number; positionUsdAtClaim?: number; daysSincePrev?: number; aprPeriod?: number; tokensReceived?: { symbol: string; amount: number; usd: number }[] }[];
  v3?: { depositUsd: number; hodlUsd: number; currentLpUsd: number; impermanentLossUsd: number; pnlUsd: number; pnlPct: number };
}): OpenPosition {
  return {
    id: args.id,
    walletId: "wallet-1",
    walletName: "test wallet",
    walletChain: "evm",
    chain: "arb",
    protocol: { id: "uniswap3", name: "Uniswap V3" },
    kind: "lp",
    itemName: "Liquidity Pool",
    openedAt: 1770000000,
    openHash: "0xpos",
    ageDays: args.ageDays ?? 60,
    supplyTokens: args.supply.map((s) => ({
      symbol: s.symbol,
      amount: s.amount,
      startUsd: s.startUsd,
      currentUsd: s.currentUsd,
    })) as OpenPosition["supplyTokens"],
    debtTokens: [],
    openedInTokens: [],
    startUsd: args.startUsd,
    netStartUsd: args.startUsd,
    currentUsd: args.currentUsd,
    currentDebtUsd: 0,
    healthRate: null,
    feesUsd: args.feesUsd ?? null,
    feesSource: args.feesSource ?? "v3_rewards",
    feesClaimedUsd: args.feesClaimedUsd ?? 0,
    feesLifetimeUsd: (args.feesUsd ?? 0) + (args.feesClaimedUsd ?? 0),
    feeApr: null,
    feeAprLifetime: null,
    feesClaimedHistory: (args.feesClaimedHistory ?? []) as OpenPosition["feesClaimedHistory"],
    feesByToken: (args.feesByToken ?? []) as OpenPosition["feesByToken"],
    creditFundedUsd: 0,
    coverageIncomplete: false,
    ...(args.matchedV3TokenId && { matchedV3TokenId: args.matchedV3TokenId }),
    ...(args.v3 && {
      v3: {
        depositUsd: args.v3.depositUsd,
        hodlUsd: args.v3.hodlUsd,
        currentLpUsd: args.v3.currentLpUsd,
        impermanentLossUsd: args.v3.impermanentLossUsd,
        pnlUsd: args.v3.pnlUsd,
        pnlPct: args.v3.pnlPct,
        depositTokens: [],
        pricesSource: "historical" as const,
      } as OpenPosition["v3"],
    }),
  };
}

function summary(args: {
  tokenId: string;
  currentUsd: number;
  current: { symbol: string; amount: number; usd: number }[];
  pendingUsd: number;
  pending?: { symbol: string; amount: number; usd: number }[];
  claimedUsd: number;
  claimed?: { symbol: string; amount: number; usd: number }[];
  chainCode?: string;
  pair?: [string, string];
  ownerAddress?: string;
  status?: KrystalV3Summary["status"];
  // 2026-05-27 (VolnyySanya): cost-basis side из Krystal.
  openedTime?: number | null;
  totalDepositValue?: number | null;
  totalWithdrawValue?: number | null;
  provided?: { symbol: string; amount: number; usd: number }[];
}): KrystalV3Summary {
  return {
    tokenId: args.tokenId,
    chainCode: args.chainCode ?? "arb",
    protocolKey: "uniswapv3",
    pair: args.pair ?? ["WETH", "USDC"],
    status: args.status ?? "IN_RANGE",
    ownerAddress: (args.ownerAddress ?? "0xowner").toLowerCase(),
    poolAddress: "0xpool",
    npmAddress: "0xnpm",
    currentUsd: args.currentUsd,
    currentTokens: args.current.map((t) => ({ ...t, address: "0x" })),
    pendingFeeUsd: args.pendingUsd,
    pendingFeeTokens: (args.pending ?? []).map((t) => ({ ...t, address: "0x" })),
    claimedFeeUsd: args.claimedUsd,
    claimedFeeTokens: (args.claimed ?? []).map((t) => ({ ...t, address: "0x" })),
    providedTokens: (args.provided ?? []).map((t) => ({ ...t, address: "0x" })),
    openedTime: args.openedTime ?? null,
    totalDepositValue: args.totalDepositValue ?? null,
    totalWithdrawValue: args.totalWithdrawValue ?? null,
  };
}

describe("applyKrystalV3Override", () => {
  it("overrides current state + fees когда matchedV3TokenId есть в Krystal Map", () => {
    // lex POS-007 reproduction: capflow says claimed=$778.76 (баг #1 collect-vs-decrease),
    // Krystal says claimed=$32.80 (pool Collect events authoritative).
    const pos = basePos({
      id: "POS-007",
      matchedV3TokenId: "1197028",
      startUsd: 979.57,
      currentUsd: 984.32,
      ageDays: 118,
      supply: [
        { symbol: "WETH", amount: 0.367, currentUsd: 779.15, startUsd: 227.26 },
        { symbol: "USDT", amount: 205.46, currentUsd: 205.23, startUsd: 752.31 },
      ],
      feesUsd: 9.14,
      feesClaimedUsd: 778.76, // INFLATED — баг #1
    });
    const krystal = new Map<string, KrystalV3Summary>([
      [
        "1197028",
        summary({
          tokenId: "1197028",
          currentUsd: 985.10,
          current: [
            { symbol: "WETH", amount: 0.368, usd: 780.0 },
            { symbol: "USDT", amount: 205.10, usd: 205.10 },
          ],
          pendingUsd: 9.15,
          pending: [
            { symbol: "WETH", amount: 0.0022, usd: 4.7 },
            { symbol: "USDT", amount: 4.45, usd: 4.45 },
          ],
          claimedUsd: 32.80, // REAL — Krystal pool-level Collect events
          claimed: [{ symbol: "USDT", amount: 32.80, usd: 32.80 }],
        }),
      ],
    ]);

    const out = applyKrystalV3Override([pos], krystal);
    const p = out[0]!;

    // currentUsd from Krystal
    expect(p.currentUsd).toBeCloseTo(985.10, 1);
    // supplyTokens overridden
    expect(p.supplyTokens[0]!.amount).toBeCloseTo(0.368, 3);
    expect(p.supplyTokens[0]!.currentUsd).toBeCloseTo(780.0, 1);
    // pending fees from Krystal
    expect(p.feesUsd).toBeCloseTo(9.15, 2);
    expect(p.feesByToken).toHaveLength(2);
    // PR-K7 revert: claimed остаётся UCB (Krystal claimed unreliable —
    // POS-007 real $80, POS-006 real $271, Krystal врёт в 2.5×). PR-2 split
    // через DecreaseLiquidity events — авторитарный fix.
    expect(p.feesClaimedUsd).toBe(778.76);
    expect(p.feesLifetimeUsd).toBeCloseTo(9.15 + 778.76, 2);
    // cost-basis untouched (UCB authoritative)
    expect(p.startUsd).toBe(979.57);
    expect(p.openedAt).toBe(1770000000);
    expect(p.openHash).toBe("0xpos");
    expect(p.ageDays).toBe(118);
    // PR (Derbent21 audit 2026-05-25): supplyTokens.startUsd rebalanced
    // pro-rata по Krystal current. Total preserved (= position.startUsd).
    // WETH: 780.0 / 985.10 × 979.57 = $775.61
    // USDT: 205.10 / 985.10 × 979.57 = $203.96
    // Σ = $979.57 = position.startUsd ✓
    expect(p.supplyTokens[0]!.startUsd).toBeCloseTo(775.61, 1);
    expect(p.supplyTokens[1]!.startUsd).toBeCloseTo(203.96, 1);
    expect(
      p.supplyTokens[0]!.startUsd + p.supplyTokens[1]!.startUsd,
    ).toBeCloseTo(p.startUsd, 1);
  });

  it("recomputes feeApr и feeAprLifetime с новыми fees", () => {
    const pos = basePos({
      id: "POS-A",
      matchedV3TokenId: "9991",
      startUsd: 1000,
      currentUsd: 1000,
      ageDays: 100,
      supply: [{ symbol: "WETH", amount: 0.5, currentUsd: 1000, startUsd: 1000 }],
      feesUsd: 50,
      feesClaimedUsd: 100,
    });
    const krystal = new Map<string, KrystalV3Summary>([
      [
        "9991",
        summary({
          tokenId: "9991",
          currentUsd: 1000,
          current: [{ symbol: "WETH", amount: 0.5, usd: 1000 }],
          pendingUsd: 30, // overrides 50
          pending: [{ symbol: "WETH", amount: 0.015, usd: 30 }],
          claimedUsd: 20, // overrides 100
          claimed: [{ symbol: "WETH", amount: 0.01, usd: 20 }],
        }),
      ],
    ]);

    const out = applyKrystalV3Override([pos], krystal);
    const p = out[0]!;

    expect(p.feesUsd).toBe(30);
    // PR-K7: claimed остаётся UCB, не Krystal.
    expect(p.feesClaimedUsd).toBe(100);
    expect(p.feesLifetimeUsd).toBe(130); // 30 pending + 100 claimed (UCB)
    // feeApr = (pending / start) × 365 / age × 100 = (30 / 1000) × 3.65 × 100 = 10.95
    expect(p.feeApr).toBeCloseTo(10.95, 1);
    // feeAprLifetime = (lifetime / start) × 365 / age × 100 = (130 / 1000) × 3.65 × 100 = 47.45
    expect(p.feeAprLifetime).toBeCloseTo(47.45, 1);
  });

  it("non-V3 (lending) positions — Krystal override no-op", () => {
    const pos: OpenPosition = {
      ...basePos({
        id: "POS-AAVE",
        startUsd: 10000,
        currentUsd: 10500,
        supply: [{ symbol: "WETH", amount: 5, currentUsd: 10500, startUsd: 10000 }],
        feesUsd: 500,
        feesSource: "supply_yield",
      }),
      protocol: { id: "aave3", name: "Aave V3" },
      kind: "lending",
    };
    const krystal = new Map<string, KrystalV3Summary>([
      ["9999", summary({
        tokenId: "9999", currentUsd: 1, current: [],
        pendingUsd: 0, claimedUsd: 0,
      })],
    ]);

    const out = applyKrystalV3Override([pos], krystal);
    // Untouched
    expect(out[0]!.currentUsd).toBe(10500);
    expect(out[0]!.feesUsd).toBe(500);
  });

  it("V3 position без matchedV3TokenId — no-op (нечем матчить)", () => {
    const pos = basePos({
      id: "POS-X",
      // matchedV3TokenId not set
      startUsd: 1000,
      currentUsd: 1000,
      supply: [{ symbol: "WETH", amount: 0.5, currentUsd: 1000, startUsd: 1000 }],
      feesUsd: 5,
    });
    const krystal = new Map<string, KrystalV3Summary>([
      [
        "1234",
        summary({
          tokenId: "1234", currentUsd: 2000, current: [{ symbol: "WETH", amount: 1, usd: 2000 }],
          pendingUsd: 50, claimedUsd: 10,
        }),
      ],
    ]);

    const out = applyKrystalV3Override([pos], krystal);
    expect(out[0]!.currentUsd).toBe(1000); // unchanged
    expect(out[0]!.feesUsd).toBe(5);       // unchanged
  });

  it("Krystal Map пустой — no-op (Krystal не загрузился / disabled)", () => {
    const pos = basePos({
      id: "POS-1",
      matchedV3TokenId: "1197028",
      startUsd: 1000,
      currentUsd: 1000,
      supply: [{ symbol: "WETH", amount: 0.5, currentUsd: 1000, startUsd: 1000 }],
      feesUsd: 5,
    });

    const out = applyKrystalV3Override([pos], new Map());
    expect(out[0]!.currentUsd).toBe(1000);
  });

  it("PR-K7 revert: feesClaimedHistory никогда не трогается Krystal'ом", () => {
    // После lex@ audit 2026-05-25: Krystal claimed выдал в 2.5× меньше
    // реальных Etherscan totals (POS-007 real $80 vs Krystal $32, POS-006
    // real $271 vs Krystal $107). Scaling history pro-rata Krystal'ом
    // ломал корректные UCB entries. PR-K7 убрал override claimed.
    const pos = basePos({
      id: "POS-007",
      matchedV3TokenId: "1197028",
      startUsd: 979.57,
      currentUsd: 984.32,
      ageDays: 118,
      supply: [
        { symbol: "WETH", amount: 0.367, currentUsd: 779.15, startUsd: 227.26 },
      ],
      feesUsd: 9.14,
      feesClaimedUsd: 80.38, // UCB+PR-2 split — authoritative real
      feesClaimedHistory: [
        {
          time: 1770543155,
          hash: "0xclaim1",
          usd: 34.35,
          positionUsdAtClaim: 910.57,
          daysSincePrev: 13.46,
          aprPeriod: 95.5,
          tokensReceived: [{ symbol: "ETH", amount: 0.00758, usd: 17.54 }],
        },
        {
          time: 1773839135,
          hash: "0xclaim2",
          usd: 46.03,
          positionUsdAtClaim: 910.57,
          daysSincePrev: 38.15,
          aprPeriod: 48.5,
          tokensReceived: [{ symbol: "USDT", amount: 22.46, usd: 22.46 }],
        },
      ],
    });
    const krystal = new Map<string, KrystalV3Summary>([
      [
        "1197028",
        summary({
          tokenId: "1197028",
          currentUsd: 985.10,
          current: [{ symbol: "WETH", amount: 0.368, usd: 780.0 }],
          pendingUsd: 9.15,
          claimedUsd: 32.80, // КРИВО (Krystal у lex@ оказался unreliable)
        }),
      ],
    ]);

    const out = applyKrystalV3Override([pos], krystal);
    const p = out[0]!;

    // claimed остаётся UCB (НЕ Krystal $32.80)
    expect(p.feesClaimedUsd).toBe(80.38);
    // history никак не scaled
    expect(p.feesClaimedHistory).toHaveLength(2);
    expect(p.feesClaimedHistory[0]!.usd).toBe(34.35);
    expect(p.feesClaimedHistory[1]!.usd).toBe(46.03);
    // tokensReceived не trogan
    expect(p.feesClaimedHistory[0]!.tokensReceived?.[0]?.amount).toBe(0.00758);

    // Krystal действует только на current state
    expect(p.currentUsd).toBeCloseTo(985.10, 1);
    expect(p.feesUsd).toBeCloseTo(9.15, 2);
    expect(p.feesLifetimeUsd).toBeCloseTo(9.15 + 80.38, 2);
  });

  describe("PR-K9 fallback: pair-match для positions без matchedV3TokenId", () => {
    // Base chain: Etherscan v2 unified API не поддерживает Base + Alchemy
    // 403'ит V3 cost-basis path, поэтому applyV3CostBasisOverride не ставит
    // matchedV3TokenId. Krystal по-прежнему отдаёт позицию — fallback
    // матчит по (ownerAddress, chainCode, sortedCanonPair).
    it("Base chain: ставит matchedV3TokenId + apply override через pair match", () => {
      const pos = basePos({
        id: "POS-004",
        // matchedV3TokenId намеренно НЕ задан
        startUsd: 2000,
        currentUsd: 1900,
        ageDays: 90,
        supply: [
          { symbol: "WETH", amount: 0.5, currentUsd: 1000, startUsd: 1000 },
          { symbol: "USDC", amount: 900, currentUsd: 900, startUsd: 1000 },
        ],
        feesUsd: 0,
        feesClaimedUsd: 50,
      });
      // OpenPosition на Base chain.
      const posBase: OpenPosition = { ...pos, chain: "base" };

      const krystal = new Map<string, KrystalV3Summary>([
        [
          "4911255",
          summary({
            tokenId: "4911255",
            currentUsd: 2064.92,
            current: [
              { symbol: "WETH", amount: 0.515, usd: 1080.0 },
              { symbol: "USDC", amount: 984.92, usd: 984.92 },
            ],
            pendingUsd: 23.57,
            pending: [{ symbol: "USDC", amount: 23.57, usd: 23.57 }],
            claimedUsd: 55.4,
            chainCode: "base",
            ownerAddress: "0xLEXWALLET",
          }),
        ],
      ]);
      const walletAddressById = new Map([
        ["wallet-1", "0xLEXWALLET"],
      ]);

      const out = applyKrystalV3Override([posBase], krystal, walletAddressById);
      const p = out[0]!;

      // Krystal applied
      expect(p.currentUsd).toBeCloseTo(2064.92, 1);
      expect(p.feesUsd).toBeCloseTo(23.57, 1);
      // matchedV3TokenId backfilled (для downstream UI / overrides)
      expect(p.matchedV3TokenId).toBe("4911255");
      // 2026-05-27 (PR-K23 follow-up): claimed fees теперь идут через
      // Krystal `/transactions` endpoint (новый параметр в applyKrystalV3Override).
      // Когда transactionsByTokenId НЕ передан → fallback на base.feesClaimedUsd.
      // Старая политика "fallback path → Krystal aggregated claimed" удалена.
      expect(p.feesClaimedUsd).toBe(50);
    });

    it("canonical WETH↔ETH match: position.supplyTokens=[ETH,USDC], Krystal pair=[WETH,USDC]", () => {
      const pos = basePos({
        id: "POS-X",
        startUsd: 1000,
        currentUsd: 1000,
        supply: [
          { symbol: "ETH", amount: 0.5, currentUsd: 500, startUsd: 500 },
          { symbol: "USDC", amount: 500, currentUsd: 500, startUsd: 500 },
        ],
      });
      const posBase: OpenPosition = { ...pos, chain: "base" };
      const krystal = new Map<string, KrystalV3Summary>([
        [
          "999",
          summary({
            tokenId: "999",
            currentUsd: 1200,
            current: [{ symbol: "WETH", amount: 0.6, usd: 1200 }],
            pendingUsd: 5, claimedUsd: 0,
            chainCode: "base", ownerAddress: "0xw",
          }),
        ],
      ]);
      const out = applyKrystalV3Override(
        [posBase],
        krystal,
        new Map([["wallet-1", "0xw"]]),
      );
      expect(out[0]!.matchedV3TokenId).toBe("999");
      expect(out[0]!.currentUsd).toBe(1200);
    });

    it("ambiguous (2 Krystal entries same pair/chain/wallet) — bail, no match", () => {
      const pos = basePos({
        id: "POS-AMB",
        startUsd: 1000, currentUsd: 1000,
        supply: [
          { symbol: "WETH", amount: 0.5, currentUsd: 500, startUsd: 500 },
          { symbol: "USDC", amount: 500, currentUsd: 500, startUsd: 500 },
        ],
        feesUsd: 9,
      });
      const posBase: OpenPosition = { ...pos, chain: "base" };
      // 2 Krystal positions same wallet/chain/pair (different fee tiers).
      const krystal = new Map<string, KrystalV3Summary>([
        ["1", summary({
          tokenId: "1", currentUsd: 2000,
          current: [{ symbol: "WETH", amount: 1, usd: 2000 }],
          pendingUsd: 50, claimedUsd: 0,
          chainCode: "base", ownerAddress: "0xw",
        })],
        ["2", summary({
          tokenId: "2", currentUsd: 3000,
          current: [{ symbol: "WETH", amount: 1.5, usd: 3000 }],
          pendingUsd: 25, claimedUsd: 0,
          chainCode: "base", ownerAddress: "0xw",
        })],
      ]);
      const out = applyKrystalV3Override(
        [posBase], krystal, new Map([["wallet-1", "0xw"]]),
      );
      // Никакой override не применён.
      expect(out[0]!.currentUsd).toBe(1000);
      expect(out[0]!.matchedV3TokenId).toBeUndefined();
    });

    it("walletAddressById не передан — fallback выключен (legacy callers)", () => {
      const pos = basePos({
        id: "POS-LEG",
        startUsd: 1000, currentUsd: 1000,
        supply: [
          { symbol: "WETH", amount: 0.5, currentUsd: 500, startUsd: 500 },
          { symbol: "USDC", amount: 500, currentUsd: 500, startUsd: 500 },
        ],
      });
      const posBase: OpenPosition = { ...pos, chain: "base" };
      const krystal = new Map<string, KrystalV3Summary>([
        ["999", summary({
          tokenId: "999", currentUsd: 2000,
          current: [{ symbol: "WETH", amount: 1, usd: 2000 }],
          pendingUsd: 5, claimedUsd: 0,
          chainCode: "base", ownerAddress: "0xw",
        })],
      ]);
      const out = applyKrystalV3Override([posBase], krystal);
      // Без map'а — no-op.
      expect(out[0]!.currentUsd).toBe(1000);
      expect(out[0]!.matchedV3TokenId).toBeUndefined();
    });

    it("CLOSED Krystal position не используется как match", () => {
      const pos = basePos({
        id: "POS-CL",
        startUsd: 1000, currentUsd: 1000,
        supply: [
          { symbol: "WETH", amount: 0.5, currentUsd: 500, startUsd: 500 },
          { symbol: "USDC", amount: 500, currentUsd: 500, startUsd: 500 },
        ],
      });
      const posBase: OpenPosition = { ...pos, chain: "base" };
      const krystal = new Map<string, KrystalV3Summary>([
        ["999", summary({
          tokenId: "999", currentUsd: 0,
          current: [], pendingUsd: 0, claimedUsd: 100,
          chainCode: "base", ownerAddress: "0xw",
          status: "CLOSED",
        })],
      ]);
      const out = applyKrystalV3Override(
        [posBase], krystal, new Map([["wallet-1", "0xw"]]),
      );
      expect(out[0]!.matchedV3TokenId).toBeUndefined();
      expect(out[0]!.currentUsd).toBe(1000);
    });

    it("wrong wallet — не матчит", () => {
      const pos = basePos({
        id: "POS-W",
        startUsd: 1000, currentUsd: 1000,
        supply: [
          { symbol: "WETH", amount: 0.5, currentUsd: 500, startUsd: 500 },
          { symbol: "USDC", amount: 500, currentUsd: 500, startUsd: 500 },
        ],
      });
      const posBase: OpenPosition = { ...pos, chain: "base" };
      const krystal = new Map<string, KrystalV3Summary>([
        ["999", summary({
          tokenId: "999", currentUsd: 2000,
          current: [{ symbol: "WETH", amount: 1, usd: 2000 }],
          pendingUsd: 5, claimedUsd: 0,
          chainCode: "base", ownerAddress: "0xotherwallet",
        })],
      ]);
      const out = applyKrystalV3Override(
        [posBase], krystal, new Map([["wallet-1", "0xMINE"]]),
      );
      expect(out[0]!.currentUsd).toBe(1000);
    });
  });

  it("PR-K10 (Bug C): пересчитывает v3.currentLpUsd / IL / v3.pnl после override supplyTokens", () => {
    // lex POS-001 reproduction: DeBank mis-attributed amounts → v3.currentLpUsd
    // показывает $1,868 (USDC-only портion) вместо реальных $14,956 (WETH+USDC).
    // Krystal override должен пересчитать v3 sub-fields.
    const pos = basePos({
      id: "POS-001",
      matchedV3TokenId: "5469945",
      startUsd: 15691,
      currentUsd: 1868, // pre-override (stale DeBank)
      supply: [
        { symbol: "WETH", amount: 0, currentUsd: 0, startUsd: 12903 }, // пустой WETH amount
        { symbol: "USDC", amount: 1767.94, currentUsd: 1767.94, startUsd: 2788 },
      ],
      feesUsd: 18.86,
      v3: {
        depositUsd: 15691,
        hodlUsd: 15331, // правильный HODL (1.327 WETH × current + 12550 USDC)
        currentLpUsd: 1868, // ⚠ STALE — будет переписан
        impermanentLossUsd: 13463, // 15331 - 1868 = ⚠ ABSURD
        pnlUsd: -13822, // ⚠ STALE
        pnlPct: -88,
      },
    });
    const krystal = new Map<string, KrystalV3Summary>([
      [
        "5469945",
        summary({
          tokenId: "5469945",
          currentUsd: 14956.10, // правильное LP value (Krystal authoritative)
          current: [
            { symbol: "WETH", amount: 6.17, usd: 12925.93 },
            { symbol: "USDC", amount: 1767.94, usd: 1767.94 },
          ],
          pendingUsd: 18.86,
          pending: [{ symbol: "WETH", amount: 0.009, usd: 18.86 }],
          claimedUsd: 0,
        }),
      ],
    ]);

    const out = applyKrystalV3Override([pos], krystal);
    const p = out[0]!;

    // currentUsd обновлён Krystal'ом
    expect(p.currentUsd).toBeCloseTo(14956.10, 1);
    // v3.currentLpUsd теперь совпадает с реальным LP (был $1,868 → стал ~$14,956)
    expect(p.v3!.currentLpUsd).toBeCloseTo(14956.10, 1);
    // IL пересчитан: hodlUsd $15,331 - currentLpUsd $14,956 = $375 (small loss)
    // НЕ $13,463 (which был absurd)
    expect(p.v3!.impermanentLossUsd).toBeCloseTo(15331 - 14956.10, 1);
    expect(Math.abs(p.v3!.impermanentLossUsd)).toBeLessThan(500);
    // v3.pnlUsd = currentLpUsd - depositUsd = 14956 - 15691 = -$735
    expect(p.v3!.pnlUsd).toBeCloseTo(14956.10 - 15691, 1);
    expect(p.v3!.pnlPct).toBeCloseTo(((14956.10 - 15691) / 15691) * 100, 1);
    // hodlUsd не trogan (depositTokens × currentPrices, не зависит от override)
    expect(p.v3!.hodlUsd).toBe(15331);
    // depositUsd тоже не trogan
    expect(p.v3!.depositUsd).toBe(15691);
  });

  it("recomputes netPnlUsd и netPnlPct из нового currentUsd", () => {
    const pos = basePos({
      id: "POS-PNL",
      matchedV3TokenId: "777",
      startUsd: 1000,
      currentUsd: 900, // Capflow underreports
      supply: [{ symbol: "WETH", amount: 0.4, currentUsd: 900, startUsd: 1000 }],
    });
    const krystal = new Map<string, KrystalV3Summary>([
      [
        "777",
        summary({
          tokenId: "777", currentUsd: 1100, // Krystal says higher
          current: [{ symbol: "WETH", amount: 0.5, usd: 1100 }],
          pendingUsd: 0, claimedUsd: 0,
        }),
      ],
    ]);

    const out = applyKrystalV3Override([pos], krystal);
    const p = out[0]!;
    expect(p.currentUsd).toBe(1100);
    expect(p.netPnlUsd).toBe(100); // 1100 − 1000
    expect(p.netPnlPct).toBeCloseTo(10, 1);
  });

  describe("VolnyySanya policy (2026-05-27): Krystal → startUsd / openedAt", () => {
    // POS-001 BASE NFT #4987608: Etherscan v2 не поддерживает Base chain →
    // applyV3CostBasisOverride не ставит matchedV3TokenId → UCB lot tracker
    // даёт мусорный startUsd $1,723.90 (real deposit $2,000). Krystal
    // знает providedAmounts + performance.totalDepositValue + openedTime —
    // именно эти поля теперь PRIMARY для cost-basis side.
    it("Base chain fallback: startUsd / openedAt / supplyTokens.startUsd из Krystal", () => {
      const pos = basePos({
        id: "POS-001",
        // matchedV3TokenId намеренно НЕ задан (Etherscan не отработал)
        startUsd: 1723.90, // ⚠ MUSOR из UCB lot tracker
        currentUsd: 1854.05,
        ageDays: 60,
        supply: [
          // ⚠ startUsd мусор: avgBuyPrice $29.61/WETH, $0.65/USDC через broken WAC
          { symbol: "WETH", amount: 0.845, currentUsd: 1750.97, startUsd: 1634.56 },
          { symbol: "USDC", amount: 95.70, currentUsd: 95.70, startUsd: 89.34 },
        ],
        feesUsd: 7.37,
        feesClaimedUsd: 1979.94, // ⚠ UCB+PR-2 inflated (real $69-80)
        v3: {
          // ⚠ UCB-derived garbage: real provided was 0 WETH + 2000 USDC
          depositUsd: 1748.89,
          hodlUsd: 1704.51,
          currentLpUsd: 1854.05,
          impermanentLossUsd: -149.54,
          pnlUsd: 105.16,
          pnlPct: 6.01,
        },
      });
      const posBase: OpenPosition = { ...pos, chain: "base" };

      // Krystal authoritative: $2,000 USDC deposited 18.04.2026.
      const krystal = new Map<string, KrystalV3Summary>([
        [
          "4987608",
          summary({
            tokenId: "4987608",
            currentUsd: 1854.05,
            current: [
              { symbol: "WETH", amount: 0.845, usd: 1750.97 },
              { symbol: "USDC", amount: 95.70, usd: 95.70 },
            ],
            pendingUsd: 7.37,
            claimedUsd: 69.91, // real Krystal collect events ($35.61 WETH + $34.30 USDC)
            claimed: [
              { symbol: "WETH", amount: 0.017236, usd: 35.61 },
              { symbol: "USDC", amount: 34.30, usd: 34.30 },
            ],
            chainCode: "base",
            ownerAddress: "0xvolnyy",
            openedTime: 1745019300, // 18.04.2026 00:35 UTC примерно
            totalDepositValue: 2000.0, // REAL
            totalWithdrawValue: 0,
            provided: [
              // 18.04 deposit: 0 WETH + 2000 USDC (1 IncreaseLiquidity event)
              { symbol: "WETH", amount: 0, usd: 0 },
              { symbol: "USDC", amount: 2000, usd: 2000.0 },
            ],
          }),
        ],
      ]);
      const walletAddressById = new Map([["wallet-1", "0xvolnyy"]]);

      const out = applyKrystalV3Override([posBase], krystal, walletAddressById);
      const p = out[0]!;

      // Cost basis из Krystal, не UCB-мусора
      expect(p.startUsd).toBeCloseTo(2000.0, 1);
      expect(p.netStartUsd).toBeCloseTo(2000.0, 1);
      expect(p.openedAt).toBe(1745019300);
      // ageDays пересчитан от нового openedAt
      expect(p.ageDays).toBeGreaterThan(0);

      // supplyTokens.startUsd pro-rata по providedTokens (USDC-only deposit)
      expect(p.supplyTokens[0]!.startUsd).toBeCloseTo(0, 1); // WETH provided=0
      expect(p.supplyTokens[1]!.startUsd).toBeCloseTo(2000.0, 1); // USDC provided=2000

      // 2026-05-27 (PR-K23): claimed fees теперь через /transactions endpoint.
      // Без transactionsByTokenId param → fallback на base.feesClaimedUsd.
      // (Real claim history populated через отдельный test ниже с txs map.)
      expect(p.feesClaimedUsd).toBe(1979.94); // base UCB value preserved
      expect(p.feesClaimedHistory).toEqual([]); // basePos default — empty

      // PnL пересчитан от нового startUsd
      expect(p.netPnlUsd).toBeCloseTo(1854.05 - 2000.0, 1);

      // matchedV3TokenId backfilled для UI
      expect(p.matchedV3TokenId).toBe("4987608");

      // 2026-05-27 follow-up: v3.depositTokens из Krystal providedTokens
      expect(p.v3?.depositUsd).toBeCloseTo(2000.0, 1);
      expect(p.v3?.depositTokens).toEqual([
        { symbol: "WETH", amount: 0, usdAtDeposit: 0 },
        { symbol: "USDC", amount: 2000, usdAtDeposit: 2000 },
      ]);

      // supplyTokens.startAmount из Krystal providedTokens (UI «Внесено токенов»)
      expect(p.supplyTokens[0]!.startAmount).toBe(0); // WETH
      expect(p.supplyTokens[1]!.startAmount).toBe(2000); // USDC
    });

    it("ARB happy path: Krystal totalDepositValue=$1752 → корректирует netStartUsd ($880 был broken)", () => {
      // POS-002 ARB NFT #5500786 (VolnyySanya): Etherscan УЖЕ дал
      // правильный startUsd $1,752.96 в useV3LiquidityEvents. Но
      // applyV3CostBasisOverride Phase-2 pro-rata fallback дал netStartUsd
      // = v3.depositUsd = $880.55 (broken split). Krystal totalDepositValue
      // должен синхронизировать обе метрики на $1,752.96.
      const pos = basePos({
        id: "POS-002",
        matchedV3TokenId: "5500786",
        startUsd: 1752.96, // Etherscan дал correct
        currentUsd: 1763.44,
        ageDays: 3,
        supply: [
          // ⚠ supplyTokens.startAmount показывал 7.63 WETH + 5617 USDC (cross-chain garbage)
          { symbol: "WETH", amount: 0.841, currentUsd: 1740.00, startUsd: 1734.69 },
          { symbol: "USDC", amount: 18.31, currentUsd: 18.32, startUsd: 18.26 },
        ],
        feesUsd: 5.12,
        feesClaimedUsd: 7582.30,
      });
      pos.netStartUsd = 880.55; // ⚠ broken от Phase-2 pro-rata

      const krystal = new Map<string, KrystalV3Summary>([
        [
          "5500786",
          summary({
            tokenId: "5500786",
            currentUsd: 1763.44,
            current: [
              { symbol: "WETH", amount: 0.841, usd: 1740.00 },
              { symbol: "USDC", amount: 18.31, usd: 18.32 },
            ],
            pendingUsd: 5.12,
            claimedUsd: 0,
            chainCode: "arb",
            ownerAddress: "0xvolnyy",
            openedTime: 1779514625, // 24.05.2026
            totalDepositValue: 1752.96, // совпадает с Etherscan ✓
            totalWithdrawValue: 0,
            provided: [
              { symbol: "WETH", amount: 0.85, usd: 1752.96 },
              { symbol: "USDC", amount: 0, usd: 0 },
            ],
          }),
        ],
      ]);

      const out = applyKrystalV3Override([pos], krystal);
      const p = out[0]!;

      // netStartUsd теперь = startUsd = $1,752.96 (Krystal authoritative)
      expect(p.startUsd).toBeCloseTo(1752.96, 1);
      expect(p.netStartUsd).toBeCloseTo(1752.96, 1);
      expect(p.openedAt).toBe(1779514625);

      // supplyTokens.startUsd pro-rata от Krystal provided (WETH-only)
      expect(p.supplyTokens[0]!.startUsd).toBeCloseTo(1752.96, 1);
      expect(p.supplyTokens[1]!.startUsd).toBeCloseTo(0, 1);

      // claimed UCB
      expect(p.feesClaimedUsd).toBe(7582.30);
    });

    it("Krystal totalDepositValue=null → graceful fallback на base.startUsd (старые позиции)", () => {
      const pos = basePos({
        id: "POS-OLD",
        matchedV3TokenId: "111",
        startUsd: 5000,
        currentUsd: 5200,
        supply: [{ symbol: "WETH", amount: 2.5, currentUsd: 5200, startUsd: 5000 }],
        feesUsd: 50,
      });
      const krystal = new Map<string, KrystalV3Summary>([
        [
          "111",
          summary({
            tokenId: "111",
            currentUsd: 5200,
            current: [{ symbol: "WETH", amount: 2.5, usd: 5200 }],
            pendingUsd: 50, claimedUsd: 0,
            // totalDepositValue/openedTime НЕ заданы
          }),
        ],
      ]);
      const out = applyKrystalV3Override([pos], krystal);
      const p = out[0]!;
      // Cost basis untouched — graceful degradation
      expect(p.startUsd).toBe(5000);
      expect(p.openedAt).toBe(1770000000); // base value preserved
    });

    it("PR-K23: Krystal /transactions → feesClaimedHistory + feesClaimedUsd", () => {
      // VolnyySanya POS-001 BASE: реальные 4 collect events с user-confirmed
      // числами. Endpoint /v1/positions/{chainId}/{nft}/transactions отдаёт
      // historical USD prices at block time — authoritative.
      const pos = basePos({
        id: "POS-001",
        matchedV3TokenId: "4987608",
        startUsd: 2000,
        currentUsd: 1854.05,
        ageDays: 40,
        supply: [
          { symbol: "WETH", amount: 0.845, currentUsd: 1750.97, startUsd: 0 },
          { symbol: "USDC", amount: 95.70, currentUsd: 95.70, startUsd: 2000 },
        ],
        feesUsd: 7.37,
        feesClaimedUsd: 1979.94, // ⚠ UCB inflated raw value
        feesClaimedHistory: [
          // ⚠ UCB-derived inflated entries (13 entries в проде у VolnyySanya)
          { time: 1770000000, hash: "0xUCB1", usd: 1500 },
          { time: 1771000000, hash: "0xUCB2", usd: 479.94 },
        ],
      });
      const krystal = new Map<string, KrystalV3Summary>([
        ["4987608", summary({
          tokenId: "4987608", currentUsd: 1854.05,
          current: [
            { symbol: "WETH", amount: 0.845, usd: 1750.97 },
            { symbol: "USDC", amount: 95.70, usd: 95.70 },
          ],
          pendingUsd: 7.37,
          claimedUsd: 70, // aggregated (less reliable than /transactions)
          chainCode: "base",
          ownerAddress: "0xowner",
          openedTime: 1776443737,
          totalDepositValue: 2000,
          provided: [
            { symbol: "WETH", amount: 0, usd: 0 },
            { symbol: "USDC", amount: 2000, usd: 2000 },
          ],
        })],
      ]);
      // Authoritative claim history from /transactions endpoint.
      // NOTE: daysSincePrev populated в реальном flow адаптером
      // (krystalTransactionsToSummary). В моке передаём готовое значение.
      const transactions = new Map<string, import("./adapter").KrystalTransactionsSummary>([
        ["4987608", {
          claimedHistory: [
            { time: 1777215155, hash: "0x4195187e6f0d55fcf903e4783c602b1e6f52fadb011c7274309776f956d22c9c", usd: 21.68, tokensReceived: [{ symbol: "WETH", amount: 0.00489, usd: 11.49 }, { symbol: "USDC", amount: 10.19, usd: 10.19 }] },
            { time: 1778349687, hash: "0x2d0a20f57a5e82c65c680e9b598e14cf11c51256b0a88d84ec9b19f1df1c187f", usd: 27.14, daysSincePrev: (1778349687 - 1777215155) / 86400, tokensReceived: [{ symbol: "WETH", amount: 0.00588, usd: 13.73 }, { symbol: "USDC", amount: 13.41, usd: 13.41 }] },
            { time: 1778939611, hash: "0x2a8d531ea7dbe8eedb918810e4e4f57b8c373a28819c408b71a9a6d41abf6b45", usd: 12.32, daysSincePrev: (1778939611 - 1778349687) / 86400, tokensReceived: [{ symbol: "WETH", amount: 0.00320, usd: 6.97 }, { symbol: "USDC", amount: 5.35, usd: 5.35 }] },
            { time: 1779541523, hash: "0x43268c01b951a50cbe070dd6fefe2973040b4ed27984633e0310863c8a9b3f72", usd: 12.00, daysSincePrev: (1779541523 - 1778939611) / 86400, tokensReceived: [{ symbol: "WETH", amount: 0.00326, usd: 6.65 }, { symbol: "USDC", amount: 5.35, usd: 5.35 }] },
          ],
          claimedTotalUsd: 73.14,
          depositCount: 1,
          withdrawCount: 0,
          eventTypes: ["DEPOSIT", "COLLECT_FEE"],
        }],
      ]);

      const out = applyKrystalV3Override([pos], krystal, undefined, transactions);
      const p = out[0]!;

      // feesClaimedHistory authoritative из /transactions, не UCB
      expect(p.feesClaimedHistory).toHaveLength(4);
      expect(p.feesClaimedHistory[0]!.hash).toBe("0x4195187e6f0d55fcf903e4783c602b1e6f52fadb011c7274309776f956d22c9c");
      expect(p.feesClaimedHistory[0]!.usd).toBeCloseTo(21.68, 2);
      expect(p.feesClaimedHistory[3]!.usd).toBeCloseTo(12.00, 2);
      // Σ совпадает с user-confirmed $73.14, не UCB $1979 и не Krystal aggregated $70
      expect(p.feesClaimedUsd).toBeCloseTo(73.14, 2);
      // feesLifetimeUsd = newPending + newClaimed
      expect(p.feesLifetimeUsd).toBeCloseTo(7.37 + 73.14, 2);
      // feesClaimedByToken aggregated по символу через всю историю
      const wethSum = p.feesClaimedByToken.find(t => t.symbol === "WETH");
      expect(wethSum?.usd).toBeCloseTo(11.49 + 13.73 + 6.97 + 6.65, 1);

      // PR-K24 (2026-05-27 follow-up): aprPeriod вычисляется из usd/startUsd ×
      // 365/daysSincePrev × 100. positionUsdAtClaim = startUsd как аппроксимация.
      // First entry (i=0) не имеет daysSincePrev → aprPeriod undefined.
      expect(p.feesClaimedHistory[0]!.aprPeriod).toBeUndefined();
      // 10.05 (после 26.04): 13.12 дн (1778349687 - 1777215155) / 86400 = 13.13
      // aprPeriod = (27.14 / 2000) × (365/13.13) × 100 ≈ 37.73%
      expect(p.feesClaimedHistory[1]!.aprPeriod).toBeCloseTo(37.73, 0);
      expect(p.feesClaimedHistory[1]!.positionUsdAtClaim).toBe(2000);
      // 16.05: ~6.83 дн → (12.32 / 2000) × (365/6.83) × 100 ≈ 32.92%
      expect(p.feesClaimedHistory[2]!.aprPeriod).toBeCloseTo(32.92, 0);
      // 23.05: ~6.97 дн → (12.00 / 2000) × (365/6.97) × 100 ≈ 31.42%
      expect(p.feesClaimedHistory[3]!.aprPeriod).toBeCloseTo(31.42, 0);
    });

    it("PR-K23: если /transactions не передан → fallback на base.feesClaimed*", () => {
      const pos = basePos({
        id: "POS-FALLBACK",
        matchedV3TokenId: "999",
        startUsd: 1000,
        currentUsd: 1000,
        supply: [{ symbol: "WETH", amount: 0.5, currentUsd: 1000, startUsd: 1000 }],
        feesClaimedUsd: 100,
        feesClaimedHistory: [
          { time: 1770000000, hash: "0xa", usd: 60 },
          { time: 1771000000, hash: "0xb", usd: 40 },
        ],
      });
      const krystal = new Map<string, KrystalV3Summary>([
        ["999", summary({
          tokenId: "999", currentUsd: 1000,
          current: [{ symbol: "WETH", amount: 0.5, usd: 1000 }],
          pendingUsd: 0, claimedUsd: 999, // Krystal aggregated — игнорируется
        })],
      ]);

      // Без transactionsByTokenId
      const out = applyKrystalV3Override([pos], krystal);
      const p = out[0]!;
      expect(p.feesClaimedUsd).toBe(100); // UCB preserved
      expect(p.feesClaimedHistory).toHaveLength(2);
    });

    it("PR-K23: empty /transactions (no events) → 0 claimed, empty history", () => {
      const pos = basePos({
        id: "POS-NEW",
        matchedV3TokenId: "888",
        startUsd: 500,
        currentUsd: 510,
        supply: [{ symbol: "WETH", amount: 0.25, currentUsd: 510, startUsd: 500 }],
        feesClaimedUsd: 999, // ⚠ UCB inflated
      });
      const krystal = new Map<string, KrystalV3Summary>([
        ["888", summary({
          tokenId: "888", currentUsd: 510,
          current: [{ symbol: "WETH", amount: 0.25, usd: 510 }],
          pendingUsd: 0, claimedUsd: 0,
        })],
      ]);
      // Krystal /transactions вернул empty (новая позиция, нет collect events)
      const transactions = new Map<string, import("./adapter").KrystalTransactionsSummary>([
        ["888", {
          claimedHistory: [],
          claimedTotalUsd: 0,
          depositCount: 1,
          withdrawCount: 0,
          eventTypes: ["DEPOSIT"],
        }],
      ]);
      const out = applyKrystalV3Override([pos], krystal, undefined, transactions);
      const p = out[0]!;
      // /transactions authoritative — empty означает 0 claimed
      expect(p.feesClaimedUsd).toBe(0);
      expect(p.feesClaimedHistory).toEqual([]);
    });

    it("netStartUsd учитывает withdrawValue (если Krystal знает обе стороны)", () => {
      const pos = basePos({
        id: "POS-PARTIAL",
        matchedV3TokenId: "222",
        startUsd: 3000,
        currentUsd: 1600,
        supply: [{ symbol: "WETH", amount: 0.8, currentUsd: 1600, startUsd: 3000 }],
        feesUsd: 100,
      });
      const krystal = new Map<string, KrystalV3Summary>([
        [
          "222",
          summary({
            tokenId: "222",
            currentUsd: 1600,
            current: [{ symbol: "WETH", amount: 0.8, usd: 1600 }],
            pendingUsd: 100, claimedUsd: 0,
            openedTime: 1770000000,
            totalDepositValue: 3000,
            totalWithdrawValue: 1500, // partial decrease
          }),
        ],
      ]);
      const out = applyKrystalV3Override([pos], krystal);
      const p = out[0]!;
      expect(p.startUsd).toBe(3000); // total ever deposited
      expect(p.netStartUsd).toBe(1500); // net = 3000 − 1500
    });
  });
});
