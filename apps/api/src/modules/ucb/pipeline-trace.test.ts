import { describe, expect, it } from "vitest";

import type { OpenPosition } from "@cap-flow/ucb/open_positions";

import { PipelineTrace, diffStartUsd, positionKey } from "./pipeline-trace.js";

function pos(startUsd: number | undefined, instanceId: string): OpenPosition {
  return {
    instanceId,
    walletId: "w1",
    protocol: { id: "arb_gmx2", name: "GMX V2" },
    ...(startUsd !== undefined && { startUsd }),
  } as unknown as OpenPosition;
}

describe("PipelineTrace", () => {
  it("записывает ok-этап с метриками и временем", async () => {
    const t = new PipelineTrace();
    const out = await t.run("build", (h) => {
      h.metric("positions", 9);
      return 42;
    });
    expect(out).toBe(42);
    expect(t.records).toHaveLength(1);
    expect(t.records[0]).toMatchObject({
      stage: "build",
      status: "ok",
      metrics: { positions: 9 },
    });
  });

  it("warn внутри этапа → статус warn, но результат возвращается", async () => {
    const t = new PipelineTrace();
    const out = await t.run("price", (h) => {
      h.warn("85 ops без исторической цены");
      return "histPrices";
    });
    expect(out).toBe("histPrices");
    expect(t.records[0]!.status).toBe("warn");
    expect(t.records[0]!.warnings).toEqual(["85 ops без исторической цены"]);
  });

  it("throw → статус fail с текстом ошибки, ошибка перебрасывается (fail-soft у вызывающего)", async () => {
    const t = new PipelineTrace();
    await expect(
      t.run("ledger", () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(t.records[0]).toMatchObject({ stage: "ledger", status: "fail" });
    expect(t.records[0]!.warnings).toEqual(["boom"]);
  });

  it("skip фиксирует пропуск с причиной", () => {
    const t = new PipelineTrace();
    t.skip("override.krystal", "нет Krystal-данных");
    expect(t.records[0]).toMatchObject({
      stage: "override.krystal",
      status: "skipped",
      warnings: ["нет Krystal-данных"],
    });
  });
});

describe("diffStartUsd", () => {
  it("фиксирует изменённые startUsd c дельтами (класс melody F2: override подменяет значение)", async () => {
    const t = new PipelineTrace();
    const before = [pos(630.92, "0x7c11"), pos(617.08, "0x47c0")];
    const after = [pos(526.98, "0x7c11"), pos(617.08, "0x47c0")];
    await t.run("override.opener", (h) => diffStartUsd(before, after, h));
    const m = t.records[0]!.metrics!;
    expect(m["changed"]).toBe(1);
    expect(String(m["deltas"])).toContain("0x7c11: 630.92 → 526.98");
  });

  it("одинаковые массивы → changed=0, без дельт", async () => {
    const t = new PipelineTrace();
    const a = [pos(100, "k1")];
    await t.run("override.lending", (h) => diffStartUsd(a, a, h));
    expect(t.records[0]!.metrics!["changed"]).toBe(0);
    expect(t.records[0]!.metrics!["deltas"]).toBeUndefined();
  });

  it("расхождение длин → warn, не падает", async () => {
    const t = new PipelineTrace();
    await t.run("override.v3", (h) => diffStartUsd([pos(1, "a")], [], h));
    expect(t.records[0]!.status).toBe("warn");
  });
});

describe("positionKey", () => {
  it("instanceId приоритетен, fallback на wallet|protocol|marketKey", () => {
    expect(positionKey(pos(1, "nft-123"))).toBe("nft-123");
    const p = { walletId: "w1", protocol: { id: "arb_aave3" } } as unknown as OpenPosition;
    expect(positionKey(p)).toBe("w1|arb_aave3|");
  });
});
