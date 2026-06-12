/**
 * B3 — server source for the Krystal V3 override inputs.
 *
 * forAccount(accountId) →
 *   - krystalV3ByTokenId: Map<tokenId, KrystalV3Summary>  (positions per wallet)
 *   - krystalTxByTokenId: Map<tokenId, KrystalTransactionsSummary>  (per-NFT /transactions)
 *
 * The per-NFT transactions fetch is MANDATORY, not optional: applyKrystalV3Override's
 * V4 trust gate disables `totalDepositValue` and trusts ONLY Σ DEPOSIT from
 * /transactions. Fail-soft everywhere — a Krystal outage / per-wallet error leaves
 * empty maps and the override becomes a guarded no-op (positions keep UCB values).
 */
import {
  buildKrystalSummaryMap,
  krystalTransactionsToSummary,
  type KrystalV3Summary,
  type KrystalTransactionsSummary,
} from "@cap-flow/ucb/krystal/adapter";
import type { KrystalPosition } from "@cap-flow/ucb/krystal/types";

import type { KrystalClient } from "../integrations/krystal.js";

/** Account → its EVM addresses (structurally satisfied by WalletAddressSource). */
export interface EvmAddressSource {
  evmWalletsForAccount(
    accountId: string,
  ): Promise<readonly { address: string }[]>;
}

export interface KrystalV3Result {
  krystalV3ByTokenId: Map<string, KrystalV3Summary>;
  krystalTxByTokenId: Map<string, KrystalTransactionsSummary>;
  /**
   * `${owner}|${chainCode}|${poolAddress}` (lowercased) для каждого CLOSED
   * NFT юзера — вход dust-фильтра (`filterClosedDustPositions`). Зеркало
   * web `useKrystalV3ClosedPools`. Пустой при отсутствии кредитов/ключа.
   */
  closedPoolKeys: Set<string>;
}

/** `{NPM}-{tokenId}` → NPM address (the part before the last `-`). */
function npmFromId(id: string): string | null {
  const i = id.lastIndexOf("-");
  return i > 0 ? id.slice(0, i) : null;
}

/**
 * Сети для CLOSED-обхода (зеркало web SUPPORTED_CHAINS_FOR_CLOSED): Krystal
 * без явного chainIds отдаёт только самую активную сеть → итерируем per chain.
 */
const CLOSED_CHAINS: { chainId: number; code: string }[] = [
  { chainId: 1, code: "eth" },
  { chainId: 42161, code: "arb" },
  { chainId: 8453, code: "base" },
  { chainId: 10, code: "op" },
  { chainId: 137, code: "matic" },
  { chainId: 56, code: "bsc" },
  { chainId: 43114, code: "avax" },
];

export class KrystalV3Source {
  constructor(
    private readonly deps: {
      client: Pick<
        KrystalClient,
        "openUniswapV3Positions" | "positionTransactions" | "closedUniswapV3Positions"
      >;
      walletSource: EvmAddressSource;
    },
  ) {}

  async forAccount(accountId: string): Promise<KrystalV3Result> {
    const wallets = await this.deps.walletSource.evmWalletsForAccount(accountId);
    const addresses = [
      ...new Set(wallets.map((w) => w.address.toLowerCase())),
    ];

    const all: KrystalPosition[] = [];
    for (const addr of addresses) {
      try {
        all.push(...(await this.deps.client.openUniswapV3Positions(addr)));
      } catch {
        /* fail-soft per wallet */
      }
    }

    const krystalV3ByTokenId = buildKrystalSummaryMap(all);

    const krystalTxByTokenId = new Map<string, KrystalTransactionsSummary>();
    for (const p of all) {
      if (!p.tokenId) continue;
      const npm = npmFromId(p.id);
      if (!npm) continue;
      try {
        const txs = await this.deps.client.positionTransactions(
          p.chain.id,
          npm,
          p.tokenId,
        );
        krystalTxByTokenId.set(p.tokenId, krystalTransactionsToSummary(txs));
      } catch {
        /* fail-soft per NFT */
      }
    }

    // CLOSED NFTs → ключи dust-фильтра (fail-soft per wallet×chain). Зеркало
    // web useKrystalV3ClosedPools: ОБЯЗАТЕЛЬНО per-chain (см. CLOSED_CHAINS).
    const closedPoolKeys = new Set<string>();
    const chainCodeById = new Map(CLOSED_CHAINS.map((c) => [c.chainId, c.code]));
    for (const addr of addresses) {
      for (const { chainId } of CLOSED_CHAINS) {
        try {
          const closed = await this.deps.client.closedUniswapV3Positions(
            addr,
            chainId,
          );
          for (const p of closed) {
            const code = chainCodeById.get(p.chain?.id ?? -1);
            const pool = p.pool?.poolAddress;
            if (!code || !pool || !p.tokenId) continue;
            closedPoolKeys.add(`${addr}|${code}|${pool.toLowerCase()}`);
          }
        } catch {
          /* fail-soft per wallet×chain */
        }
      }
    }

    return { krystalV3ByTokenId, krystalTxByTokenId, closedPoolKeys };
  }
}
