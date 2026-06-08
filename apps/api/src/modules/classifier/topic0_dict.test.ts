import { describe, it, expect } from "vitest";

import {
  classifyByTopic0,
  detectDataDecodeFamily,
  TOPIC0_DICT,
  NOISE_TOPIC0,
} from "@cap-flow/ucb/topic0_dict";

// Выверенные topic0 (см. topic0-op-dictionary.md).
const T = {
  transfer: "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
  approval: "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925",
  erc4626Deposit: "0xdcbc1c05240f31ff3ad067ef1ee35ce4997762752e3a095284754544f4c709d7",
  mintCollision: "0x4c209b5fc8ad50758f13e2e1088ba56a560dff690a1c6fef26394f4c03821c4f",
  v3Increase: "0x3067048beee31b25b2f1681f88dac838c8bba36af25bfb2b7cf7473a5847e35f",
  v3Collect: "0x40d0efd1a53d60ecbf40971b9daf7dc90178c3aadc7aab1765632738fa8b8f01",
  v3PoolSwap: "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67",
  aaveV3Supply: "0x2b627736bca15cd5381dcf80b0bf11fd197d01a037c52b927a881a10fb73ba61",
  aaveV3Borrow: "0xb3d084820fb1a9decffb176436bd02558d15fac9b0ddfed8c465bc7359d7dce0",
  morphoSupply: "0xedf8870433c83823eb071d3df1caa8d008f12f6440918c20d75a3602cda30fe0",
  morphoBorrow: "0x570954540bed6b1304a87dfe815a5eda4a648f7097a16240dcd85c9b5fd42a43",
  univ4ModLiq: "0xf208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec",
  v3PoolBurn: "0x0c396cd989a39f4459b5fa1aed6a9a8dcdbc45908acfd67e028cd568da98982c",
  morphoWithdrawColl: "0xe80ebd7cc9223d7382aab2e0d1d6155c65651f83d53c8b9b06901d167e321142",
} as const;

const log = (topic0: string) => ({ topic0 });
// 32-байтовое слово (two's complement для отрицательных) + сборка data.
const word = (n: bigint) => ((n < 0n ? (1n << 256n) + n : n).toString(16)).padStart(64, "0");
const data = (...words: bigint[]) => "0x" + words.map(word).join("");
const logD = (topic0: string, ...words: bigint[]) => ({ topic0, data: data(...words) });

describe("classifyByTopic0 — базовые сигнатуры", () => {
  it("Aave V3 Supply → lend_supply", () => {
    expect(classifyByTopic0([log(T.aaveV3Supply)])?.opType).toBe("lend_supply");
  });
  it("Aave V3 Borrow → borrow", () => {
    expect(classifyByTopic0([log(T.aaveV3Borrow)])?.opType).toBe("borrow");
  });
  it("Morpho Supply/Borrow", () => {
    expect(classifyByTopic0([log(T.morphoSupply)])?.opType).toBe("lend_supply");
    expect(classifyByTopic0([log(T.morphoBorrow)])?.opType).toBe("borrow");
  });
  it("V3 IncreaseLiquidity → lp_add; Collect → claim_rewards", () => {
    expect(classifyByTopic0([log(T.v3Increase)])?.opType).toBe("lp_add");
    expect(classifyByTopic0([log(T.v3Collect)])?.opType).toBe("claim_rewards");
  });
  it("регистр topic0 не важен (lowercase нормализация)", () => {
    expect(classifyByTopic0([log(T.aaveV3Supply.toUpperCase())])?.opType).toBe("lend_supply");
  });
});

describe("classifyByTopic0 — коллизия Mint (0x4c209b5f)", () => {
  it("категория lp/dex → lp_add (UniV2)", () => {
    expect(classifyByTopic0([log(T.mintCollision)], { protocolCategory: "lp" })?.opType).toBe("lp_add");
    expect(classifyByTopic0([log(T.mintCollision)], { protocolCategory: "dex" })?.opType).toBe("lp_add");
  });
  it("категория lending/cdp → lend_supply (Compound v2 cToken)", () => {
    expect(classifyByTopic0([log(T.mintCollision)], { protocolCategory: "lending" })?.opType).toBe("lend_supply");
    expect(classifyByTopic0([log(T.mintCollision)], { protocolCategory: "cdp" })?.opType).toBe("lend_supply");
  });
  it("без категории → fallback opType (lp_add)", () => {
    expect(classifyByTopic0([log(T.mintCollision)])?.opType).toBe("lp_add");
  });
});

describe("classifyByTopic0 — шум и выбор главного события", () => {
  it("только Transfer/Approval → null (шум, не действие)", () => {
    expect(classifyByTopic0([log(T.transfer), log(T.approval)])).toBeNull();
    expect(NOISE_TOPIC0.has(T.transfer)).toBe(true);
  });
  it("Transfer + протокол-событие → берём событие (шум пропущен)", () => {
    expect(classifyByTopic0([log(T.transfer), log(T.aaveV3Supply)])?.opType).toBe("lend_supply");
  });
  it("ранг: Swap + IncreaseLiquidity (zap) → lp_add (position > swap)", () => {
    expect(classifyByTopic0([log(T.v3PoolSwap), log(T.v3Increase)])?.opType).toBe("lp_add");
  });
  it("неизвестный topic0 → null", () => {
    expect(classifyByTopic0([log("0xdeadbeef")])).toBeNull();
  });
  it("ERC4626 Deposit → lend_supply (vault), lp при категории lp", () => {
    expect(classifyByTopic0([log(T.erc4626Deposit)])?.opType).toBe("lend_supply");
    expect(classifyByTopic0([log(T.erc4626Deposit)], { protocolCategory: "lp" })?.opType).toBe("lp_add");
  });
});

