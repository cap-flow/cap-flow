import { describe, expect, it, vi } from "vitest";

import {
  ChainClassifierService,
  type EvmHistoryFetcher,
  type EvmLogsFetcher,
  type SolanaHistoryFetcher,
} from "./chain_classifier.service.js";
import type { DeBankHistoryItem, DeBankToken } from "./debank_types.js";
import type { HeliusTransaction } from "./helius_types.js";

/* ------------------------- helpers ----------------------------------------- */

interface FlagStub {
  enabled: (key: string, ctx: { accountId?: string | null }) => Promise<boolean>;
}

function flagStub(value: boolean): FlagStub {
  return {
    enabled: vi.fn(async () => value),
  };
}

const SELF_EVM = "0xself0000000000000000000000000000000000aa";
const EXTERNAL_EVM = "0xexternal000000000000000000000000000000bb";
const SELF_SOL = "SelfSolanaAddr111111111111111111111111111";
const EXTERNAL_SOL = "ExtSolanaAddr11111111111111111111111111111";

const USDC_TOKEN: DeBankToken = {
  id: "arb:usdc",
  chain: "arb",
  name: "USDC",
  symbol: "USDC",
  decimals: 6,
  logo_url: null,
  price: 1,
};
const ETH_TOKEN: DeBankToken = {
  id: "arb:eth",
  chain: "arb",
  name: "ETH",
  symbol: "ETH",
  decimals: 18,
  logo_url: null,
  price: 2000,
};

function deBankItem(opts: {
  id: string;
  time: number;
  sends?: Array<{ tokenId: string; amount: number }>;
  receives?: Array<{ tokenId: string; amount: number }>;
}): DeBankHistoryItem {
  return {
    id: opts.id,
    chain: "arb",
    cate_id: null,
    time_at: opts.time,
    project_id: null,
    cex_id: null,
    sends: (opts.sends ?? []).map((s) => ({
      token_id: s.tokenId,
      amount: s.amount,
    })),
    receives: (opts.receives ?? []).map((r) => ({
      token_id: r.tokenId,
      amount: r.amount,
    })),
    token_approve: null,
    tx: {
      from_addr: SELF_EVM,
      to_addr: EXTERNAL_EVM,
      status: 1,
      usd_gas_fee: 0.5,
    },
  };
}

function heliusTx(opts: {
  signature: string;
  time: number;
  source?: string;
  type?: string;
}): HeliusTransaction {
  return {
    signature: opts.signature,
    timestamp: opts.time,
    type: opts.type ?? "TRANSFER",
    source: opts.source ?? "SYSTEM_PROGRAM",
    slot: 0,
    fee: 5000,
    feePayer: SELF_SOL,
    transactionError: null,
    nativeTransfers: [],
    tokenTransfers: [
      {
        fromUserAccount: SELF_SOL,
        toUserAccount: EXTERNAL_SOL,
        mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        tokenAmount: 100,
      },
    ],
  };
}

/* ------------------------- tests ------------------------------------------- */

describe("ChainClassifierService — flag gating", () => {
  it("returns enabled=false short-circuit when flag is OFF (no fetcher calls)", async () => {
    const flags = flagStub(false);
    const evm: EvmHistoryFetcher = vi.fn(async () => ({
      history_list: [],
      token_dict: {},
      project_dict: {},
      cex_dict: {},
    }));
    const svc = new ChainClassifierService(flags, evm, null);
    const r = await svc.analyzeAccount({
      accountId: "acct-1",
      addresses: [{ address: SELF_EVM, type: "evm" }],
    });
    expect(r.enabled).toBe(false);
    expect(r.classified).toBe(0);
    expect(evm).not.toHaveBeenCalled();
  });

  it("calls fetcher when flag is ON", async () => {
    const flags = flagStub(true);
    const evm: EvmHistoryFetcher = vi.fn(async () => ({
      history_list: [],
      token_dict: {},
      project_dict: {},
      cex_dict: {},
    }));
    const svc = new ChainClassifierService(flags, evm, null);
    await svc.analyzeAccount({
      accountId: "acct-1",
      addresses: [{ address: SELF_EVM, type: "evm" }],
    });
    expect(evm).toHaveBeenCalledWith(SELF_EVM);
  });
});

