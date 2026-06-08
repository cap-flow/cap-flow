/**
 * topic0 log-fetch адаптер (этап 1.2) — реальная реализация `EvmLogsFetcher`
 * через viem + Alchemy. Берёт (chain, txHash) пары, тянет on-chain receipts,
 * мапит logs → `Topic0Log[]` для `classifyByTopic0`.
 *
 * Bounded + fail-soft:
 *   - только сети, которые Alchemy поддерживает (иначе tx пропускается);
 *   - ограниченная concurrency (RPC budget);
 *   - ошибка на конкретном tx → этот tx без логов (классификатор падает на
 *     существующую лестницу для него; ноль регресса).
 *
 * Маппинг сетей выверен в `scripts/classifier-topic0-shadow.mts`.
 */
import { createPublicClient, http, type PublicClient } from "viem";
import {
  mainnet,
  optimism,
  bsc,
  polygon,
  base,
  arbitrum,
  avalanche,
  type Chain,
} from "viem/chains";
import type { Topic0Log } from "@cap-flow/ucb/topic0_dict";
import type { EvmLogsFetcher } from "./chain_classifier.service.js";

/** DeBank chain string → {viem chain, Alchemy host}. */
const CHAINS: Record<string, { chain: Chain; host: string }> = {
  eth: { chain: mainnet, host: "eth-mainnet.g.alchemy.com" },
  op: { chain: optimism, host: "opt-mainnet.g.alchemy.com" },
  bsc: { chain: bsc, host: "bnb-mainnet.g.alchemy.com" },
  matic: { chain: polygon, host: "polygon-mainnet.g.alchemy.com" },
  base: { chain: base, host: "base-mainnet.g.alchemy.com" },
  arb: { chain: arbitrum, host: "arb-mainnet.g.alchemy.com" },
  avax: { chain: avalanche, host: "avax-mainnet.g.alchemy.com" },
};

export interface AlchemyEvmLogsFetcherOpts {
  /** Параллельных receipt-запросов. Default 5 (как в shadow-скрипте). */
  readonly concurrency?: number;
}

export function makeAlchemyEvmLogsFetcher(
  alchemyApiKey: string,
  opts?: AlchemyEvmLogsFetcherOpts
): EvmLogsFetcher {
  const clients = new Map<string, PublicClient>();
  function clientFor(chain: string): PublicClient | null {
    const c = CHAINS[chain];
    if (!c) return null;
    let cl = clients.get(chain);
    if (!cl) {
      cl = createPublicClient({
        chain: c.chain,
        transport: http(`https://${c.host}/v2/${alchemyApiKey}`, {
          batch: true,
        }),
      });
      clients.set(chain, cl);
    }
    return cl;
  }

  const concurrency = Math.max(1, opts?.concurrency ?? 5);

  return async (items) => {
    const out = new Map<string, Topic0Log[]>();
    let idx = 0;
    async function worker(): Promise<void> {
      while (idx < items.length) {
        const it = items[idx++]!;
        const cl = clientFor(it.chain);
        if (!cl) continue; // unsupported chain → no logs (skip)
        try {
          const rcpt = await cl.getTransactionReceipt({
            hash: it.txHash as `0x${string}`,
          });
          out.set(
            it.txHash.toLowerCase(),
            rcpt.logs
              .filter((l) => l.topics[0])
              .map((l) => ({
                address: l.address.toLowerCase(),
                topic0: l.topics[0]!.toLowerCase(),
                data: l.data,
              }))
          );
        } catch {
          // fail-soft per tx — без логов для этого hash.
        }
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(concurrency, items.length) }, worker)
    );
    return out;
  };
}
