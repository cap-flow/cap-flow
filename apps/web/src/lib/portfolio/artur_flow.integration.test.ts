/**
 * Integration test: воспроизводит точные сценарии POS-005 и POS-006
 * пользователя artur@gmail.com (на которых нашли 5 связанных багов
 * C8/C10/C10b/C11/C12 за одну сессию).
 *
 * Цель: гарантировать что эти баги НИКОГДА не вернутся. Идёт через
 * production path — `runUcbPipelineForWallet` с `walletNameById` →
 * `buildLotsAndPositions` → PositionTracker.
 *
 * Если когда-нибудь cost basis для leverage loop / async-deposit
 * сломается заново, этот тест сразу красный.
 *
 * См. также `capflow_anti_recurrence_methodology.md` в auto-memory.
 */
import { describe, expect, it } from "vitest";

import { runUcbPipelineForWallet } from "./ucb_pipeline";
import type { ClassifiedOp, TokenMovement } from "./types";

const ARB = "arb";
const WALLET = "w1";

const PROTOCOLS = {
  aave: { id: "arb_aave3", name: "Aave V3", category: "lending" as const },
  morpho: {
    id: "arb_morphoblue",
    name: "Morpho Blue",
    category: "lending" as const,
  },
  fluid: { id: "arb_fluid", name: "Fluid", category: "lending" as const },
  gmx: {
    id: "arb_gmx2",
    name: "GMX V2",
    category: "yield" as const,
  },
};

interface MovementSpec {
  direction: "in" | "out";
  symbol: string;
  amount: number;
  usd?: number;
  tokenId?: string;
  isStable?: boolean;
  isProtocolToken?: boolean;
}

function mov(spec: MovementSpec): TokenMovement {
  return {
    direction: spec.direction,
    symbol: spec.symbol,
    amount: spec.amount,
    usd: spec.usd ?? null,
    tokenId: spec.tokenId ?? spec.symbol.toLowerCase(),
    isStable: spec.isStable ?? ["USDC", "USDT", "DAI"].includes(spec.symbol),
    isProtocolToken: spec.isProtocolToken ?? false,
  } as TokenMovement;
}

interface OpSpec {
  hash: string;
  type: ClassifiedOp["type"];
  time: number;
  protocol?: { id: string; name: string; category: string } | null;
  movements: MovementSpec[];
  notes?: string[];
  linkedCostBasisUsd?: number;
}

function makeOp(spec: OpSpec): ClassifiedOp {
  const op: ClassifiedOp = {
    hash: spec.hash,
    type: spec.type,
    time: spec.time,
    chain: ARB,
    status: "success",
    movement: spec.movements.map(mov),
    protocol: spec.protocol ?? null,
    netUsd: 0,
    gasUsd: null,
    counterparty: null,
    feePayer: null,
    fnName: null,
    approveSpender: null,
    approveSymbol: null,
    notes: spec.notes ?? [],
  } as ClassifiedOp;
  if (spec.linkedCostBasisUsd != null) {
    (op as { linkedCostBasisUsd?: number }).linkedCostBasisUsd =
      spec.linkedCostBasisUsd;
  }
  return op;
}

// ─── POS-005 flow ───────────────────────────────────────────────────