describe("ChainClassifierService — classification + LP attribution", () => {
  it("classifies EVM history and reports counts (no project → swap fallback)", async () => {
    const flags = flagStub(true);
    const evm: EvmHistoryFetcher = vi.fn(async () => ({
      history_list: [
        deBankItem({
          id: "0xa",
          time: 100,
          sends: [{ tokenId: "arb:usdc", amount: 100 }],
          receives: [{ tokenId: "arb:eth", amount: 0.05 }],
        }),
      ],
      token_dict: { "arb:usdc": USDC_TOKEN, "arb:eth": ETH_TOKEN },
      project_dict: {},
      cex_dict: {},
    }));
    const svc = new ChainClassifierService(flags, evm, null);
    const r = await svc.analyzeAccount({
      accountId: "acct-1",
      addresses: [{ address: SELF_EVM, type: "evm" }],
    });
    expect(r.enabled).toBe(true);
    expect(r.classified).toBe(1);
    expect(r.byType["swap"]).toBe(1);
    expect(r.lpAttributions).toBe(0);
  });

  it("computes LP attribution: 1 lp_add + 1 lp_remove same protocol → 1 attribution", async () => {
    const flags = flagStub(true);
    const items: DeBankHistoryItem[] = [
      {
        id: "0xadd",
        chain: "arb",
        cate_id: null,
        time_at: 100,
        project_id: "arb_uniswap3",
        cex_id: null,
        sends: [{ token_id: "arb:usdc", amount: 1000 }],
        receives: [{ token_id: "arb:lp", amount: 1 }],
        token_approve: null,
        tx: { from_addr: SELF_EVM, to_addr: EXTERNAL_EVM, status: 1 },
      },
      {
        id: "0xclose",
        chain: "arb",
        cate_id: null,
        time_at: 200,
        project_id: "arb_uniswap3",
        cex_id: null,
        sends: [{ token_id: "arb:lp", amount: 1 }],
        receives: [{ token_id: "arb:usdc", amount: 950 }],
        token_approve: null,
        tx: { from_addr: SELF_EVM, to_addr: EXTERNAL_EVM, status: 1 },
      },
    ];
    const evm: EvmHistoryFetcher = vi.fn(async () => ({
      history_list: items,
      token_dict: {
        "arb:usdc": USDC_TOKEN,
        "arb:lp": {
          id: "arb:lp",
          chain: "arb",
          name: "UNI-V3 Pool",
          symbol: "UNI-V3",
          decimals: 18,
          logo_url: null,
        },
      },
      project_dict: {
        arb_uniswap3: {
          id: "arb_uniswap3",
          chain: "arb",
          name: "Uniswap V3",
          logo_url: null,
        },
      },
      cex_dict: {},
    }));
    const svc = new ChainClassifierService(flags, evm, null);
    const r = await svc.analyzeAccount({
      accountId: "acct-1",
      addresses: [{ address: SELF_EVM, type: "evm" }],
    });
    expect(r.classified).toBe(2);
    expect(r.byType["lp_add"]).toBe(1);
    expect(r.byType["lp_remove"]).toBe(1);
    expect(r.lpAttributions).toBe(1);
  });
});

describe("ChainClassifierService — Solana path", () => {
  it("classifies Helius transactions when sol fetcher is provided", async () => {
    const flags = flagStub(true);
    const sol: SolanaHistoryFetcher = vi.fn(async () => [
      heliusTx({ signature: "sig1", time: 100, source: "JUPITER", type: "SWAP" }),
    ]);
    const svc = new ChainClassifierService(flags, null, sol);
    const r = await svc.analyzeAccount({
      accountId: "acct-1",
      addresses: [{ address: SELF_SOL, type: "solana" }],
    });
    expect(r.classified).toBe(1);
    expect(r.byType["swap"]).toBe(1);
  });

  it("skips Solana addresses when sol fetcher is null", async () => {
    const flags = flagStub(true);
    const svc = new ChainClassifierService(flags, null, null);
    const r = await svc.analyzeAccount({
      accountId: "acct-1",
      addresses: [{ address: SELF_SOL, type: "solana" }],
    });
    expect(r.classified).toBe(0);
    expect(r.skippedSolana).toBe(1);
  });
});

