/**
 * Chain classifier orchestrator (P5.7).
 *
 * Glue between the pure classifier modules (P5.1-P5.6) and the rest of
 * the system. Responsibilities:
 *
 *   1. Resolve the `chain_classifier.enabled` feature flag for the
 *      account. If OFF → short-circuit, no fetcher calls, no work.
 *   2. For each EVM address: pull DeBank history (via `EvmHistoryFetcher`),
 *      classify via `classifyHistory`, count types.
 *   3. For each Solana address: pull Helius history (via
 *      `SolanaHistoryFetcher`), classify via `classifyHeliusHistory`.
 *   4. Across the combined ops, run `computeLpCloseAttribution`.
 *   5. Fail-soft: any fetcher exception is captured into `errors[]`;
 *      classification continues for other addresses.
 *
 * The two `*HistoryFetcher` ports are injected (DI) so that:
 *   - real DeBank/Helius adapters can land later (P5.8+) without
 *     reshaping this service
 *   - tests can use trivial mocks
 *   - `null` fetcher = capability absent (skips that chain)
 */

import { classifyHeliusHistory } from "./solana_classifier.js";
import { classifyHistory } from "./classifier.js";
import { computeLpCloseAttribution } from "./lp_attribution.js";
import type {
  DeBankHistoryItem,
  DeBankProject,
  DeBankToken,
} from "./debank_types.js";
import type { HeliusTransaction } from "./helius_types.js";
import type { ClassifiedOp, OpType } from "./types.js";
import type { Topic0Log } from "@cap-flow/ucb/topic0_dict";

export interface EvmHistoryBundle {
  readonly history_list: DeBankHistoryItem[];
  readonly token_dict: Record<string, DeBankToken>;
  readonly project_dict: Record<string, DeBankProject>;
  readonly cex_dict: Record<string, { id: string; name: string }>;
}

export type EvmHistoryFetcher = (address: string) => Promise<EvmHistoryBundle>;

export type SolanaHistoryFetcher = (
  address: string
) => Promise<HeliusTransaction[]>;

/**
 * topic0 log-fetch port (этап 1.2). Берёт (chain, txHash) пары → возвращает
 * Map<txHash(lowercase), Topic0Log[]> из on-chain receipts. Инъектируется (DI):
 * реальный адаптер (viem + Alchemy) в worker.ts, в тестах — тривиальный мок,
 * `null` = capability отсутствует (топик0-обогащение пропускается, ноль регресса).
 */
export type EvmLogsFetcher = (
  items: ReadonlyArray<{ readonly chain: string; readonly txHash: string }>
) => Promise<ReadonlyMap<string, readonly Topic0Log[]>>;

/** op_type'ы, которым topic0 заведомо не нужен — не тратим RPC на receipts. */
const TOPIC0_TRIVIAL_OPS: ReadonlySet<string> = new Set([
  "noise",
  "approve",
  "transfer_in",
  "transfer_out",
  "failed",
  "gas_topup",
]);

export interface AnalyzeArgs {
  readonly accountId: string;
  readonly addresses: ReadonlyArray<{
    readonly address: string;
    readonly type: "evm" | "solana" | string;
  }>;
}

export interface ChainClassifierResult {
  readonly enabled: boolean;
  readonly classified: number;
  readonly byType: Partial<Record<OpType, number>>;
  readonly lpAttributions: number;
  readonly skippedSolana: number;
  readonly skippedEvm: number;
  readonly errors: string[];
  /**
   * UCB B5.5: classified ops grouped by address. Caller (portfolio-refresh
   * service) persists их в `chain_operations` через `ChainOpsRepository`.
   * Server-side classification теперь даёт background sync без зависимости
   * от client'а — Phase 1 push (B5.3) был интерактивный, это автономный.
   */
  readonly opsByAddress: ReadonlyMap<string, readonly ClassifiedOp[]>;
}

interface FlagResolver {
  enabled(
    key: string,
    ctx: { accountId?: string | null }
  ): Promise<boolean>;
}

const FLAG_KEY = "chain_classifier.enabled";
/** Этап 1.2: topic0 log-fetch обогащение. Отдельный рубильник, default OFF. */
const TOPIC0_FLAG_KEY = "chain_classifier.topic0.enabled";

export class ChainClassifierService {
  constructor(
    private readonly flags: FlagResolver,
    private readonly evmHistory: EvmHistoryFetcher | null,
    private readonly solHistory: SolanaHistoryFetcher | null,
    /** topic0 log-fetch адаптер (этап 1.2); null = обогащение выключено. */
    private readonly evmLogs: EvmLogsFetcher | null = null
  ) {}

