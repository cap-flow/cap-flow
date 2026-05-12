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
}

interface FlagResolver {
  enabled(
    key: string,
    ctx: { accountId?: string | null }
  ): Promise<boolean>;
}

const FLAG_KEY = "chain_classifier.enabled";

export class ChainClassifierService {
  constructor(
    private readonly flags: FlagResolver,
    private readonly evmHistory: EvmHistoryFetcher | null,
    private readonly solHistory: SolanaHistoryFetcher | null
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
      };
    }

    const allOps: ClassifiedOp[] = [];
    const errors: string[] = [];
    let skippedEvm = 0;
    let skippedSolana = 0;

    // EVM addresses.
    const evmAddrs = args.addresses.filter((a) => a.type === "evm");
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
        const classified = classifyHistory(bundle.history_list, {
          ownAddresses,
          selfAddress: a.address.toLowerCase(),
          tokens: bundle.token_dict,
          projects: bundle.project_dict,
          cex: bundle.cex_dict,
        });
        for (const op of classified) allOps.push(op);
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
    };
  }
}