describe("ChainClassifierService — fail-soft", () => {
  it("returns error in result instead of throwing when fetcher throws", async () => {
    const flags = flagStub(true);
    const evm: EvmHistoryFetcher = vi.fn(async () => {
      throw new Error("DeBank 503");
    });
    const svc = new ChainClassifierService(flags, evm, null);
    const r = await svc.analyzeAccount({
      accountId: "acct-1",
      addresses: [{ address: SELF_EVM, type: "evm" }],
    });
    expect(r.enabled).toBe(true);
    expect(r.classified).toBe(0);
    expect(r.errors).toContain("DeBank 503");
  });

  it("one address error does not stop others", async () => {
    const flags = flagStub(true);
    let callN = 0;
    const evm: EvmHistoryFetcher = vi.fn(async () => {
      callN++;
      if (callN === 1) throw new Error("bad first");
      return {
        history_list: [
          deBankItem({
            id: "0xa",
            time: 100,
            sends: [{ tokenId: "arb:usdc", amount: 100 }],
            receives: [{ tokenId: "arb:eth", amount: 0.05 }],
          }),
        ],
        token_dict: { "arb:usdc": USDC_TOKEN, "arb:eth": ETH_TOKEN },
        project_dict: {},
        cex_dict: {},
      };
    });
    const svc = new ChainClassifierService(flags, evm, null);
    const r = await svc.analyzeAccount({
      accountId: "acct-1",
      addresses: [
        { address: SELF_EVM, type: "evm" },
        { address: EXTERNAL_EVM, type: "evm" },
      ],
    });
    expect(r.errors.length).toBe(1);
    expect(r.classified).toBe(1);
  });
});

