/**
 * B5 (6b core) — UcbShadowRunner: raw DeBank → adapted liveByWalletId →
 * runForAccount. Driven by the captured murat raw-DeBank fixture (no network).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import {
  UcbShadowRunner,
  type DeBankRawSource,
  type WalletAddressSource,
  type ShadowServiceLike,
} from "./ucb-shadow-runner.js";
import type { FlagResolver } from "./ucb-shadow.service.js";

const MURAT_ADDR = "0x1bd62bdb16ee94f2cd1f666dcb41dd6ea625d041";

function loadRaw(name: string): unknown {
  return JSON.parse(
    readFileSync(
      new URL(`./__fixtures__/debank-raw/${name}`, import.meta.url),
      "utf8",
    ),
  );
}

// DeBank stub: returns the captured murat fixture for murat's address.
const debank: DeBankRawSource = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  complexProtocolList: async () => loadRaw("murat-protocols.json") as any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  allTokens: async () => loadRaw("murat-tokens.json") as any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  totalBalance: async () => loadRaw("murat-total.json") as any,
};

const walletSource: WalletAddressSource = {
  evmWalletsForAccount: async () => [
    { id: "murat-wallet", name: "murat", createdAt: new Date(0), address: MURAT_ADDR },
  ],
};

function makeRunner(over: {
  flagOn?: boolean;
  runForAccount?: ShadowServiceLike["runForAccount"];
  debank?: DeBankRawSource;
  cexSource?: import("./ucb-shadow-runner.js").CexCostBasisSource;
} = {}) {
  const flags: FlagResolver = { enabled: async () => over.flagOn ?? true };
  const runForAccount =
    over.runForAccount ??
    (vi.fn(async () => ({ skipped: false, id: "s1", positionCount: 0 })) as ShadowServiceLike["runForAccount"]);
  const shadowService: ShadowServiceLike = { runForAccount };
  return {
    runner: new UcbShadowRunner({
      debank: over.debank ?? debank,
      walletSource,
      shadowService,
      flags,
      ...(over.cexSource && { cexSource: over.cexSource }),
    }),
    runForAccount,
  };
}

describe("UcbShadowRunner.run", () => {
  it("flag OFF → skipped, NO DeBank fetch", async () => {
    const complexProtocolList = vi.fn(async () => [] as never);
    const { runner, runForAccount } = makeRunner({
      flagOn: false,
      debank: { ...debank, complexProtocolList },
    });
    const r = await runner.run("acc");
    expect(r).toEqual({ skipped: true });
    expect(complexProtocolList).not.toHaveBeenCalled();
    expect(runForAccount).not.toHaveBeenCalled();
  });

  it("flag ON → adapts murat raw DeBank → 8-position live → runForAccount", async () => {
    let captured: ReadonlyMap<string, import("@cap-flow/ucb/live").LiveSnapshot> | undefined;
    const runForAccount = vi.fn(async (_acc: string, opts: { liveByWalletId?: ReadonlyMap<string, import("@cap-flow/ucb/live").LiveSnapshot> }) => {
      captured = opts.liveByWalletId;
      return { skipped: false, id: "s1", positionCount: 8 };
    }) as unknown as ShadowServiceLike["runForAccount"];
    const { runner } = makeRunner({ runForAccount });

    const r = await runner.run("acc", "manual");
    expect(r.skipped).toBe(false);

    const live = captured?.get("murat-wallet");
    expect(live, "murat live assembled").toBeDefined();
    // 8 positions from the raw DeBank (Fluid ETH+WBTC, GMX x4, Uniswap V3 x2).
    expect(live!.positions.length).toBe(8);
    expect(live!.tokens.length).toBeGreaterThan(0);
    expect(live!.totalUsd).toBeGreaterThan(0);
    // protocols present
    const protoIds = new Set(live!.positions.map((p) => p.protocolId));
    expect(protoIds).toContain("arb_fluid");
    expect(protoIds).toContain("arb_gmx2");
    expect(protoIds).toContain("arb_uniswap3");
  });

  it("B2: cexSource result flows into runForAccount (cexCostBasisByHash)", async () => {
    const cexMap = new Map([
      ["0xabc", { costBasisUsd: 1234, source: "inherited", asset: "ETH" }],
    ]);
    const byHashForAccount = vi.fn(async () => cexMap);
    let captured: unknown;
    const runForAccount = vi.fn(async (_acc: string, opts: { cexCostBasisByHash?: unknown }) => {
      captured = opts.cexCostBasisByHash;
      return { skipped: false, id: "s1", positionCount: 0 };
    }) as unknown as ShadowServiceLike["runForAccount"];
    const { runner } = makeRunner({ runForAccount, cexSource: { byHashForAccount } });

    await runner.run("acc-7");
    expect(byHashForAccount).toHaveBeenCalledWith("acc-7");
    expect(captured).toBe(cexMap);
  });

  it("B2: cexSource failure is swallowed (shadow still runs, no cex map)", async () => {
    let opts: { cexCostBasisByHash?: unknown } | undefined;
    const runForAccount = vi.fn(async (_acc: string, o: { cexCostBasisByHash?: unknown }) => {
      opts = o;
      return { skipped: false, id: "s1", positionCount: 0 };
    }) as unknown as ShadowServiceLike["runForAccount"];
    const { runner } = makeRunner({
      runForAccount,
      cexSource: { byHashForAccount: async () => { throw new Error("cex down"); } },
    });
    const r = await runner.run("acc");
    expect(r.skipped).toBe(false); // shadow still ran
    expect(opts?.cexCostBasisByHash).toBeUndefined(); // fail-soft → no cex map
  });
});
