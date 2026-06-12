/**
 * Аудит melody789789 (2026-06-11), F1: lending startUsd занижен на −27%/−12%.
 *
 * Корень: `computePositions` строил LotTracker (этап ledger) ДО загрузки
 * histPrices и не передавал их в `runUcbPipelineForWallet`. Волатильный
 * `transfer_in` в `handleTransferIn` падал на fallback `m.usd` — а это
 * DeBank-цена НА МОМЕНТ СИНКА (для свеже-синкнутого кошелька = сегодняшний
 * спот). Aave arb: переводы ETH от 24.01 (реально $2 957.74/ETH, цена ЕСТЬ
 * в op_token_prices) ложились в лоты по $1 660 → startUsd 2 736.74 вместо
 * ~3 766 и «плыл» вместе с рынком между прогонами.
 *
 * Методика (locked 2026-06-10): transfer_in волатильного = свежий капитал
 * по РЫНКУ НА МОМЕНТ ПОЛУЧЕНИЯ (hist-цена), не по споту синка.
 *
 * ⚠ Зеркальный клиентский вызов (LoadedWalletsProvider.newTrackers) histPrices
 * тоже НЕ передаёт — «server == client, но оба неверны» (класс Alice). Фикс
 * клиента — отдельным шагом по тому же образцу.
 */
import { describe, expect, it } from "vitest";

import { bucketTs } from "@cap-flow/ucb/pricing";

import {
  computePositions,
  type OpPriceSource,
  type UcbComputeWallet,
} from "./ucb.service.js";

const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const RECEIVED_AT = 1_700_000_000; // transfer_in момент: рынок $2957.74
const SUPPLIED_AT = 1_700_001_000;
const HIST_PRICE = 2957.74; // реальная цена на момент получения (в кэше B1)
const SYNC_SPOT = 1660; // m.usd = спот на момент синка (НЕ исторический)

function op(partial: Record<string, unknown>): Record<string, unknown> {
  return {
    seq: 0,
    chain: "eth",
    status: "ok",
    protocol: null,
    netUsd: 0,
    gasUsd: 0,
    counterparty: null,
    feePayer: "0x1111111111111111111111111111111111111111",
    fnName: null,
    approveSpender: null,
    approveSymbol: null,
    ...partial,
  };
}

const wallets = [
  {
    wallet: {
      id: "w1",
      name: "F1 Test Wallet",
      address: "0x1111111111111111111111111111111111111111",
      chain: "evm",
      createdAt: 1_690_000_000,
    },
    ops: [
      op({
        seq: 0,
        hash: "0xtransfer",
        time: RECEIVED_AT,
        type: "transfer_in",
        movement: [
          {
            direction: "in",
            symbol: "WETH",
            tokenId: WETH,
            amount: 1,
            usd: SYNC_SPOT, // DeBank проставил сегодняшний спот всей истории
            isStable: false,
            isProtocolToken: false,
          },
        ],
      }),
      op({
        seq: 1,
        hash: "0xsupply",
        time: SUPPLIED_AT,
        type: "lend_supply",
        protocol: { id: "eth_aave3", name: "Aave V3", category: "lending" },
        movement: [
          {
            direction: "out",
            symbol: "WETH",
            tokenId: WETH,
            amount: 1,
            usd: SYNC_SPOT,
            isStable: false,
            isProtocolToken: false,
          },
        ],
      }),
    ],
    live: {
      totalUsd: SYNC_SPOT,
      tokens: [],
      positions: [
        {
          protocolId: "eth_aave3",
          protocolName: "Aave V3",
          chain: "eth",
          walletId: "w1",
          walletName: "F1 Test Wallet",
          category: "lending",
          itemName: "Lending",
          netUsd: SYNC_SPOT,
          assetUsd: SYNC_SPOT,
          debtUsd: 0,
          supply: [
            { symbol: "WETH", amount: 1, usd: SYNC_SPOT, tokenId: WETH },
          ],
          borrow: [],
          rewards: [],
        },
      ],
    },
  },
] as unknown as UcbComputeWallet[];

/** B1-кэш ЗНАЕТ историческую цену — как у melody (op_token_prices был полон). */
const pricing: OpPriceSource = {
  priceMapForOps: async () => ({
    histPrices: new Map([
      [`ethereum:${WETH}|${bucketTs(RECEIVED_AT)}`, HIST_PRICE],
      [`ethereum:${WETH}|${bucketTs(SUPPLIED_AT)}`, HIST_PRICE],
    ]),
    missing: [],
  }),
};

describe("F1: волатильный transfer_in ценится hist-ценой на момент получения", () => {
  it("lending startUsd = market-at-receipt ($2957.74), НЕ спот синка ($1660)", async () => {
    const positions = await computePositions(wallets, {
      opPricingService: pricing,
      lotMethodology: "LIFO",
    });
    const p = positions.find((x) => x.protocol.id === "eth_aave3");
    expect(p, "aave-позиция построена").toBeDefined();
    expect(Math.abs(p!.startUsd - HIST_PRICE)).toBeLessThanOrEqual(0.01);
  });
});
