import { describe, expect, it } from "vitest";

import {
  resolveOpenerBlocksFromAlchemy,
  resolveOpenersFromTransfers,
} from "./opener_detector";
import type { AlchemyTransfer } from "./alchemy_transfers";

type T = {
  timeStamp: number;
  blockNumber: number;
  hash: string;
  from: string;
  to: string;
  contractAddress: string;
  value: string;
  tokenDecimal: number;
  tokenSymbol: string;
};

const WALLET = "0x10b850c3abfca78d693c9cd6fce809c129109d1c";
const VAULT = "0x5401b8620e5fb570064ca9114fd1e135fd77d57c"; // Lombard LBTCv
const STAKING = "0x475be1b034139f4a0ec46dd47843aaaaaaaaaaaa"; // Convex-like contract
const STAKE_TOKEN = "0xaaaa000000000000000000000000000000000001";
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";

function tx(p: Partial<T>): T {
  return {
    timeStamp: 1700000000,
    blockNumber: 1,
    hash: "0xhash",
    from: WALLET,
    to: "0xother",
    contractAddress: "0xtoken",
    value: "1000000",
    tokenDecimal: 6,
    tokenSymbol: "TKN",
    ...p,
  };
}

describe("resolveOpenersFromTransfers", () => {
  it("vault: receipt token заминчен (contract==lpTokenId, to==wallet)", () => {
    const transfers = [
      tx({
        timeStamp: 1760606147,
        blockNumber: 23589271,
        hash: "0xmint",
        from: "0xvaultminter",
        to: WALLET,
        contractAddress: VAULT,
        value: "696635",
        tokenDecimal: 8,
      }),
    ];
    const out = resolveOpenersFromTransfers(transfers, [VAULT], WALLET);
    expect(out.size).toBe(1);
    const op = out.get(VAULT)!;
    expect(op.openedAt).toBe(1760606147);
    expect(op.openBlock).toBe(23589271);
    expect(op.receiptAmount).toBeCloseTo(0.00696635, 8);
  });

  it("staking: токен отправлен В контракт (to==lpTokenId)", () => {
    const transfers = [
      tx({
        timeStamp: 1750000000,
        blockNumber: 100,
        hash: "0xstake",
        from: WALLET,
        to: STAKING, // депозит в стейк-контракт
        contractAddress: STAKE_TOKEN,
        value: "5000000",
        tokenDecimal: 6,
      }),
    ];
    const out = resolveOpenersFromTransfers(transfers, [STAKING], WALLET);
    expect(out.size).toBe(1);
    expect(out.get(STAKING)!.openedAt).toBe(1750000000);
  });

  it("берёт САМЫЙ РАННИЙ matched transfer (несколько взаимодействий)", () => {
    const transfers = [
      tx({ timeStamp: 1760000000, to: STAKING, hash: "0xlate" }),
      tx({ timeStamp: 1750000000, to: STAKING, hash: "0xearly" }),
      tx({ timeStamp: 1755000000, to: STAKING, hash: "0xmid" }),
    ];
    const out = resolveOpenersFromTransfers(transfers, [STAKING], WALLET);
    expect(out.get(STAKING)!.openedAt).toBe(1750000000);
    expect(out.get(STAKING)!.txHash).toBe("0xearly");
  });

  it("резолвит несколько lpTokenId за один проход", () => {
    const transfers = [
      tx({ timeStamp: 1750000000, to: STAKING, hash: "0xstake" }),
      tx({ timeStamp: 1760000000, from: "0xv", to: WALLET, contractAddress: VAULT, hash: "0xmint" }),
    ];
    const out = resolveOpenersFromTransfers(transfers, [STAKING, VAULT], WALLET);
    expect(out.size).toBe(2);
    expect(out.get(STAKING)!.openedAt).toBe(1750000000);
    expect(out.get(VAULT)!.openedAt).toBe(1760000000);
  });

  it("lpTokenId без единого matched transfer → не в результате", () => {
    const transfers = [tx({ to: "0xunrelated", contractAddress: "0xunrelated" })];
    const out = resolveOpenersFromTransfers(transfers, [STAKING], WALLET);
    expect(out.size).toBe(0);
  });

  it("case-insensitive матч lpTokenId", () => {
    const transfers = [tx({ timeStamp: 1750000000, to: STAKING.toLowerCase() })];
    const out = resolveOpenersFromTransfers(transfers, [STAKING.toUpperCase()], WALLET);
    expect(out.size).toBe(1);
  });

  it("from==lpTokenId (receipt/reward пришёл из контракта) тоже матчит", () => {
    const transfers = [
      tx({ timeStamp: 1750000000, from: STAKING, to: WALLET, hash: "0xreward" }),
    ];
    const out = resolveOpenersFromTransfers(transfers, [STAKING], WALLET);
    expect(out.size).toBe(1);
    expect(out.get(STAKING)!.openedAt).toBe(1750000000);
  });

  it("пустой transfers list → пустой результат", () => {
    expect(resolveOpenersFromTransfers([], [STAKING], WALLET).size).toBe(0);
  });

  it("пустой receiptTokens list → пустой результат", () => {
    const transfers = [tx({ to: STAKING })];
    expect(resolveOpenersFromTransfers(transfers, [], WALLET).size).toBe(0);
  });
});