describe("Artur POS-005 integration: Aave→Morpho→Fluid leverage loop", () => {
  it("startUsd = $30,000 (real spending) после C10/C11/C12 fixes", () => {
    // Точные числа из artur@gmail.com прода. Если когда-то этот тест
    // упадёт → значит регрессия в одном из C10/C11/C12.
    const ops: ClassifiedOp[] = [
      // Три покупки WBTC totalling 0.22620 за ~$20k
      makeOp({
        hash: "0xbuy1",
        type: "swap",
        time: 1763816347,
        movements: [
          {
            direction: "out",
            symbol: "USDC",
            amount: 5000,
            usd: 5000,
            isStable: true,
          },
          {
            direction: "in",
            symbol: "WBTC",
            amount: 0.05972379,
            usd: 5000,
            tokenId: "0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f",
          },
        ],
      }),
      makeOp({
        hash: "0xbuy2",
        type: "swap",
        time: 1764335032,
        movements: [
          {
            direction: "out",
            symbol: "USDC",
            amount: 5000,
            usd: 5000,
            isStable: true,
          },
          {
            direction: "in",
            symbol: "WBTC",
            amount: 0.05474112,
            usd: 5000,
            tokenId: "0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f",
          },
        ],
      }),
      makeOp({
        hash: "0xbuy3",
        type: "swap",
        time: 1765020879,
        movements: [
          {
            direction: "out",
            symbol: "USDC",
            amount: 10000,
            usd: 10000,
            isStable: true,
          },
          {
            direction: "in",
            symbol: "WBTC",
            amount: 0.11173906,
            usd: 10000,
            tokenId: "0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f",
          },
        ],
      }),
      // Aave V3 supply 0.226 WBTC → aArbWBTC IN (receipt)
      makeOp({
        hash: "0xaavesup",
        type: "lend_supply",
        time: 1765022397,
        protocol: PROTOCOLS.aave,
        movements: [
          {
            direction: "out",
            symbol: "WBTC",
            amount: 0.22620396,
            usd: 20000,
            tokenId: "0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f",
          },
          {
            direction: "in",
            symbol: "aArbWBTC",
            amount: 0.22620396,
            usd: 20000,
            tokenId: "0x191c10aa4af7c30e871e70c95db0e4eb77237530",
            isProtocolToken: true,
          },
        ],
      }),
      // Aave V3 withdraw aArbWBTC → 0.226 WBTC IN (creates lend_withdraw lot
      // with tokenId="" — это и был C12-баг)
      makeOp({
        hash: "0xaavewith",
        type: "lend_withdraw",
        time: 1765022548,
        protocol: PROTOCOLS.aave,
        movements: [
          {
            direction: "out",
            symbol: "aArbWBTC",
            amount: 0.22620396,
            usd: 20000,
            tokenId: "0x191c10aa4af7c30e871e70c95db0e4eb77237530",
            isProtocolToken: true,
          },
          {
            direction: "in",
            symbol: "WBTC",
            amount: 0.22620396,
            usd: 20000,
            tokenId: "", // ← empty tokenId; C12 fix relax tokenId filter
          },
        ],
      }),
      // Morpho supply 0.226 WBTC (receipt-less — записывает selfLoopCollateral)
      makeOp({
        hash: "0xmorpsup",
        type: "lend_supply",
        time: 1765022634,
        protocol: PROTOCOLS.morpho,
        movements: [
          {
            direction: "out",
            symbol: "WBTC",
            amount: 0.22620396,
            usd: 20000,
            tokenId: "0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f",
          },
        ],
      }),
      // Morpho borrow 0.226 WBTC (self-loop — inherits cost from selfLoopCollateral)
      // ⚠ Этот op имеет ТОЛЬКО IN movement — это C10b fix (inferMarketKey
      // должен возвращать non-null для receipt-less borrow IN-only).
      makeOp({
        hash: "0xmorpborrow",
        type: "borrow",
        time: 1765023116,
        protocol: PROTOCOLS.morpho,
        movements: [
          {
            direction: "in",
            symbol: "WBTC",
            amount: 0.22620396,
            usd: 17280,
            tokenId: "0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f",
          },
        ],
      }),
      // Fluid supply 0.226 WBTC → fVLT NFT (consume borrowed-self-loop lot)
      makeOp({
        hash: "0xfluidsup1",
        type: "lend_supply",
        time: 1765023165,
        protocol: PROTOCOLS.fluid,
        movements: [
          {
            direction: "out",
            symbol: "WBTC",
            amount: 0.22620396,
            usd: 17280,
            tokenId: "0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f",
          },
          {
            direction: "in",
            symbol: "fVLT",
            amount: 1,
            usd: null,
            tokenId: "0xf0ba982a3ac2d4f08b0e8ab8e96e8c8e8c8e8c8e",
            isProtocolToken: true,
          },
        ],
      }),
      // Mar 14: buy 0.142 WBTC за $10k
      makeOp({
        hash: "0xbuy4",
        type: "swap",
        time: 1773487349,
        movements: [
          {
            direction: "out",
            symbol: "USDC",
            amount: 10000,
            usd: 10000,
            isStable: true,
          },
          {
            direction: "in",
            symbol: "WBTC",
            amount: 0.14180623,
            usd: 10000,
            tokenId: "0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f",
          },
        ],
      }),
      // Mar 14: Fluid supply 0.142 WBTC (consume Mar 14 buy lot via C11
      // historical wacAt — это и был C11 баг где wacAt возвращал null для
      // consumed lots).
      //
      // Реальный Fluid supply всегда обновляет fVLT NFT (даже когда NFT
      // amount = 1 без изменения, в movements тулится IN для signal'а что
      // событие принадлежит уже существующей position через тот же
      // tokenId). Без IN-receipt inferMarketKey возвращает null и position
      // event не создаётся — supply «теряется».
      makeOp({
        hash: "0xfluidsup2",
        type: "lend_supply",
        time: 1773487509,
        protocol: PROTOCOLS.fluid,
        movements: [
          {
            direction: "out",
            symbol: "WBTC",
            amount: 0.14180623,
            usd: 10832,
            tokenId: "0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f",
          },
          {
            direction: "in",
            symbol: "fVLT",
            amount: 1,
            usd: null,
            tokenId: "0xf0ba982a3ac2d4f08b0e8ab8e96e8c8e8c8e8c8e",
            isProtocolToken: true,
          },
        ],
      }),
    ];

    const result = runUcbPipelineForWallet({
      walletId: WALLET,
      ops,
      annotationsByKey: new Map(),
      walletNameById: new Map([[WALLET, "Artur Test Wallet"]]),
    });

    expect(result.positionTracker).toBeDefined();
    // INVARIANT (property of anti-recurrence methodology):
    //   Σ position.currentCostBasisUsd по всем Fluid WBTC = Σ real_money_spent.
    //
    // Если Fluid supply №2 окажется в отдельной position (другой marketKey),
    // важно что суммарный cost basis всё равно равен реальным $30k —
    // никакой фейковый m.usd fallback не должен ни добавлять, ни терять USD.
    const fluidPositions = result.positionTracker!
      .all()
      .filter(
        (p) =>
          p.walletId === WALLET &&
          p.protocolId === "arb_fluid" &&
          p.collateralSymbols.includes("WBTC"),
      );
    expect(fluidPositions.length).toBeGreaterThan(0);
    const totalFluidCost = fluidPositions.reduce(
      (s, p) => s + p.currentCostBasisUsd,
      0,
    );
    // Реальные деньги потрачены $20k (Aave→Morpho→Fluid loop) + $10k
    // (Mar 14 buy → Fluid) = $30,000. Допуск $100 на numerical noise.
    expect(totalFluidCost).toBeGreaterThan(29_900);
    expect(totalFluidCost).toBeLessThan(30_100);
  });
});