describe("DATA-decode: V4 ModifyLiquidity (знак int256)", () => {
  // data words: [tickLower, tickUpper, liquidityDelta, salt]; delta = word2.
  it("liquidityDelta > 0 → lp_add", () => {
    expect(classifyByTopic0([logD(T.univ4ModLiq, 0n, 0n, 1000n, 0n)])?.opType).toBe("lp_add");
  });
  it("liquidityDelta < 0 → lp_remove", () => {
    expect(classifyByTopic0([logD(T.univ4ModLiq, 0n, 0n, -1000n, 0n)])?.opType).toBe("lp_remove");
  });
  it("без data → не гадаем (null/skip)", () => {
    expect(classifyByTopic0([log(T.univ4ModLiq)])).toBeNull();
  });
  it("zap: V4 Swap + ModifyLiquidity(add) → lp_add (position > swap)", () => {
    expect(
      classifyByTopic0([log(T.v3PoolSwap), logD(T.univ4ModLiq, 0n, 0n, 5n, 0n)])?.opType,
    ).toBe("lp_add");
  });
});

describe("DATA-decode: V3 pool Burn (amount=0 → fee-collect)", () => {
  // data words: [amount(uint128), amount0, amount1]; amount = word0.
  it("amount=0 (decreaseLiquidity(0) для fee) → claim_rewards", () => {
    expect(classifyByTopic0([logD(T.v3PoolBurn, 0n, 100n, 200n)])?.opType).toBe("claim_rewards");
  });
  it("amount>0 (реальное уменьшение) → lp_remove", () => {
    expect(classifyByTopic0([logD(T.v3PoolBurn, 5000n, 100n, 200n)])?.opType).toBe("lp_remove");
  });
  it("без data → lp_remove (как раньше)", () => {
    expect(classifyByTopic0([log(T.v3PoolBurn)])?.opType).toBe("lp_remove");
  });
});

describe("context-aware подавление свопа (аггрегатор-запы)", () => {
  it("swap на position-протоколе (yield) → null (внутренний своп, не доверяем)", () => {
    expect(classifyByTopic0([log(T.v3PoolSwap)], { protocolCategory: "yield" })).toBeNull();
  });
  it("swap на lending → null", () => {
    expect(classifyByTopic0([log(T.v3PoolSwap)], { protocolCategory: "lending" })).toBeNull();
  });
  it("swap на dex → swap (genuine, сохраняем)", () => {
    expect(classifyByTopic0([log(T.v3PoolSwap)], { protocolCategory: "dex" })?.opType).toBe("swap");
  });
  it("swap без категории → swap (сохраняем)", () => {
    expect(classifyByTopic0([log(T.v3PoolSwap)])?.opType).toBe("swap");
  });
  it("position-событие + swap на yield → lp_add (position выигрывает, не подавляется)", () => {
    expect(
      classifyByTopic0([log(T.v3PoolSwap), log(T.v3Increase)], { protocolCategory: "yield" })?.opType,
    ).toBe("lp_add");
  });
});

describe("multi-action guard (≥2 разных position-события)", () => {
  it("borrow + withdrawCollateral в одной tx → null (не гадаем, log_index=0)", () => {
    expect(classifyByTopic0([log(T.morphoBorrow), log(T.morphoWithdrawColl)])).toBeNull();
  });
  it("supply + borrow (leverage open) → null", () => {
    expect(classifyByTopic0([log(T.morphoSupply), log(T.morphoBorrow)])).toBeNull();
  });
  it("одиночное position-событие + Transfer-шум → классифицируем (НЕ multi-action)", () => {
    expect(classifyByTopic0([log(T.morphoWithdrawColl), log(T.transfer)])?.opType).toBe("lend_withdraw");
  });
  it("один тип дважды (supply+supply) → не multi-action (1 distinct)", () => {
    expect(classifyByTopic0([log(T.morphoSupply), log(T.aaveV3Supply)])?.opType).toBe("lend_supply");
  });
  it("position + swap → не multi-action (swap rank<3)", () => {
    expect(classifyByTopic0([log(T.v3Increase), log(T.v3PoolSwap)])?.opType).toBe("lp_add");
  });
});

describe("detectDataDecodeFamily", () => {
  it("обычное событие → не data-decode (null)", () => {
    expect(detectDataDecodeFamily([log(T.aaveV3Supply)])).toBeNull();
  });
});

describe("словарь — целостность", () => {
  it("все ключи lowercase 0x + 66 символов", () => {
    for (const k of TOPIC0_DICT.keys()) {
      expect(k).toMatch(/^0x[0-9a-f]{64}$/);
    }
  });
});