describe("resolveOpenerBlocksFromAlchemy", () => {
  const atx = (p: Partial<AlchemyTransfer>): AlchemyTransfer => ({
    blockNumber: 100,
    hash: "0xa",
    from: WALLET,
    to: "0xother",
    contractAddress: "0xtoken",
    amount: 0,
    symbol: "TKN",
    ...p,
  });

  it("vault: receipt mint (contract==lpTokenId) → earliest block", () => {
    const out = resolveOpenerBlocksFromAlchemy(
      [atx({ blockNumber: 70395890, hash: "0xmint", to: WALLET, contractAddress: VAULT })],
      [VAULT],
      WALLET,
    );
    expect(out.get(VAULT)!.blockNumber).toBe(70395890);
    expect(out.get(VAULT)!.hash).toBe("0xmint");
  });

  it("staking: to==lpTokenId → matched", () => {
    const out = resolveOpenerBlocksFromAlchemy(
      [atx({ blockNumber: 500, to: STAKING })],
      [STAKING],
      WALLET,
    );
    expect(out.get(STAKING)!.blockNumber).toBe(500);
  });

  it("берёт earliest по blockNumber (нет timestamp у Alchemy)", () => {
    const out = resolveOpenerBlocksFromAlchemy(
      [
        atx({ blockNumber: 900, to: STAKING, hash: "0xlate" }),
        atx({ blockNumber: 300, to: STAKING, hash: "0xearly" }),
        atx({ blockNumber: 600, to: STAKING, hash: "0xmid" }),
      ],
      [STAKING],
      WALLET,
    );
    expect(out.get(STAKING)!.blockNumber).toBe(300);
    expect(out.get(STAKING)!.hash).toBe("0xearly");
  });

  it("нет matched transfer → не в результате", () => {
    const out = resolveOpenerBlocksFromAlchemy(
      [atx({ to: "0xunrelated", contractAddress: "0xunrelated" })],
      [STAKING],
      WALLET,
    );
    expect(out.size).toBe(0);
  });

  it("OUT-side stable из avax opener tx (to==lpTokenId) → openedInTokens", () => {
    // LAGOON-like: USDC отправлен в контракт (to==lpTokenId), receipt не виден.
    const out = resolveOpenerBlocksFromAlchemy(
      [atx({ blockNumber: 700, hash: "0xdep", from: WALLET, to: STAKING, contractAddress: USDC, amount: 310, symbol: "USDC" })],
      [STAKING],
      WALLET,
    );
    const r = out.get(STAKING)!;
    expect(r.openedInTokens).toHaveLength(1);
    expect(r.openedInTokens[0]!.amount).toBe(310);
    expect(r.openedInTokens[0]!.symbol).toBe("USDC");
  });
});

