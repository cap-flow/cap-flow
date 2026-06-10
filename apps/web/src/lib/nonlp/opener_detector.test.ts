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
const ZERO = "0x0000000000000000000000000000000000000000";

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

  it("GMX V2 GLV async request/fill (POS-005): OUT-side из request-tx → startUsd=$1300", () => {
    // testakk 1s GLV [WBTC-USDC] (arb). Реальные on-chain transfer'ы:
    //   request 0x17cf @t0: wallet → GlvVault 1300 USDC (to ≠ receipt-токен!)
    //   fill    0xea23 @t0+4s: GLV сминчен from 0x0 на wallet (receives-only)
    // OUT (USDC) и mint receipt'а — в РАЗНЫХ tx → старый same-tx детект пропускал
    // request → openedInTokens пуст → costBasisUnknown затирал buildOne $1300.
    const GLV = "0xdf03eed325b82bc1d4db8b49c30ecc9e05104b96";
    const GMX_USDC = "0xaf88d065e77c8cc2239327c5edb3a432268e5831";
    const GLV_VAULT = "0x393053b58f9678c9c28c2ce941ff6cac49c3f8f9";
    const transfers = [
      tx({ hash: "0x17cf", timeStamp: 1774790684, blockNumber: 446895388, from: WALLET, to: GLV_VAULT, contractAddress: GMX_USDC, value: "1300000000", tokenDecimal: 6, tokenSymbol: "USDC" }),
      tx({ hash: "0xea23", timeStamp: 1774790688, blockNumber: 446895401, from: ZERO, to: WALLET, contractAddress: GLV, value: "1016578616393671586567", tokenDecimal: 18, tokenSymbol: "GLV [WBTC-USDC]" }),
    ];
    const out = resolveOpenersFromTransfers(transfers, [GLV], WALLET);
    const op = out.get(GLV)!;
    expect(op.openedAt).toBe(1774790688); // дата = fill (первый touch receipt-токена)
    expect(op.openedInTokens).toHaveLength(1);
    expect(op.openedInTokens[0]!.symbol).toBe("USDC");
    expect(op.openedInTokens[0]!.amount).toBe(1300);
    expect(op.startUsd).toBe(1300); // 1300 USDC × $1 — НЕ market value receipt'а
  });

  it("async request/fill: НЕ пэйрит swap (tx с wallet-IN — не sends-only)", () => {
    // За окном до mint'а есть swap (wallet и отдал, и получил) — это НЕ request.
    const GLV = "0xdf03eed325b82bc1d4db8b49c30ecc9e05104b96";
    const transfers = [
      // swap: wallet отдал USDC и получил WETH (есть wallet-IN) — не request
      tx({ hash: "0xswap", timeStamp: 1000, from: WALLET, to: "0xpool", contractAddress: USDC, value: "500000000", tokenDecimal: 6, tokenSymbol: "USDC" }),
      tx({ hash: "0xswap", timeStamp: 1000, from: "0xpool", to: WALLET, contractAddress: "0xweth", value: "100000000000000000", tokenDecimal: 18, tokenSymbol: "WETH" }),
      // fill: GLV mint from 0x0 (receives-only)
      tx({ hash: "0xfill", timeStamp: 1004, from: ZERO, to: WALLET, contractAddress: GLV, value: "1000000000000000000", tokenDecimal: 18, tokenSymbol: "GLV [WBTC-USDC]" }),
    ];
    const op = resolveOpenersFromTransfers(transfers, [GLV], WALLET).get(GLV)!;
    expect(op.openedInTokens).toHaveLength(0); // swap не засчитан как request
    expect(op.startUsd).toBeNull();
  });

  it("async request/fill: request за пределами окна → не пэйрится", () => {
    const GLV = "0xdf03eed325b82bc1d4db8b49c30ecc9e05104b96";
    const transfers = [
      // request слишком давно (>10 мин до fill) → не наш депозит
      tx({ hash: "0xold", timeStamp: 1000, from: WALLET, to: "0xvault", contractAddress: USDC, value: "1300000000", tokenDecimal: 6, tokenSymbol: "USDC" }),
      tx({ hash: "0xfill", timeStamp: 1000 + 3600, from: ZERO, to: WALLET, contractAddress: GLV, value: "1000000000000000000", tokenDecimal: 18, tokenSymbol: "GLV [WBTC-USDC]" }),
    ];
    const op = resolveOpenersFromTransfers(transfers, [GLV], WALLET).get(GLV)!;
    expect(op.openedInTokens).toHaveLength(0);
    expect(op.startUsd).toBeNull();
  });

  it("async request/fill: same-tx депозит (IPOR) НЕ ломается async-веткой", () => {
    // mint from 0x0 + OUT в ТОЙ ЖЕ tx → классический same-tx путь, async не нужен.
    const transfers = [
      tx({ hash: "0xdep", timeStamp: 100, from: WALLET, to: "0xvault", contractAddress: USDC, value: "100000000", tokenDecimal: 6, tokenSymbol: "USDC" }),
      tx({ hash: "0xdep", timeStamp: 100, from: ZERO, to: WALLET, contractAddress: VAULT, value: "91000000000000000000", tokenDecimal: 18, tokenSymbol: "ipReceipt" }),
    ];
    const op = resolveOpenersFromTransfers(transfers, [VAULT], WALLET).get(VAULT)!;
    expect(op.startUsd).toBe(100); // ровно 1 раз, без двойного счёта
    expect(op.openedInTokens).toHaveLength(1);
  });

  it("Stage 2c: withdraw-tx (receipt OUT) НЕ считается депозитом, и FULL exit → cost basis 0", () => {
    const transfers = [
      // deposit: 100 USDC out + receipt mint (1 unit)
      tx({ hash: "0xd", timeStamp: 1, from: WALLET, to: "0xvault", contractAddress: USDC, value: "100000000", tokenDecimal: 6, tokenSymbol: "USDC" }),
      tx({ hash: "0xd", timeStamp: 1, from: "0x0000000000000000000000000000000000000000", to: WALLET, contractAddress: VAULT, value: "1", tokenDecimal: 0, tokenSymbol: "v" }),
      // withdraw FULL: receipt OUT (from wallet) + USDC возврат
      tx({ hash: "0xw", timeStamp: 2, from: WALLET, to: "0xvault", contractAddress: VAULT, value: "1", tokenDecimal: 0, tokenSymbol: "v" }),
      tx({ hash: "0xw", timeStamp: 2, from: "0xvault", to: WALLET, contractAddress: USDC, value: "40000000", tokenDecimal: 6, tokenSymbol: "USDC" }),
    ];
    const op = resolveOpenersFromTransfers(transfers, [VAULT], WALLET).get(VAULT)!;
    // withdraw USDC (40) НЕ добавляется как депозит; полный вывод receipt → net 0 → cb 0.
    expect(op.startUsd).toBe(0);
    expect(op.receiptNetFraction).toBe(0);
  });

  it("partial withdrawal: cost basis netted by withdrawn receipt fraction (POS-007 GMX)", () => {
    // 2 депозита × 100 USDC → 100 GM каждый (в отдельных fill-tx, async).
    // Затем вывод 100 GM из 200 → осталось 50% → startUsd = 200 × 0.5 = 100.
    const GM = "0x77b2ec357b56c7d05a87971db0188dbb0c7836a5";
    const transfers = [
      tx({ hash: "0xreq1", timeStamp: 1000, from: WALLET, to: VAULT, contractAddress: USDC, value: "100000000", tokenDecimal: 6, tokenSymbol: "USDC" }),
      tx({ hash: "0xfill1", timeStamp: 1004, from: ZERO, to: WALLET, contractAddress: GM, value: "100000000000000000000", tokenDecimal: 18, tokenSymbol: "GM" }),
      tx({ hash: "0xreq2", timeStamp: 2000, from: WALLET, to: VAULT, contractAddress: USDC, value: "100000000", tokenDecimal: 6, tokenSymbol: "USDC" }),
      tx({ hash: "0xfill2", timeStamp: 2004, from: ZERO, to: WALLET, contractAddress: GM, value: "100000000000000000000", tokenDecimal: 18, tokenSymbol: "GM" }),
      // вывод: 100 GM из кошелька (lp_remove)
      tx({ hash: "0xwd", timeStamp: 3000, from: WALLET, to: VAULT, contractAddress: GM, value: "100000000000000000000", tokenDecimal: 18, tokenSymbol: "GM" }),
    ];
    const op = resolveOpenersFromTransfers(transfers, [GM], WALLET).get(GM)!;
    expect(op.receiptNetFraction).toBeCloseTo(0.5, 5);
    expect(op.startUsd).toBe(100); // 200 gross × 0.5 net, НЕ 200
  });

  it("no withdrawal: cost basis НЕ масштабируется (fraction 1)", () => {
    const GM = "0x77b2ec357b56c7d05a87971db0188dbb0c7836a5";
    const transfers = [
      tx({ hash: "0xreq1", timeStamp: 1000, from: WALLET, to: VAULT, contractAddress: USDC, value: "100000000", tokenDecimal: 6, tokenSymbol: "USDC" }),
      tx({ hash: "0xfill1", timeStamp: 1004, from: ZERO, to: WALLET, contractAddress: GM, value: "100000000000000000000", tokenDecimal: 18, tokenSymbol: "GM" }),
    ];
    const op = resolveOpenersFromTransfers(transfers, [GM], WALLET).get(GM)!;
    expect(op.receiptNetFraction).toBe(1);
    expect(op.startUsd).toBe(100);
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

/**
 * Owner-методика 2026-06-10 (testakk Artur GMX 0x70d9, ребаланс 2026-06-09):
 * частичный вывод + ре-депозит = ПОСЛЕДОВАТЕЛЬНАЯ WAC по конкретному
 * receipt-токену, НЕ «gross × netFraction задним числом».
 *
 *   buy  5 150.841208 GM за 9 000 USDC  → $1.7472874114/GM
 *   burn 3 090 GM → списано 3 090 × 1.7472874114 = $5 399.12
 *   buy  1 527.239336 GM за 2 308.038775 USDC
 *   → startUsd = 9 000 − 5 399.12 + 2 308.04 = $5 908.92
 *
 * Анти-таргет (старое поведение): (9 000 + 2 308.04) × (3 588.08/6 678.08)
 * = $6 075.55 — нарушает сохранение денег на $166.80 (списанная при продаже
 * база + остаток ≠ вложенное).
 */
describe("sequential per-token WAC (owner methodology 2026-06-10)", () => {
  const GM = "0x70d95587d40a2caf56bd97485ab3eec10bee6336";
  const rebalance = [
    // BUY №1: request (USDC → vault) + fill (mint GM з 0x0), async pair
    tx({ hash: "0xreq1", timeStamp: 1000, from: WALLET, to: VAULT, contractAddress: USDC, value: "9000000000", tokenDecimal: 6, tokenSymbol: "USDC" }),
    tx({ hash: "0xfill1", timeStamp: 1004, from: ZERO, to: WALLET, contractAddress: GM, value: "5150841208000000000000", tokenDecimal: 18, tokenSymbol: "GM" }),
    // BURN: 3 090 GM уходит с кошелька (запрос на вывод)
    tx({ hash: "0xburn1", timeStamp: 2000, from: WALLET, to: VAULT, contractAddress: GM, value: "3090000000000000000000", tokenDecimal: 18, tokenSymbol: "GM" }),
    // BUY №2 (ре-депозит стейбл-ноги): request + fill
    tx({ hash: "0xreq2", timeStamp: 3000, from: WALLET, to: VAULT, contractAddress: USDC, value: "2308038775", tokenDecimal: 6, tokenSymbol: "USDC" }),
    tx({ hash: "0xfill2", timeStamp: 3004, from: ZERO, to: WALLET, contractAddress: GM, value: "1527239336000000000000", tokenDecimal: 18, tokenSymbol: "GM" }),
  ];

  it("startUsd = $5 908.92 (деньги сходятся), НЕ gross×frac $6 075.55", () => {
    const op = resolveOpenersFromTransfers(rebalance, [GM], WALLET).get(GM)!;
    expect(op).toBeDefined();
    expect(op.startUsd).toBeGreaterThan(5907);
    expect(op.startUsd!).toBeLessThan(5911);
  });

  it("сохранение денег: вложено − списано при продаже = остаток", () => {
    const op = resolveOpenersFromTransfers(rebalance, [GM], WALLET).get(GM)!;
    const invested = 9000 + 2308.038775;
    const consumed = 3090 * (9000 / 5150.841208);
    expect(op.startUsd!).toBeCloseTo(invested - consumed, 1);
  });
});
