/**
 * Стартовый капитал в $ ФИКСИРУЕТСЯ из `fiatPurchase.usdAmount` и НЕ
 * пересчитывается по текущему курсу рубля. Регрессия: раньше Σ рублёвых
 * пометок делилась на сегодняшний курс ЦБ → стартовый капитал «дышал» от
 * курса (304 000 ₽ → $4 149 вместо реально вложенных $3 907).
 */
import { describe, expect, it } from "vitest";

import { computeDashboardMetrics } from "./metrics";
import type { Loaded } from "@/components/data/LoadedWalletsProvider";
import {
  annotationKey,
  type FiatPurchaseAnnotation,
  type OpAnnotations,
} from "@/lib/portfolio/manual_annotations";
import type { ClassifiedOp } from "@/lib/portfolio/types";

const WALLET_ID = "w1";

function op(hash: string, time = 1000, chain = "eth"): ClassifiedOp {
  return {
    hash,
    type: "transfer_in" as never,
    time,
    chain,
    status: "success",
    movement: [],
    fnName: "",
    cateId: "",
    counter: "",
    counterName: "",
    project: null,
    protocol: null,
    fees: { gasUsd: 0, otherUsd: 0 },
    notes: [],
    seq: 0,
    isInternal: false,
    counterAddresses: [],
    netUsd: 0,
    gasUsd: 0,
  } as ClassifiedOp;
}

function loaded(ops: ClassifiedOp[]): Loaded {
  return {
    wallet: {
      id: WALLET_ID,
      name: "Murat",
      address: "0xabc",
      chain: "evm",
    },
    ops,
    snapshot: { totalGasUsd: 0, realizedPnlUsd: 0 },
    loadedAt: 0,
  } as unknown as Loaded;
}

function annotate(
  ops: ClassifiedOp[],
  fiat: Record<string, FiatPurchaseAnnotation>,
): OpAnnotations {
  const out: OpAnnotations = {};
  for (const o of ops) {
    const fp = fiat[o.hash];
    if (fp) {
      out[annotationKey({ walletId: WALLET_ID, chain: o.chain, hash: o.hash })] =
        { fiatPurchase: fp };
    }
  }
  return out;
}

describe("computeDashboardMetrics — стартовый капитал (фикс. $)", () => {
  it("берёт зафиксированный usdAmount, НЕ пересчитывает RUB по курсу", () => {
    const ops = [op("0x1"), op("0x2")];
    const annotations = annotate(ops, {
      "0x1": { fiatAmount: 10967.35, fiatCurrency: "RUB", usdAmount: 140 },
      "0x2": { fiatAmount: 199762.47, fiatCurrency: "RUB", usdAmount: 2550 },
    });

    const m = computeDashboardMetrics([loaded(ops)], annotations, {
      usdRub: 73.27, // сегодняшний курс — НЕ должен влиять на стартовый $
    });

    // Фикс: Σ usdAmount, а не (10967.35 + 199762.47) / 73.27 = $2 875.
    expect(m.startUsdAll).toBeCloseTo(2690, 6);
    expect(m.startUsdEffective).toBeCloseTo(2690, 6);
    // ₽ остаётся фактической суммой потраченного фиата.
    expect(m.startRub).toBeCloseTo(210729.82, 2);
  });

  it("стартовый $ не меняется при изменении текущего курса", () => {
    const ops = [op("0x1")];
    const annotations = annotate(ops, {
      "0x1": { fiatAmount: 50000, fiatCurrency: "RUB", usdAmount: 664.93 },
    });

    const a = computeDashboardMetrics([loaded(ops)], annotations, {
      usdRub: 73,
    });
    const b = computeDashboardMetrics([loaded(ops)], annotations, {
      usdRub: 95,
    });
    expect(a.startUsdAll).toBeCloseTo(664.93, 6);
    expect(b.startUsdAll).toBeCloseTo(664.93, 6);
  });

  it("legacy-пометка без usdAmount → fallback на текущий курс", () => {
    const ops = [op("0x1")];
    const annotations = annotate(ops, {
      "0x1": { fiatAmount: 73000, fiatCurrency: "RUB" },
    });
    const m = computeDashboardMetrics([loaded(ops)], annotations, {
      usdRub: 73,
    });
    expect(m.startUsdAll).toBeCloseTo(1000, 6); // 73000 / 73
  });

  it("валюта USD → usdAmount = fiatAmount даже без явного поля", () => {
    const ops = [op("0x1")];
    const annotations = annotate(ops, {
      "0x1": { fiatAmount: 500, fiatCurrency: "USD" },
    });
    const m = computeDashboardMetrics([loaded(ops)], annotations, {
      usdRub: 73,
    });
    expect(m.startUsdAll).toBeCloseTo(500, 6);
  });
});
