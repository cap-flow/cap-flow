/**
 * Property-based fuzz: для случайной последовательности
 * (buy_with_USDC → lend_supply → lend_withdraw) на одном символе
 * должен выполняться инвариант
 *
 *   Σ position.currentCostBasisUsd  +  Σ remaining_lot_cost
 *   ≈  Σ real_money_in (USD на покупки)
 *
 * Это формальная версия «нельзя из воздуха создать или потерять
 * стартовый капитал». Если эта invariant ломается — где-то walker
 * молча сделал fallback на m.usd (Паттерн 1 в methodology),
 * или handler не consume'ил lot правильно.
 *
 * Тест **детерминированный** (seeded LCG). При фейле — printable
 * scenario log в expect message чтобы можно было воспроизвести.
 *
 * См. capflow_anti_recurrence_methodology.md → действие #2.
 */
import { describe, expect, it } from "vitest";

import { runUcbPipelineForWallet } from "./ucb_pipeline";
import type { ClassifiedOp, TokenMovement } from "./types";

// ─── Detеrministic LCG (no fast-check dependency) ───────────────────

class Rng {
  private state: number;
  constructor(seed: number) {
    this.state = seed >>> 0 || 1;
  }
  next(): number {
    // Numerical Recipes LCG
    this.state = (this.state * 1664525 + 1013904223) >>> 0;
    return this.state / 0x1_0000_0000;
  }
  int(min: number, maxExcl: number): number {
    return Math.floor(this.next() * (maxExcl - min)) + min;
  }
  pick<T>(arr: readonly T[]): T {
    return arr[this.int(0, arr.length)]!;
  }
}

// ─── Synthetic flow generator ───────────────────────────────────────

const WALLET = "wfuzz";
const ARB = "arb";
const PROTO = {
  id: "arb_aave3",
  name: "Aave V3",
  category: "lending" as const,
};

interface Step {
  kind: "buy" | "supply" | "withdraw";
  amount: number; // WBTC amount
  usdAtMoment: number; // current spot
}

interface Scenario {
  seed: number;
  steps: Step[];
  totalSpentUsd: number;
}

function generateScenario(seed: number): Scenario {
  const rng = new Rng(seed);
  const stepCount = rng.int(5, 15);
  const steps: Step[] = [];
  let heldUnsupplied = 0; // WBTC in wallet, not yet supplied
  let supplied = 0; // WBTC supplied to Aave (receipt token in wallet)
  let totalSpent = 0;
  // Price drifts ±5% per step around $90k
  let price = 90_000;

  for (let i = 0; i < stepCount; i++) {
    price = price * (0.95 + rng.next() * 0.1);

    // Force buy at start, then mix.
    const canSupply = heldUnsupplied > 1e-6;
    const canWithdraw = supplied > 1e-6;
    const action = (() => {
      if (i === 0) return "buy" as const;
      const r = rng.next();
      if (canSupply && canWithdraw) {
        if (r < 0.3) return "buy" as const;
        if (r < 0.65) return "supply" as const;
        return "withdraw" as const;
      }
      if (canSupply) return r < 0.4 ? "buy" : ("supply" as const);
      if (canWithdraw) return r < 0.4 ? "buy" : ("withdraw" as const);
      return "buy" as const;
    })();

    if (action === "buy") {
      // Spend $1k..$10k.
      const spendUsd = 1000 + rng.int(0, 9_000);
      const amount = spendUsd / price;
      steps.push({ kind: "buy", amount, usdAtMoment: spendUsd });
      heldUnsupplied += amount;
      totalSpent += spendUsd;
    } else if (action === "supply") {
      // Supply 20%..100% of holding.
      const frac = 0.2 + rng.next() * 0.8;
      const amount = heldUnsupplied * frac;
      const usdAtMoment = amount * price;
      steps.push({ kind: "supply", amount, usdAtMoment });
      heldUnsupplied -= amount;
      supplied += amount;
    } else {
      // Withdraw 20%..100% of supplied.
      const frac = 0.2 + rng.next() * 0.8;
      const amount = supplied * frac;
      const usdAtMoment = amount * price;
      steps.push({ kind: "withdraw", amount, usdAtMoment });
      supplied -= amount;
      heldUnsupplied += amount;
    }
  }

  return { seed, steps, totalSpentUsd: totalSpent };
}