  async analyzeAccount(
    args: AnalyzeArgs
  ): Promise<ChainClassifierResult> {
    const enabled = await this.flags.enabled(FLAG_KEY, {
      accountId: args.accountId,
    });
    if (!enabled) {
      return {
        enabled: false,
        classified: 0,
        byType: {},
        lpAttributions: 0,
        skippedSolana: 0,
        skippedEvm: 0,
        errors: [],
        opsByAddress: new Map(),
      };
    }

    const allOps: ClassifiedOp[] = [];
    const opsByAddress = new Map<string, ClassifiedOp[]>();
    const errors: string[] = [];
    let skippedEvm = 0;
    let skippedSolana = 0;

    // EVM addresses.
    const evmAddrs = args.addresses.filter((a) => a.type === "evm");
    // Этап 1.2: topic0 log-fetch обогащение — отдельный рубильник + наличие
    // адаптера. Резолвим один раз. Когда OFF / нет адаптера → classifyHistory
    // без logs (топик0 — no-op, ноль регресса).
    const topic0Enabled =
      this.evmLogs != null &&
      (await this.flags.enabled(TOPIC0_FLAG_KEY, { accountId: args.accountId }));
    for (const a of evmAddrs) {
      if (!this.evmHistory) {
        skippedEvm++;
        continue;
      }
      try {
        const bundle = await this.evmHistory(a.address);
        const ownAddresses = new Set(
          evmAddrs.map((x) => x.address.toLowerCase())
        );
        const ctxBase = {
          ownAddresses,
          selfAddress: a.address.toLowerCase(),
          tokens: bundle.token_dict,
          projects: bundle.project_dict,
          cex: bundle.cex_dict,
        };

        // 2-pass topic0: (1) дешёвая классификация → нетривиальные ops; (2) фетч
        // receipts ТОЛЬКО для них (бюджет RPC = scope shadow-скрипта); (3) финал
        // с logsByTxHash. Фетч fail-soft: ошибка → классификация без логов.
        let logsByTxHash:
          | ReadonlyMap<string, readonly Topic0Log[]>
          | undefined;
        if (topic0Enabled && this.evmLogs) {
          const pre = classifyHistory(bundle.history_list, ctxBase);
          const wanted = new Map<string, string>(); // txHash(lc) → chain
          for (const op of pre) {
            if (TOPIC0_TRIVIAL_OPS.has(op.type)) continue;
            if (op.hash) wanted.set(op.hash.toLowerCase(), op.chain);
          }
          if (wanted.size > 0) {
            try {
              logsByTxHash = await this.evmLogs(
                [...wanted].map(([txHash, chain]) => ({ chain, txHash }))
              );
            } catch (err) {
              errors.push(
                `topic0 log-fetch: ${
                  err instanceof Error ? err.message.slice(0, 160) : String(err)
                }`
              );
            }
          }
        }

        const classified = classifyHistory(bundle.history_list, {
          ...ctxBase,
          ...(logsByTxHash && { logsByTxHash }),
        });
        for (const op of classified) allOps.push(op);
        opsByAddress.set(a.address.toLowerCase(), classified);
      } catch (err) {
        errors.push(
          err instanceof Error ? err.message.slice(0, 200) : String(err)
        );
      }
    }

    // Solana addresses.
    const solAddrs = args.addresses.filter((a) => a.type === "solana");
    for (const a of solAddrs) {
      if (!this.solHistory) {
        skippedSolana++;
        continue;
      }
      try {
        const txs = await this.solHistory(a.address);
        const ownAddresses = new Set(solAddrs.map((x) => x.address));
        const classified = classifyHeliusHistory(txs, {
          selfAddress: a.address,
          ownAddresses,
        });
        for (const op of classified) allOps.push(op);
        opsByAddress.set(a.address, classified);
      } catch (err) {
        errors.push(
          err instanceof Error ? err.message.slice(0, 200) : String(err)
        );
      }
    }

    const byType: Partial<Record<OpType, number>> = {};
    for (const op of allOps) {
      byType[op.type] = (byType[op.type] ?? 0) + 1;
    }

    const attributions = computeLpCloseAttribution(allOps);

    return {
      enabled: true,
      classified: allOps.length,
      byType,
      lpAttributions: attributions.size,
      skippedSolana,
      skippedEvm,
      errors,
      opsByAddress,
    };
  }
}