describe("ChainClassifierService — topic0 log-fetch (этап 1.2)", () => {
  // Выверенный topic0 Aave V3 Supply (см. topic0_dict). classifyByTopic0 → lend_supply.
  const AAVE_SUPPLY =
    "0x2b627736bca15cd5381dcf80b0bf11fd197d01a037c52b927a881a10fb73ba61";

  // Флаг-стаб с per-key значениями (main vs topic0).
  function keyedFlags(map: Record<string, boolean>): FlagStub {
    return { enabled: vi.fn(async (key: string) => map[key] ?? false) };
  }

  // history с одним swap (USDC→ETH, без проекта → swap).
  const swapHistory = () => ({
    history_list: [
      deBankItem({
        id: "0xswap",
        time: 100,
        sends: [{ tokenId: "arb:usdc", amount: 100 }],
        receives: [{ tokenId: "arb:eth", amount: 0.05 }],
      }),
    ],
    token_dict: { "arb:usdc": USDC_TOKEN, "arb:eth": ETH_TOKEN },
    project_dict: {},
    cex_dict: {},
  });

  it("topic0 ON + logs → событие перебивает DeBank-эвристику (swap → lend_supply)", async () => {
    const flags = keyedFlags({
      "chain_classifier.enabled": true,
      "chain_classifier.topic0.enabled": true,
    });
    const evm: EvmHistoryFetcher = vi.fn(async () => swapHistory());
    const logsFn = vi.fn(
      async (items: ReadonlyArray<{ chain: string; txHash: string }>) => {
        const m = new Map<
          string,
          { address: string; topic0: string; data: string }[]
        >();
        for (const it of items) {
          m.set(it.txHash.toLowerCase(), [
            { address: "0xpool", topic0: AAVE_SUPPLY, data: "0x" },
          ]);
        }
        return m;
      }
    );
    const logs: EvmLogsFetcher = logsFn;
    const svc = new ChainClassifierService(flags, evm, null, logs);
    const r = await svc.analyzeAccount({
      accountId: "acct-1",
      addresses: [{ address: SELF_EVM, type: "evm" }],
    });
    expect(r.byType["lend_supply"]).toBe(1);
    expect(r.byType["swap"]).toBeUndefined();
    // фетч вызван только для нетривиального swap-хэша.
    expect(logsFn).toHaveBeenCalledTimes(1);
    expect(logsFn.mock.calls[0]![0]).toEqual([
      { chain: "arb", txHash: "0xswap" },
    ]);
  });

  it("topic0 флаг OFF (main ON) + адаптер есть → фетч НЕ вызывается, swap остаётся", async () => {
    const flags = keyedFlags({
      "chain_classifier.enabled": true,
      "chain_classifier.topic0.enabled": false,
    });
    const evm: EvmHistoryFetcher = vi.fn(async () => swapHistory());
    const logs: EvmLogsFetcher = vi.fn(async () => new Map());
    const svc = new ChainClassifierService(flags, evm, null, logs);
    const r = await svc.analyzeAccount({
      accountId: "acct-1",
      addresses: [{ address: SELF_EVM, type: "evm" }],
    });
    expect(r.byType["swap"]).toBe(1);
    expect(logs).not.toHaveBeenCalled();
  });

  it("fail-soft: фетч логов кидает → классификация без логов (swap), ошибка записана", async () => {
    const flags = keyedFlags({
      "chain_classifier.enabled": true,
      "chain_classifier.topic0.enabled": true,
    });
    const evm: EvmHistoryFetcher = vi.fn(async () => swapHistory());
    const logs: EvmLogsFetcher = vi.fn(async () => {
      throw new Error("alchemy 429");
    });
    const svc = new ChainClassifierService(flags, evm, null, logs);
    const r = await svc.analyzeAccount({
      accountId: "acct-1",
      addresses: [{ address: SELF_EVM, type: "evm" }],
    });
    expect(r.byType["swap"]).toBe(1); // упал на существующую лестницу
    expect(r.errors.some((e) => e.includes("topic0 log-fetch"))).toBe(true);
  });

  it("тривиальные ops (transfer_out) не попадают в фетч-список", async () => {
    const flags = keyedFlags({
      "chain_classifier.enabled": true,
      "chain_classifier.topic0.enabled": true,
    });
    const evm: EvmHistoryFetcher = vi.fn(async () => ({
      history_list: [
        deBankItem({
          id: "0xswap",
          time: 100,
          sends: [{ tokenId: "arb:usdc", amount: 100 }],
          receives: [{ tokenId: "arb:eth", amount: 0.05 }],
        }),
        // чистый out на внешний → transfer_out (тривиальный, без receipts).
        deBankItem({
          id: "0xout",
          time: 50,
          sends: [{ tokenId: "arb:usdc", amount: 25 }],
        }),
      ],
      token_dict: { "arb:usdc": USDC_TOKEN, "arb:eth": ETH_TOKEN },
      project_dict: {},
      cex_dict: {},
    }));
    const logsFn = vi.fn(
      async (_items: ReadonlyArray<{ chain: string; txHash: string }>) =>
        new Map<string, { address: string; topic0: string; data: string }[]>()
    );
    const logs: EvmLogsFetcher = logsFn;
    const svc = new ChainClassifierService(flags, evm, null, logs);
    await svc.analyzeAccount({
      accountId: "acct-1",
      addresses: [{ address: SELF_EVM, type: "evm" }],
    });
    const fetched = logsFn.mock.calls[0]![0];
    const hashes = fetched.map((x) => x.txHash);
    expect(hashes).toContain("0xswap");
    expect(hashes).not.toContain("0xout");
  });
});

describe("ChainClassifierService — flag key + context", () => {
  it("checks the canonical flag key with accountId context", async () => {
    const enabledFn = vi.fn(async () => false);
    const flags: FlagStub = { enabled: enabledFn };
    const svc = new ChainClassifierService(flags, null, null);
    await svc.analyzeAccount({ accountId: "acct-1", addresses: [] });
    expect(enabledFn).toHaveBeenCalledWith("chain_classifier.enabled", {
      accountId: "acct-1",
    });
  });
});