// ─── POS-006 flow — GMX V2 async-deposit (linked cost basis) ────────

describe("Artur POS-006 integration: GMX V2 GLV async-deposit + Morpho", () => {
  it("startUsd = sum of linkedCostBasisUsd через C8 fix", () => {
    // 3 GMX V2 yield-deposit fills (только IN GLV, без OUT — USDC ушёл
    // в отдельной Tx A раньше, async_deposit_linker.ts уже пометил
    // linkedCostBasisUsd на fill).
    const ops: ClassifiedOp[] = [
      makeOp({
        hash: "0xglv1",
        type: "lp_add",
        time: 1759569511,
        protocol: PROTOCOLS.gmx,
        notes: ["yield-deposit-fill"],
        linkedCostBasisUsd: 4704.48,
        movements: [
          {
            direction: "in",
            symbol: "GLV [WETH-USDC]",
            amount: 2740.969,
            usd: 3273.34,
            tokenId: "0x528a5bac7e746c9a509a1aa3cd71b8b07aad8b0d",
            isProtocolToken: true,
          },
        ],
      }),
      makeOp({
        hash: "0xglv2",
        type: "lp_add",
        time: 1761745870,
        protocol: PROTOCOLS.gmx,
        notes: ["yield-deposit-fill"],
        linkedCostBasisUsd: 8124.3,
        movements: [
          {
            direction: "in",
            symbol: "GLV [WETH-USDC]",
            amount: 5014.822,
            usd: 5988.84,
            tokenId: "0x528a5bac7e746c9a509a1aa3cd71b8b07aad8b0d",
            isProtocolToken: true,
          },
        ],
      }),
      makeOp({
        hash: "0xglv3",
        type: "lp_add",
        time: 1763810979,
        protocol: PROTOCOLS.gmx,
        notes: ["yield-deposit-fill"],
        linkedCostBasisUsd: 4801.77,
        movements: [
          {
            direction: "in",
            symbol: "GLV [WETH-USDC]",
            amount: 3531.416,
            usd: 4217.32,
            tokenId: "0x528a5bac7e746c9a509a1aa3cd71b8b07aad8b0d",
            isProtocolToken: true,
          },
        ],
      }),
      // Morpho supply 11,287 GLV → POS-006 collateral.
      makeOp({
        hash: "0xmorpsup",
        type: "lend_supply",
        time: 1763814065,
        protocol: PROTOCOLS.morpho,
        movements: [
          {
            direction: "out",
            symbol: "GLV [WETH-USDC]",
            amount: 11287.21,
            usd: 13479.5,
            tokenId: "0x528a5bac7e746c9a509a1aa3cd71b8b07aad8b0d",
            isProtocolToken: true,
          },
        ],
      }),
    ];

    const result = runUcbPipelineForWallet({
      walletId: WALLET,
      ops,
      annotationsByKey: new Map(),
      walletNameById: new Map([[WALLET, "Artur Test Wallet"]]),
    });

    expect(result.positionTracker).toBeDefined();
    const morpho = result.positionTracker!.findByCollateral(
      WALLET,
      "arb_morphoblue",
      "GLV [WETH-USDC]",
    );
    expect(morpho).toBeDefined();

    // Σ linkedCostBasisUsd 3 fills = $4,704.48 + $8,124.30 + $4,801.77
    // = $17,630.55. Все 11,287 GLV supplied to Morpho. Ожидаем cost
    // basis ≈ $17,630 (с допуском на FIFO/WAC точность ±$50).
    //
    // ВАЖНО: до C8 fix значение было ~$13,479 (m.usd на момент supply)
    // — это market fallback вместо реального fiat trail. Тест ловит
    // этот баг.
    expect(morpho!.currentCostBasisUsd).toBeGreaterThan(17_500);
    expect(morpho!.currentCostBasisUsd).toBeLessThan(17_750);
  });
});