function scenarioToOps(scn: Scenario): ClassifiedOp[] {
  const ops: ClassifiedOp[] = [];
  let t = 1_700_000_000;
  for (let i = 0; i < scn.steps.length; i++) {
    const s = scn.steps[i]!;
    t += 3600; // 1h apart
    if (s.kind === "buy") {
      ops.push(
        op({
          hash: `0xbuy${i}`,
          type: "swap",
          time: t,
          movements: [
            mvOut("USDC", s.usdAtMoment, s.usdAtMoment, true),
            mvIn(
              "WBTC",
              s.amount,
              s.usdAtMoment,
              "0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f",
            ),
          ],
        }),
      );
    } else if (s.kind === "supply") {
      ops.push(
        op({
          hash: `0xsup${i}`,
          type: "lend_supply",
          time: t,
          protocol: PROTO,
          movements: [
            mvOut(
              "WBTC",
              s.amount,
              s.usdAtMoment,
              false,
              "0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f",
            ),
            // Aave receipt token
            {
              direction: "in",
              symbol: "aArbWBTC",
              amount: s.amount,
              usd: s.usdAtMoment,
              tokenId: "0x191c10aa4af7c30e871e70c95db0e4eb77237530",
              isProtocolToken: true,
              isStable: false,
            } as TokenMovement,
          ],
        }),
      );
    } else {
      ops.push(
        op({
          hash: `0xwith${i}`,
          type: "lend_withdraw",
          time: t,
          protocol: PROTO,
          movements: [
            {
              direction: "out",
              symbol: "aArbWBTC",
              amount: s.amount,
              usd: s.usdAtMoment,
              tokenId: "0x191c10aa4af7c30e871e70c95db0e4eb77237530",
              isProtocolToken: true,
              isStable: false,
            } as TokenMovement,
            mvIn(
              "WBTC",
              s.amount,
              s.usdAtMoment,
              "0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f",
            ),
          ],
        }),
      );
    }
  }
  return ops;
}

function mvOut(
  symbol: string,
  amount: number,
  usd: number,
  isStable = false,
  tokenId?: string,
): TokenMovement {
  return {
    direction: "out",
    symbol,
    amount,
    usd,
    tokenId: tokenId ?? symbol.toLowerCase(),
    isStable,
    isProtocolToken: false,
  } as TokenMovement;
}

function mvIn(
  symbol: string,
  amount: number,
  usd: number,
  tokenId: string,
): TokenMovement {
  return {
    direction: "in",
    symbol,
    amount,
    usd,
    tokenId,
    isStable: false,
    isProtocolToken: false,
  } as TokenMovement;
}

function op(spec: {
  hash: string;
  type: ClassifiedOp["type"];
  time: number;
  movements: TokenMovement[];
  protocol?: { id: string; name: string; category: string } | null;
}): ClassifiedOp {
  return {
    hash: spec.hash,
    type: spec.type,
    time: spec.time,
    chain: ARB,
    status: "success",
    movement: spec.movements,
    protocol: spec.protocol ?? null,
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

// ─── Invariant assertion ────────────────────────────────────────────

function describeScenario(scn: Scenario): string {
  return scn.steps
    .map(
      (s, i) =>
        `${i + 1}. ${s.kind} amount=${s.amount.toFixed(6)} usd=${s.usdAtMoment.toFixed(2)}`,
    )
    .join("\n");
}

describe("Cost basis invariant (deterministic fuzz)", () => {
  // 30 detеrministic seeds; раскомментировать seed 12345 для repro.
  const SEEDS = Array.from({ length: 30 }, (_, i) => i + 1);

  for (const seed of SEEDS) {
    it(`seed=${seed}: Σ cost basis ≈ real money spent`, () => {
      const scn = generateScenario(seed);
      const ops = scenarioToOps(scn);
      const result = runUcbPipelineForWallet({
        walletId: WALLET,
        ops,
        annotationsByKey: new Map(),
        walletNameById: new Map([[WALLET, "Fuzz Wallet"]]),
      });

      expect(result.positionTracker).toBeDefined();

      // Σ cost basis по всем open positions для этого wallet'а.
      const positionsCost = result
        .positionTracker!.all()
        .filter((p) => p.walletId === WALLET)
        .reduce((s, p) => s + p.currentCostBasisUsd, 0);

      // Σ cost remaining в WBTC лотах (не supplied или withdrawn back).
      const remainingLots = result.lotTracker
        .getLots(WALLET, "WBTC")
        .reduce((s, l) => s + l.amount * l.costPerUnitUsd, 0);

      const totalCost = positionsCost + remainingLots;
      const expected = scn.totalSpentUsd;

      // Допуск 0.5% — мелкий numerical drift по WAC normalization
      // accept'ится. Если walker молча fallback'нулся на market price,
      // расхождение будет >> 0.5% (как в баге artur — $17k vs $20k).
      const tolerance = Math.max(expected * 0.005, 1);
      const diff = Math.abs(totalCost - expected);
      if (diff > tolerance) {
        // Печатаем сценарий для repro.
        const msg = [
          `INVARIANT BROKEN seed=${seed}`,
          `  expected total cost = ${expected.toFixed(2)}`,
          `  positions cost      = ${positionsCost.toFixed(2)}`,
          `  remaining lots cost = ${remainingLots.toFixed(2)}`,
          `  total               = ${totalCost.toFixed(2)}`,
          `  diff                = ${diff.toFixed(2)} (tolerance ${tolerance.toFixed(2)})`,
          `scenario:\n${describeScenario(scn)}`,
        ].join("\n");
        throw new Error(msg);
      }
    });
  }
});