describe("Stage 2: OUT-side startUsd in resolveOpenersFromTransfers", () => {
  it("IPOR-like: OUT 100 USDC + receipt mint в той же tx → startUsd=$100", () => {
    const transfers = [
      // OUT: 100 USDC от wallet в vault
      tx({ hash: "0xdep", timeStamp: 1758379691, blockNumber: 100, from: WALLET, to: "0xvault", contractAddress: USDC, value: "100000000", tokenDecimal: 6, tokenSymbol: "USDC" }),
      // IN: receipt сминчен на wallet (contract==lpTokenId)
      tx({ hash: "0xdep", timeStamp: 1758379691, blockNumber: 100, from: "0x0000000000000000000000000000000000000000", to: WALLET, contractAddress: VAULT, value: "91000000000000000000", tokenDecimal: 18, tokenSymbol: "ipReceipt" }),
    ];
    const out = resolveOpenersFromTransfers(transfers, [VAULT], WALLET);
    const op = out.get(VAULT)!;
    expect(op.openedInTokens).toHaveLength(1);
    expect(op.openedInTokens[0]!.symbol).toBe("USDC");
    expect(op.startUsd).toBe(100); // 100 USDC × $1
  });

  it("non-stable OUT (WETH) → startUsd=null (нужен Stage 2b)", () => {
    const transfers = [
      tx({ hash: "0xdep", from: WALLET, to: "0xvault", contractAddress: "0xweth", value: "1000000000000000000", tokenDecimal: 18, tokenSymbol: "WETH" }),
      tx({ hash: "0xdep", from: "0x0000000000000000000000000000000000000000", to: WALLET, contractAddress: VAULT, value: "1000000000000000000", tokenDecimal: 18, tokenSymbol: "vETH" }),
    ];
    const out = resolveOpenersFromTransfers(transfers, [VAULT], WALLET);
    expect(out.get(VAULT)!.startUsd).toBeNull();
  });

  it("OUT не в opener tx (Safe-internal) → openedInTokens пуст, startUsd null", () => {
    const transfers = [
      // Только receipt IN, без OUT в той же tx
      tx({ hash: "0xmint", from: "0xvault", to: WALLET, contractAddress: VAULT, value: "696635", tokenDecimal: 8, tokenSymbol: "LBTCv" }),
    ];
    const out = resolveOpenersFromTransfers(transfers, [VAULT], WALLET);
    expect(out.get(VAULT)!.openedInTokens).toHaveLength(0);
    expect(out.get(VAULT)!.startUsd).toBeNull();
  });

  it("Stage 2c: multi-deposit — суммирует OUT-side по нескольким deposit-tx", () => {
    const transfers = [
      // deposit 1: 100 USDC out + receipt mint в той же tx
      tx({ hash: "0xd1", timeStamp: 1, from: WALLET, to: "0xvault", contractAddress: USDC, value: "100000000", tokenDecimal: 6, tokenSymbol: "USDC" }),
      tx({ hash: "0xd1", timeStamp: 1, from: "0x0000000000000000000000000000000000000000", to: WALLET, contractAddress: VAULT, value: "1", tokenDecimal: 0, tokenSymbol: "v" }),
      // deposit 2: 50 USDC out + receipt mint
      tx({ hash: "0xd2", timeStamp: 2, from: WALLET, to: "0xvault", contractAddress: USDC, value: "50000000", tokenDecimal: 6, tokenSymbol: "USDC" }),
      tx({ hash: "0xd2", timeStamp: 2, from: "0x0000000000000000000000000000000000000000", to: WALLET, contractAddress: VAULT, value: "1", tokenDecimal: 0, tokenSymbol: "v" }),
    ];
    const out = resolveOpenersFromTransfers(transfers, [VAULT], WALLET);
    const op = out.get(VAULT)!;
    expect(op.startUsd).toBe(150); // 100 + 50
    expect(op.openedInTokens).toHaveLength(1);
    expect(op.openedInTokens[0]!.amount).toBe(150);
  });

  it("Stage 2c: withdraw-tx (receipt OUT) НЕ считается депозитом", () => {
    const transfers = [
      // deposit: 100 USDC out + receipt mint
      tx({ hash: "0xd", timeStamp: 1, from: WALLET, to: "0xvault", contractAddress: USDC, value: "100000000", tokenDecimal: 6, tokenSymbol: "USDC" }),
      tx({ hash: "0xd", timeStamp: 1, from: "0x0000000000000000000000000000000000000000", to: WALLET, contractAddress: VAULT, value: "1", tokenDecimal: 0, tokenSymbol: "v" }),
      // withdraw: receipt OUT (from wallet, contract==VAULT) + USDC возврат
      tx({ hash: "0xw", timeStamp: 2, from: WALLET, to: "0xvault", contractAddress: VAULT, value: "1", tokenDecimal: 0, tokenSymbol: "v" }),
      tx({ hash: "0xw", timeStamp: 2, from: "0xvault", to: WALLET, contractAddress: USDC, value: "40000000", tokenDecimal: 6, tokenSymbol: "USDC" }),
    ];
    const out = resolveOpenersFromTransfers(transfers, [VAULT], WALLET);
    expect(out.get(VAULT)!.startUsd).toBe(100); // только депозит, без withdraw
  });

  it("Stage 2c: Alchemy path тоже суммирует multi-deposit OUT-side", () => {
    const atx = (p: Partial<AlchemyTransfer>): AlchemyTransfer => ({
      blockNumber: 100, hash: "0xa", from: WALLET, to: "0xother",
      contractAddress: "0xtoken", amount: 0, symbol: "TKN", ...p,
    });
    const out = resolveOpenerBlocksFromAlchemy(
      [
        atx({ blockNumber: 10, hash: "0xd1", to: STAKING, contractAddress: USDC, amount: 200, symbol: "USDC" }),
        atx({ blockNumber: 20, hash: "0xd2", to: STAKING, contractAddress: USDC, amount: 100, symbol: "USDC" }),
      ],
      [STAKING],
      WALLET,
    );
    const r = out.get(STAKING)!;
    expect(r.openedInTokens).toHaveLength(1);
    expect(r.openedInTokens[0]!.amount).toBe(300); // 200 + 100
  });
});
